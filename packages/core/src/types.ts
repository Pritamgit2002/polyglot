/**
 * The provider-agnostic contract.
 *
 * Everything above the adapter layer speaks ONLY these types. No vendor shape
 * — no `choices[]`, no `candidates[]`, no `content_block_delta` — is allowed to
 * escape an adapter. If you find yourself importing a vendor SDK type outside
 * `@polyglot/providers/adapters/*`, the abstraction has leaked.
 */

// ---------- provider-agnostic message format ----------

export type Role = 'user' | 'assistant' | 'tool';

export type ContentBlockType = 'text' | 'image' | 'tool_use' | 'tool_result';

export interface ContentBlock {
  type: ContentBlockType;

  /** type: 'text' */
  text?: string;

  /** type: 'image' */
  mimeType?: string;
  /** type: 'image' — base64, no data: prefix */
  data?: string;

  /** type: 'tool_use' — the assistant asking for a tool */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;

  /** type: 'tool_result' — our answer back to the model */
  toolUseId?: string;
  content?: string;
  isError?: boolean;
}

export interface Message {
  role: Role;
  /** Always an array, even for plain text. Normalizing here means adapters
   *  never have to handle the string-or-array ambiguity every vendor has. */
  content: ContentBlock[];
}

// ---------- the call ----------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset that every provider accepts). */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  /** Our internal id, e.g. "anthropic:claude-sonnet-4-6" — never a vendor id. */
  model: string;
  messages: Message[];
  /** Top-level on purpose: Anthropic wants it as a request param, OpenAI wants
   *  it as a message, Gemini wants it as `systemInstruction`. Adapter's job. */
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** Must reach the upstream fetch. Cancelling has to cancel, not just stop
   *  rendering — otherwise we keep paying for tokens nobody reads. */
  signal?: AbortSignal;
}

// ---------- what comes back ----------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Only where the provider reports it. `undefined` means "not reported",
   *  which is NOT the same as zero — cost maths must respect the difference. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** Extension to the assignment's contract: Anthropic bills cache WRITES at a
   *  premium (1.25x input) and reports them separately from cache reads. Folding
   *  the two together would misprice every first request against a cached
   *  prefix, so we keep them apart. See docs/PROVIDER_NOTES.md. */
  cacheWriteTokens?: number;
}

export type FinishReason =
  | 'stop'
  | 'max_tokens'
  | 'tool_use'
  | 'content_filter'
  | 'error';

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partialJson: string }
  | { type: 'tool_use_complete'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: FinishReason }
  | { type: 'error'; error: SerializedProviderError };

export interface CompletionResponse {
  /** The assistant turn, already in our format, ready to append to history. */
  message: Message;
  usage: Usage;
  finishReason: FinishReason;
  /** Internal model id that actually served the request — may differ from the
   *  requested one when the fallback chain kicked in. */
  model: string;
}

// ---------- normalized errors ----------

export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'content_filter'
  | 'timeout'
  | 'server_error'
  | 'bad_request'
  | 'cancelled'
  | 'unconfigured';

/** The only error shape that crosses the adapter boundary toward the client.
 *  `raw` is deliberately absent — see ProviderError.toClient(). */
export interface SerializedProviderError {
  kind: ErrorKind;
  provider: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

// ---------- the interface every adapter implements ----------

export interface ProviderContext {
  apiKey: string;
  baseUrl?: string;
  /** Vendor model id from config, e.g. "claude-sonnet-4-6". */
  providerModelId: string;
  timeoutMs: number;
  /** Anything provider-specific from config.extra — kept opaque to the core. */
  extra?: Record<string, unknown>;
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest, ctx: ProviderContext): Promise<CompletionResponse>;
  stream(req: CompletionRequest, ctx: ProviderContext): AsyncIterable<StreamEvent>;
  embed?(texts: string[], ctx: ProviderContext): Promise<number[][]>;
}

/** What a new adapter file default-exports. This is the entire surface area a
 *  fourth provider has to satisfy. */
export type ProviderModule = { default: Provider };
