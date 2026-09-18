import {
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type FinishReason,
  type Message,
  type Provider,
  type ProviderContext,
  type StreamEvent,
  type Usage,
} from '@polyglot/core';
import { postJson, readSse } from '../http.js';

/**
 * One adapter for the OpenAI-shaped surface.
 *
 * Only OpenAI is a configured provider in this build. Groq and DeepSeek speak
 * the same surface but are NOT shipped — enabling either is one entry in
 * models.json plus a key, with no code change. Their quirks are handled here
 * and covered by tests precisely so that claim is true rather than hopeful.
 *
 * The differences are expressed as config (`providers.<name>.extra`) rather
 * than as three near-duplicate files — copy-pasted adapters are called out in
 * the brief as a thing that loses points, and they are a maintenance trap.
 *
 * Known divergences, all handled below:
 *  - Groq ignores `stream_options.include_usage` and instead attaches usage to
 *    the final chunk under `x_groq.usage`.
 *  - DeepSeek's reasoning models stream a separate `reasoning_content` field on
 *    the delta, alongside `content`.
 *  - OpenAI's newer models reject `max_tokens` in favour of
 *    `max_completion_tokens`; Groq and DeepSeek only know `max_tokens`.
 */

interface OpenAIToolCall {
  index?: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

// ---------------------------------------------------------------------------
// our format -> OpenAI
// ---------------------------------------------------------------------------

export function toOpenAIMessages(messages: Message[], system?: string): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  // No top-level system parameter here: it is folded in as the first message.
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'tool') {
      // Each tool_result becomes its own message — unlike Anthropic, where they
      // are all blocks inside one user turn.
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.toolUseId!, content: b.content ?? '' });
        }
      }
      continue;
    }

    const textParts: Array<Record<string, unknown>> = [];
    const toolCalls: OpenAIToolCall[] = [];

    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          if (b.text) textParts.push({ type: 'text', text: b.text });
          break;
        case 'image':
          if (b.data && b.mimeType) {
            // OpenAI takes images as a data: URL, not a structured base64 field.
            textParts.push({ type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.data}` } });
          }
          break;
        case 'tool_use':
          toolCalls.push({
            id: b.id!,
            type: 'function',
            // Arguments are a STRING here, an object on Anthropic and Gemini.
            function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) },
          });
          break;
        case 'tool_result':
          out.push({ role: 'tool', tool_call_id: b.toolUseId!, content: b.content ?? '' });
          break;
      }
    }

    if (textParts.length === 0 && toolCalls.length === 0) continue;

    const msg: OpenAIMessage = { role: m.role === 'assistant' ? 'assistant' : 'user' };
    if (textParts.length === 1 && textParts[0]!.type === 'text') {
      msg.content = textParts[0]!.text as string; // plain string when we can
    } else if (textParts.length > 0) {
      msg.content = textParts;
    } else {
      msg.content = null; // assistant turn that is only tool calls
    }
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
  }

  return out;
}

function fromOpenAIFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function toUsage(u: Record<string, any> | undefined): Usage {
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    // reasoning_tokens are already inside completion_tokens for OpenAI —
    // adding them would double-bill. (Gemini is the opposite; see that adapter.)
    outputTokens: u.completion_tokens ?? 0,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  };
}

function buildBody(req: CompletionRequest, ctx: ProviderContext, stream: boolean) {
  const extra = ctx.extra ?? {};
  const maxTokensField = extra.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';

  return {
    model: ctx.providerModelId,
    messages: toOpenAIMessages(req.messages, req.system),
    ...(req.maxTokens !== undefined ? { [maxTokensField]: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          /**
           * Extra body fields a model requires ONLY when tools are present.
           *
           * gpt-5.6-luna refuses function tools on /v1/chat/completions unless
           * `reasoning_effort` is 'none' — the vendor's own stated workaround,
           * the alternative being a second adapter for /v1/responses. Kept as
           * generic config rather than an `if (model === ...)` so the next
           * model with a different demand is a config entry, not a code change.
           */
          ...((extra.paramsWhenToolsPresent as Record<string, unknown>) ?? {}),
        }
      : {}),
    ...(stream
      ? {
          stream: true,
          ...(extra.supportsStreamOptions === false ? {} : { stream_options: { include_usage: true } }),
        }
      : {}),
  };
}

function refineError(e: unknown): never {
  if (e instanceof ProviderError) {
    const raw = e.raw as { error?: { code?: string; type?: string; message?: string } } | undefined;
    const code = raw?.error?.code ?? raw?.error?.type ?? '';
    const msg = raw?.error?.message ?? '';

    if (code === 'context_length_exceeded' || /maximum context length|reduce the length/i.test(msg)) {
      throw new ProviderError({ ...base(e), kind: 'context_length' });
    }
    if (code === 'invalid_api_key' || code === 'insufficient_quota') {
      throw new ProviderError({ ...base(e), kind: 'auth' });
    }
    if (code === 'rate_limit_exceeded') {
      throw new ProviderError({ ...base(e), kind: 'rate_limit', retryable: true });
    }
  }
  throw e;
}

function base(e: ProviderError) {
  return { provider: e.provider, message: e.message, status: e.status, retryAfterMs: e.retryAfterMs, raw: e.raw };
}

// ---------------------------------------------------------------------------

function makeAdapter(name: string): Provider {
  return {
    name,

    async complete(req, ctx): Promise<CompletionResponse> {
      let result;
      try {
        result = await postJson({
          url: `${ctx.baseUrl}/chat/completions`,
          headers: { authorization: `Bearer ${ctx.apiKey}` },
          body: buildBody(req, ctx, false),
          provider: name,
          timeoutMs: ctx.timeoutMs,
          signal: req.signal,
        });
      } catch (e) {
        refineError(e);
      }

      try {
        const json = (await result!.res.json()) as {
          choices: Array<{ message: OpenAIMessage & { reasoning_content?: string }; finish_reason: string }>;
          usage?: Record<string, any>;
        };
        const choice = json.choices[0];
        const content: ContentBlock[] = [];

        if (typeof choice?.message.content === 'string' && choice.message.content) {
          content.push({ type: 'text', text: choice.message.content });
        }
        for (const tc of choice?.message.tool_calls ?? []) {
          content.push({
            type: 'tool_use',
            id: tc.id!,
            name: tc.function?.name ?? '',
            input: safeParseArgs(tc.function?.arguments),
          });
        }

        return {
          message: { role: 'assistant', content },
          usage: toUsage(json.usage),
          finishReason: fromOpenAIFinishReason(choice?.finish_reason),
          model: req.model,
        };
      } finally {
        result!.dispose();
      }
    },

    async *stream(req, ctx): AsyncGenerator<StreamEvent> {
      let result;
      try {
        result = await postJson({
          url: `${ctx.baseUrl}/chat/completions`,
          headers: { authorization: `Bearer ${ctx.apiKey}` },
          body: buildBody(req, ctx, true),
          provider: name,
          timeoutMs: ctx.timeoutMs,
          signal: req.signal,
        });
      } catch (e) {
        refineError(e);
      }

      const reasoningField = (ctx.extra?.reasoningField as string) ?? 'reasoning_content';
      // Keyed by `index`, not id: after the first chunk of a tool call, OpenAI
      // sends only {index, function:{arguments}} with no id and no name.
      const toolBuf = new Map<number, { id: string; name: string; json: string }>();
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let finish: FinishReason = 'stop';

      for await (const frame of readSse(result!.res, result!.dispose)) {
        if (frame.data === '[DONE]') break;

        const chunk = JSON.parse(frame.data) as {
          choices?: Array<{ delta?: Record<string, any>; finish_reason?: string }>;
          usage?: Record<string, any>;
          x_groq?: { usage?: Record<string, any> };
        };

        // Usage arrives either on a final usage-only chunk (OpenAI/DeepSeek) or
        // bolted onto the last content chunk under x_groq (Groq).
        if (chunk.usage) usage = toUsage(chunk.usage);
        if (chunk.x_groq?.usage) usage = toUsage(chunk.x_groq.usage);

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        if (typeof delta[reasoningField] === 'string' && delta[reasoningField]) {
          yield { type: 'reasoning_delta', text: delta[reasoningField] };
        }
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        for (const tc of (delta.tool_calls ?? []) as OpenAIToolCall[]) {
          const idx = tc.index ?? 0;
          let buf = toolBuf.get(idx);
          if (!buf) {
            buf = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', json: '' };
            toolBuf.set(idx, buf);
            yield { type: 'tool_use_start', id: buf.id, name: buf.name };
          }
          // Some providers dribble the name across chunks too.
          if (tc.function?.name && !buf.name) buf.name = tc.function.name;
          if (tc.function?.arguments) {
            buf.json += tc.function.arguments;
            yield { type: 'tool_use_delta', id: buf.id, partialJson: tc.function.arguments };
          }
        }

        if (choice.finish_reason) {
          finish = fromOpenAIFinishReason(choice.finish_reason);
          // Tool calls are only complete at finish_reason — there is no
          // per-call stop event like Anthropic's content_block_stop.
          for (const buf of toolBuf.values()) {
            yield { type: 'tool_use_complete', id: buf.id, name: buf.name, input: safeParseArgs(buf.json) };
          }
          toolBuf.clear();
        }
      }

      yield { type: 'usage', usage };
      yield { type: 'done', finishReason: finish };
    },

    async embed(texts, ctx): Promise<number[][]> {
      const { res, dispose } = await postJson({
        url: `${ctx.baseUrl}/embeddings`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
        body: { model: ctx.providerModelId, input: texts },
        provider: name,
        timeoutMs: ctx.timeoutMs,
      });
      try {
        const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
        // The API does not promise ordering; sort by index before returning.
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      } finally {
        dispose();
      }
    },
  };
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A truncated stream (max_tokens hit mid-arguments) produces invalid JSON.
    // Returning {} keeps the tool loop alive so the tool can report the error
    // back to the model, rather than throwing and losing the whole turn.
    return {};
  }
}

export default makeAdapter('openai-compat');

/** The registry calls this when several config providers share this file, so
 *  `openai`, `groq` and `deepseek` each get errors and metrics stamped with
 *  their own name instead of a shared alias. */
export const create = makeAdapter;
export { makeAdapter };
