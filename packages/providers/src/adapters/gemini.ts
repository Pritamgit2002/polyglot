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
 * Google Gemini — generateContent / streamGenerateContent.
 *
 * This is the adapter that justifies the whole abstraction. Gemini disagrees
 * with the other two on nearly every axis:
 *
 *  1. Roles are 'user' and 'model'. There is no 'assistant', no 'system' and
 *     no 'tool' role inside `contents`.
 *  2. Messages are `contents`, blocks are `parts`, and a tool call is a
 *     `functionCall` part rather than a distinct block type.
 *  3. A function RESPONSE carries no call id — it is matched to the call BY
 *     NAME. Our contract is id-based, so the adapter has to resolve id -> name
 *     from earlier turns. See resolveToolName().
 *  4. Streamed function calls arrive COMPLETE in a single chunk; they are never
 *     fragmented the way Anthropic's input_json_delta or OpenAI's argument
 *     deltas are. We synthesize start/delta/complete so the rest of the app
 *     sees one uniform tool-streaming shape.
 *  5. Tool parameter schemas are an OpenAPI 3.0 subset, not JSON Schema.
 *     `additionalProperties`, `$schema` and friends are hard 400s.
 *  6. Token counts live under `usageMetadata` with entirely different names,
 *     and `thoughtsTokenCount` is NOT included in candidatesTokenCount.
 */

const NAME = 'google';
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

// ---------------------------------------------------------------------------
// JSON Schema -> Gemini's OpenAPI subset
// ---------------------------------------------------------------------------

/** Keys Gemini's schema validator rejects outright. Stripping them recursively
 *  is cheaper than maintaining a second set of tool definitions per provider. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'patternProperties',
  'const',
  'oneOf',
  'allOf',
  'not',
  'definitions',
  '$defs',
]);

export function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
  if (schema === null || typeof schema !== 'object') return schema;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
    out[k] = sanitizeSchemaForGemini(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// our format -> Gemini
// ---------------------------------------------------------------------------

/** Gemini matches a function response to its call by name, so we walk back
 *  through the transcript to recover the name our id refers to. */
function resolveToolName(messages: Message[], toolUseId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i]!.content) {
      if (b.type === 'tool_use' && b.id === toolUseId && b.name) return b.name;
    }
  }
  // Better to send a wrong-but-present name than to omit the field: the model
  // ignores an unknown name, but a missing one is a 400.
  return 'unknown_tool';
}

export function toGeminiContents(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  for (const m of messages) {
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          if (b.text) parts.push({ text: b.text });
          break;
        case 'image':
          if (b.data && b.mimeType) parts.push({ inlineData: { mimeType: b.mimeType, data: b.data } });
          break;
        case 'tool_use':
          parts.push({ functionCall: { name: b.name!, args: b.input ?? {} } });
          break;
        case 'tool_result': {
          const name = resolveToolName(messages, b.toolUseId ?? '');
          parts.push({
            functionResponse: {
              name,
              // Gemini requires an object here; a bare string is rejected.
              response: b.isError ? { error: b.content ?? '' } : { result: b.content ?? '' },
            },
          });
          break;
        }
      }
    }

    if (parts.length === 0) continue;

    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else out.push({ role, parts });
  }

  return out;
}

function fromGeminiFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function toUsage(u: Record<string, number> | undefined): Usage {
  const prompt = u?.promptTokenCount ?? 0;
  const cached = u?.cachedContentTokenCount ?? 0;
  const thoughts = u?.thoughtsTokenCount ?? 0;
  return {
    // cachedContentTokenCount is already a subset of promptTokenCount.
    inputTokens: prompt,
    // thoughtsTokenCount is billed as output but reported separately, so it has
    // to be added in or every thinking request under-reports its cost.
    outputTokens: (u?.candidatesTokenCount ?? 0) + thoughts,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(thoughts ? { reasoningTokens: thoughts } : {}),
  };
}

function buildBody(req: CompletionRequest, ctx: ProviderContext) {
  return {
    contents: toGeminiContents(req.messages),
    // Not a message — a sibling field with its own shape.
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    ...(req.tools?.length
      ? {
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: sanitizeSchemaForGemini(t.parameters),
              })),
            },
          ],
        }
      : {}),
    generationConfig: {
      ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
  };
}

/** The key goes in a header, never the query string: URLs end up in access
 *  logs, proxy logs and browser history. */
function headers(ctx: ProviderContext): Record<string, string> {
  return { 'x-goog-api-key': ctx.apiKey };
}

function url(ctx: ProviderContext, method: 'generateContent' | 'streamGenerateContent'): string {
  const base = ctx.baseUrl ?? DEFAULT_BASE;
  const suffix = method === 'streamGenerateContent' ? '?alt=sse' : '';
  return `${base}/v1beta/models/${encodeURIComponent(ctx.providerModelId)}:${method}${suffix}`;
}

function refineError(e: unknown): never {
  if (e instanceof ProviderError) {
    const raw = e.raw as { error?: { status?: string; message?: string } } | undefined;
    const status = raw?.error?.status;
    const msg = raw?.error?.message ?? '';

    if (status === 'RESOURCE_EXHAUSTED') {
      throw new ProviderError({ ...base(e), kind: 'rate_limit', retryable: true });
    }
    if (status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED') {
      throw new ProviderError({ ...base(e), kind: 'auth' });
    }
    if (status === 'INVALID_ARGUMENT' && /token count|exceeds the maximum|too large/i.test(msg)) {
      throw new ProviderError({ ...base(e), kind: 'context_length' });
    }
    if (status === 'UNAVAILABLE' || status === 'INTERNAL') {
      throw new ProviderError({ ...base(e), kind: 'server_error', retryable: true });
    }
  }
  throw e;
}

function base(e: ProviderError) {
  return { provider: e.provider, message: e.message, status: e.status, retryAfterMs: e.retryAfterMs, raw: e.raw };
}

let toolCallCounter = 0;
/** Gemini gives function calls no id; the rest of the system is id-addressed,
 *  so we mint one. Prefixed to make its origin obvious in logs. */
function mintToolId(name: string): string {
  toolCallCounter += 1;
  return `gemini_${name}_${Date.now().toString(36)}_${toolCallCounter}`;
}

// ---------------------------------------------------------------------------

const gemini: Provider = {
  name: NAME,

  async complete(req, ctx): Promise<CompletionResponse> {
    let result;
    try {
      result = await postJson({
        url: url(ctx, 'generateContent'),
        headers: headers(ctx),
        body: buildBody(req, ctx),
        provider: NAME,
        timeoutMs: ctx.timeoutMs,
        signal: req.signal,
      });
    } catch (e) {
      refineError(e);
    }

    try {
      const json = (await result!.res.json()) as {
        candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
        usageMetadata?: Record<string, number>;
        promptFeedback?: { blockReason?: string };
      };

      if (json.promptFeedback?.blockReason) {
        throw new ProviderError({
          kind: 'content_filter',
          provider: NAME,
          message: `Blocked: ${json.promptFeedback.blockReason}`,
          raw: json.promptFeedback,
        });
      }

      const candidate = json.candidates?.[0];
      const content: ContentBlock[] = (candidate?.content?.parts ?? []).flatMap((p): ContentBlock[] => {
        if (p.functionCall) {
          return [
            {
              type: 'tool_use',
              id: mintToolId(p.functionCall.name),
              name: p.functionCall.name,
              input: p.functionCall.args ?? {},
            },
          ];
        }
        if (p.text && !p.thought) return [{ type: 'text', text: p.text }];
        return [];
      });

      const hasToolUse = content.some((b) => b.type === 'tool_use');
      return {
        message: { role: 'assistant', content },
        usage: toUsage(json.usageMetadata),
        finishReason: hasToolUse ? 'tool_use' : fromGeminiFinishReason(candidate?.finishReason),
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
        url: url(ctx, 'streamGenerateContent'),
        headers: headers(ctx),
        body: buildBody(req, ctx),
        provider: NAME,
        timeoutMs: ctx.timeoutMs,
        signal: req.signal,
      });
    } catch (e) {
      refineError(e);
    }

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: FinishReason = 'stop';
    let sawToolCall = false;

    for await (const frame of readSse(result!.res, result!.dispose)) {
      const chunk = JSON.parse(frame.data) as {
        candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
        usageMetadata?: Record<string, number>;
      };

      // usageMetadata is repeated on every chunk with running totals; the last
      // one wins rather than accumulating, or we would count the prompt N times.
      if (chunk.usageMetadata) usage = toUsage(chunk.usageMetadata);

      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall) {
          sawToolCall = true;
          const id = mintToolId(part.functionCall.name);
          const args = part.functionCall.args ?? {};
          // Synthesized so downstream consumers see the same three-event shape
          // they get from Anthropic and OpenAI, even though nothing fragmented.
          yield { type: 'tool_use_start', id, name: part.functionCall.name };
          yield { type: 'tool_use_delta', id, partialJson: JSON.stringify(args) };
          yield { type: 'tool_use_complete', id, name: part.functionCall.name, input: args };
        } else if (part.text) {
          if (part.thought) yield { type: 'reasoning_delta', text: part.text };
          else yield { type: 'text_delta', text: part.text };
        }
      }

      if (candidate?.finishReason) finish = fromGeminiFinishReason(candidate.finishReason);
    }

    yield { type: 'usage', usage };
    yield { type: 'done', finishReason: sawToolCall ? 'tool_use' : finish };
  },

  async embed(texts, ctx): Promise<number[][]> {
    const { res, dispose } = await postJson({
      url: `${ctx.baseUrl ?? DEFAULT_BASE}/v1beta/models/${encodeURIComponent(ctx.providerModelId)}:batchEmbedContents`,
      headers: headers(ctx),
      body: {
        requests: texts.map((text) => ({
          model: `models/${ctx.providerModelId}`,
          content: { parts: [{ text }] },
        })),
      },
      provider: NAME,
      timeoutMs: ctx.timeoutMs,
    });
    try {
      const json = (await res.json()) as { embeddings: Array<{ values: number[] }> };
      return json.embeddings.map((e) => e.values);
    } finally {
      dispose();
    }
  },
};

export default gemini;
