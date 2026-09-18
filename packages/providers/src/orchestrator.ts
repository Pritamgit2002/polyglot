import {
  ProviderError,
  computeCostUsd,
  fitToContextWindow,
  getModel,
  isProviderError,
  loadConfig,
  withRetry,
  type CompletionRequest,
  type FinishReason,
  type StreamEvent,
  type Usage,
} from '@polyglot/core';
import { buildContext, getProvider } from './registry.js';

/**
 * Everything between "the app wants an answer" and "an adapter makes an HTTP
 * call": retries, the fallback chain, per-request timeouts, context fitting,
 * and the metrics record. Adapters stay dumb on purpose — they translate
 * shapes and nothing else.
 */

export interface RequestMetrics {
  modelId: string;
  provider: string;
  /** Null until the first token actually lands. This is the number that tells
   *  you whether a provider is slow or just far away. */
  ttftMs: number | null;
  totalMs: number;
  usage: Usage;
  costUsd: number;
  finishReason: FinishReason;
  retryCount: number;
  /** The originally requested model, when the fallback chain changed it. */
  fallbackFrom: string | null;
  droppedMessages: number;
  errorKind?: string;
}

export type OrchestratedEvent =
  | StreamEvent
  | { type: 'provider_switch'; from: string; to: string; reason: string }
  | { type: 'context_truncated'; droppedCount: number }
  | { type: 'metrics'; metrics: RequestMetrics };

export interface StreamOptions {
  request: CompletionRequest;
  /** Models tried in order. Defaults to [request.model, ...configured chain]. */
  fallbackChain?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxCostUsd?: number;
}

export async function* streamCompletion(opts: StreamOptions): AsyncGenerator<OrchestratedEvent> {
  const cfg = loadConfig();
  const chain = dedupe([opts.request.model, ...(opts.fallbackChain ?? cfg.defaults.fallbackChain)]);
  const startedAt = Date.now();

  let lastError: ProviderError | null = null;

  for (let i = 0; i < chain.length; i++) {
    const modelId = chain[i]!;
    const model = getModel(modelId);

    if (i > 0) {
      yield {
        type: 'provider_switch',
        from: chain[i - 1]!,
        to: modelId,
        reason: lastError?.kind ?? 'unknown',
      };
    }

    // Refit per model: the fallback target may have a smaller window than the
    // primary, so a transcript that fit before might not fit now.
    const fitted = fitToContextWindow(opts.request.messages, model, {
      system: opts.request.system,
      reserveOutputTokens: opts.request.maxTokens,
    });
    if (fitted.droppedCount > 0) {
      yield { type: 'context_truncated', droppedCount: fitted.droppedCount };
    }

    if (opts.request.tools?.length && !model.capabilities.tools) {
      // Degrade loudly, not silently — Module D asks for exactly this.
      yield {
        type: 'error',
        error: {
          kind: 'bad_request',
          provider: model.provider,
          message: `${model.displayName} does not support tool calling; tools were not sent.`,
          retryable: false,
        },
      };
    }

    let ttftMs: number | null = null;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: FinishReason = 'stop';
    let retryCount = 0;
    let emittedContent = false;

    try {
      const provider = await getProvider(model.provider);
      const ctx = buildContext(modelId, { timeoutMs: opts.timeoutMs, env: opts.env });

      const { value: iterator, attempts } = await withRetry(
        async () => {
          const it = provider.stream(
            {
              ...opts.request,
              model: modelId,
              messages: fitted.messages,
              ...(model.capabilities.tools ? {} : { tools: undefined }),
              maxTokens: Math.min(opts.request.maxTokens ?? model.maxOutputTokens, model.maxOutputTokens),
            },
            ctx,
          )[Symbol.asyncIterator]();

          // Pull the first event inside the retry envelope so that connection
          // failures and immediate 429s are retried, while a mid-stream failure
          // (which we cannot safely replay) is not.
          const first = await it.next();
          return { it, first };
        },
        cfg.defaults.retry,
        {
          signal: opts.request.signal,
          onRetry: () => {
            retryCount += 1;
          },
        },
      );
      retryCount = attempts - 1;

      const pump = async function* (): AsyncGenerator<StreamEvent> {
        if (!iterator.first.done && iterator.first.value) yield iterator.first.value;
        while (true) {
          const next = await iterator.it.next();
          if (next.done) break;
          yield next.value;
        }
      };

      for await (const event of pump()) {
        if (event.type === 'text_delta' || event.type === 'tool_use_start') {
          if (ttftMs === null) ttftMs = Date.now() - startedAt;
          emittedContent = true;
        }
        if (event.type === 'usage') usage = event.usage;
        if (event.type === 'done') finishReason = event.finishReason;

        // Cost ceiling: stop paying for a runaway generation mid-flight.
        if (opts.maxCostUsd !== undefined && computeCostUsd(usage, model.pricing) > opts.maxCostUsd) {
          throw new ProviderError({
            kind: 'bad_request',
            provider: model.provider,
            message: `Request exceeded the per-request cost ceiling of $${opts.maxCostUsd}.`,
          });
        }

        yield event;
      }

      yield {
        type: 'metrics',
        metrics: {
          modelId,
          provider: model.provider,
          ttftMs,
          totalMs: Date.now() - startedAt,
          usage,
          costUsd: computeCostUsd(usage, model.pricing),
          finishReason,
          retryCount,
          fallbackFrom: i > 0 ? chain[0]! : null,
          droppedMessages: fitted.droppedCount,
        },
      };
      return;
    } catch (e) {
      const err = isProviderError(e)
        ? e
        : new ProviderError({ kind: 'server_error', provider: model.provider, message: String(e), raw: e });
      lastError = err;

      // A user-initiated cancel is not a failure to fall back from.
      if (err.kind === 'cancelled') {
        yield { type: 'error', error: err.toClient() };
        return;
      }

      // Never fall back once tokens are on the wire. Splicing a second model's
      // output onto a half-finished sentence produces incoherent transcripts,
      // and the user has no way to tell it happened.
      if (emittedContent) {
        yield { type: 'error', error: err.toClient() };
        yield {
          type: 'metrics',
          metrics: {
            modelId,
            provider: model.provider,
            ttftMs,
            totalMs: Date.now() - startedAt,
            usage,
            costUsd: computeCostUsd(usage, model.pricing),
            finishReason: 'error',
            retryCount,
            fallbackFrom: i > 0 ? chain[0]! : null,
            droppedMessages: fitted.droppedCount,
            errorKind: err.kind,
          },
        };
        return;
      }

      // Config errors are not transient; trying the next model will not help
      // if the request itself is malformed.
      if (err.kind === 'bad_request' || err.kind === 'context_length') {
        if (i === chain.length - 1) break;
      }
    }
  }

  const err =
    lastError ?? new ProviderError({ kind: 'server_error', provider: 'polyglot', message: 'All providers failed.' });
  yield { type: 'error', error: err.toClient() };
  yield {
    type: 'metrics',
    metrics: {
      modelId: opts.request.model,
      provider: 'polyglot',
      ttftMs: null,
      totalMs: Date.now() - startedAt,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      finishReason: 'error',
      retryCount: 0,
      fallbackFrom: null,
      droppedMessages: 0,
      errorKind: err.kind,
    },
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
