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
 * Anthropic Messages API.
 *
 * The three things this adapter has to absorb, none of which the OpenAI-shaped
 * providers have:
 *  1. `system` is a top-level request parameter, not a message with role
 *     'system'. Sending it as a message is a 400.
 *  2. There is no 'tool' role. A tool result is a content block inside a USER
 *     message, and it must reference the tool_use id from the immediately
 *     preceding assistant turn.
 *  3. `max_tokens` is REQUIRED. Everyone else defaults it.
 */

const NAME = 'anthropic';

/**
 * Anthropic has no `response_format` / `responseSchema` equivalent. The
 * supported way to get schema-valid JSON is to declare a single tool whose
 * input_schema IS the desired schema and force the model to call it.
 *
 * The forced call is then unwrapped back into a TEXT block, so a caller sees
 * the same thing Gemini and OpenAI return — JSON as text — rather than having
 * to know that on this one provider structured output arrives as a tool call.
 */
const STRUCTURED_TOOL = 'emit_structured_output';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: { type: 'base64'; media_type: string; data: string };
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  thinking?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

// ---------------------------------------------------------------------------
// our format -> Anthropic
// ---------------------------------------------------------------------------

function toAnthropicBlock(b: ContentBlock): AnthropicBlock | null {
  switch (b.type) {
    case 'text':
      return b.text ? { type: 'text', text: b.text } : null;
    case 'image':
      if (!b.data || !b.mimeType) return null;
      return { type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } };
    case 'tool_use':
      return { type: 'tool_use', id: b.id!, name: b.name!, input: b.input ?? {} };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId!,
        content: b.content ?? '',
        ...(b.isError ? { is_error: true } : {}),
      };
    default:
      return null;
  }
}

export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    // Our 'tool' role collapses into Anthropic's 'user' role. Consecutive tool
    // results must also be merged into ONE user message — Anthropic rejects two
    // user turns in a row.
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = m.content.map(toAnthropicBlock).filter((b): b is AnthropicBlock => b !== null);
    if (blocks.length === 0) continue;

    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  }

  return out;
}

function fromAnthropicStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
    case 'pause_turn':
      return 'tool_use';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Anthropic reports `input_tokens` EXCLUSIVE of cache reads and writes, while
 * OpenAI and Gemini report cached tokens as a subset of the prompt total. We
 * normalize on the subset convention, so the cache counts are added back in.
 */
function toUsage(u: Record<string, number> | undefined): Usage {
  const input = u?.input_tokens ?? 0;
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: input + cacheRead + cacheWrite,
    outputTokens: u?.output_tokens ?? 0,
    ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function buildBody(req: CompletionRequest, ctx: ProviderContext, stream: boolean) {
  return {
    model: ctx.providerModelId,
    // Required by Anthropic. We fall back to a sane cap rather than sending
    // undefined, which is a 400.
    max_tokens: req.maxTokens ?? 4096,
    ...(req.system ? { system: req.system } : {}),
    messages: toAnthropicMessages(req.messages),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    // Structured output and caller-supplied tools are mutually exclusive here:
    // forcing tool_choice at one tool necessarily excludes the others.
    ...(req.responseSchema
      ? {
          tools: [
            {
              name: STRUCTURED_TOOL,
              description: 'Emit the final answer as JSON matching the provided schema.',
              input_schema: req.responseSchema,
            },
          ],
          tool_choice: { type: 'tool', name: STRUCTURED_TOOL },
        }
      : req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function headers(ctx: ProviderContext): Record<string, string> {
  return {
    'x-api-key': ctx.apiKey,
    'anthropic-version': String(ctx.extra?.anthropicVersion ?? '2023-06-01'),
  };
}

/** Status alone cannot tell "your JSON is malformed" from "your prompt is too
 *  long" — both are 400. Anthropic's `error.type` plus the message can. */
function refineError(e: unknown): never {
  if (e instanceof ProviderError && e.status === 400) {
    const raw = e.raw as { error?: { type?: string; message?: string } } | undefined;
    const msg = raw?.error?.message ?? '';
    if (/prompt is too long|exceed.*context|too many tokens/i.test(msg)) {
      throw new ProviderError({ ...errBase(e), kind: 'context_length' });
    }
    if (raw?.error?.type === 'authentication_error') {
      throw new ProviderError({ ...errBase(e), kind: 'auth' });
    }
  }
  if (e instanceof ProviderError && e.status === 529) {
    // Anthropic-specific "overloaded". Retryable, unlike a generic 5xx family
    // member would be if we only looked at the class.
    throw new ProviderError({ ...errBase(e), kind: 'server_error', retryable: true });
  }
  throw e;
}

function errBase(e: ProviderError) {
  return {
    provider: e.provider,
    message: e.message,
    status: e.status,
    retryAfterMs: e.retryAfterMs,
    raw: e.raw,
  };
}

// ---------------------------------------------------------------------------

const anthropic: Provider = {
  name: NAME,

  async complete(req, ctx): Promise<CompletionResponse> {
    let result;
    try {
      result = await postJson({
        url: `${ctx.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
        headers: headers(ctx),
        body: buildBody(req, ctx, false),
        provider: NAME,
        timeoutMs: ctx.timeoutMs,
        signal: req.signal,
      });
    } catch (e) {
      refineError(e);
    }

    try {
      const json = (await result!.res.json()) as {
        content: AnthropicBlock[];
        stop_reason: string;
        usage: Record<string, number>;
      };

      const content: ContentBlock[] = json.content.flatMap((b): ContentBlock[] => {
        if (b.type === 'text') return [{ type: 'text', text: b.text ?? '' }];
        if (b.type === 'tool_use') {
          // Unwrap the forced structured-output call so callers get text,
          // matching every other provider.
          if (b.name === STRUCTURED_TOOL) return [{ type: 'text', text: JSON.stringify(b.input ?? {}) }];
          return [{ type: 'tool_use', id: b.id!, name: b.name!, input: (b.input as Record<string, unknown>) ?? {} }];
        }
        return [];
      });

      return {
        message: { role: 'assistant', content },
        usage: toUsage(json.usage),
        finishReason: fromAnthropicStopReason(json.stop_reason),
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
        url: `${ctx.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
        headers: headers(ctx),
        body: buildBody(req, ctx, true),
        provider: NAME,
        timeoutMs: ctx.timeoutMs,
        signal: req.signal,
      });
    } catch (e) {
      refineError(e);
    }

    // Tool arguments arrive as JSON fragments across many events; they are only
    // parseable once content_block_stop lands. Index-keyed because Anthropic
    // identifies blocks positionally in deltas, not by id.
    const toolBuf = new Map<number, { id: string; name: string; json: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: FinishReason = 'stop';

    for await (const frame of readSse(result!.res, result!.dispose)) {
      const evt = JSON.parse(frame.data) as Record<string, any>;

      switch (evt.type) {
        case 'message_start':
          usage = toUsage(evt.message?.usage);
          break;

        case 'content_block_start': {
          const cb = evt.content_block;
          if (cb?.type === 'tool_use') {
            toolBuf.set(evt.index, { id: cb.id, name: cb.name, json: '' });
            // The structured-output tool is an implementation detail of this
            // adapter; it must not surface as a tool call to the app.
            if (cb.name !== STRUCTURED_TOOL) yield { type: 'tool_use_start', id: cb.id, name: cb.name };
          }
          break;
        }

        case 'content_block_delta': {
          const d = evt.delta;
          if (d?.type === 'text_delta') {
            yield { type: 'text_delta', text: d.text };
          } else if (d?.type === 'thinking_delta') {
            yield { type: 'reasoning_delta', text: d.thinking };
          } else if (d?.type === 'input_json_delta') {
            const buf = toolBuf.get(evt.index);
            if (buf) {
              buf.json += d.partial_json;
              // Structured output streams as text, so a caller can render
              // partial JSON identically across all three providers.
              if (buf.name === STRUCTURED_TOOL) yield { type: 'text_delta', text: d.partial_json };
              else yield { type: 'tool_use_delta', id: buf.id, partialJson: d.partial_json };
            }
          }
          break;
        }

        case 'content_block_stop': {
          const buf = toolBuf.get(evt.index);
          if (buf) {
            toolBuf.delete(evt.index);
            if (buf.name === STRUCTURED_TOOL) break; // already streamed as text
            yield {
              type: 'tool_use_complete',
              id: buf.id,
              name: buf.name,
              // Anthropic sends "" for a no-argument tool call, which JSON.parse
              // rejects. Everything else is a genuine protocol violation.
              input: buf.json.trim() === '' ? {} : (JSON.parse(buf.json) as Record<string, unknown>),
            };
          }
          break;
        }

        case 'message_delta':
          finish = fromAnthropicStopReason(evt.delta?.stop_reason);
          // Output tokens only become final here; message_start reports 1-2.
          if (evt.usage?.output_tokens !== undefined) usage.outputTokens = evt.usage.output_tokens;
          break;

        case 'message_stop':
          yield { type: 'usage', usage };
          yield { type: 'done', finishReason: finish };
          break;

        case 'error':
          throw new ProviderError({
            kind: evt.error?.type === 'overloaded_error' ? 'server_error' : 'server_error',
            provider: NAME,
            message: `anthropic stream error: ${evt.error?.type}`,
            raw: evt,
          });
      }
    }
  },
};

export default anthropic;
