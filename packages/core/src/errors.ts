import type { ErrorKind, SerializedProviderError } from './types.js';

/**
 * The single error type the rest of the app is allowed to see.
 *
 * `raw` holds the untouched upstream body for logs. It is never serialized to
 * the client: provider error bodies routinely echo back the request, which can
 * contain the system prompt, retrieved document chunks, or — on a
 * misconfiguration — the key itself.
 */
export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly provider: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly raw?: unknown;

  constructor(init: {
    kind: ErrorKind;
    provider: string;
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
    status?: number;
    raw?: unknown;
  }) {
    super(init.message);
    this.name = 'ProviderError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE[init.kind];
    this.retryAfterMs = init.retryAfterMs;
    this.status = init.status;
    this.raw = init.raw;
  }

  /** Safe projection. This is the ONLY thing that may reach the browser. */
  toClient(): SerializedProviderError {
    return {
      kind: this.kind,
      provider: this.provider,
      message: CLIENT_SAFE_MESSAGE[this.kind],
      retryable: this.retryable,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

/** Retry policy lives with the taxonomy so it cannot drift from it.
 *  Only rate_limit / server_error / timeout are ever retried. */
const DEFAULT_RETRYABLE: Record<ErrorKind, boolean> = {
  auth: false,
  rate_limit: true,
  context_length: false,
  content_filter: false,
  timeout: true,
  server_error: true,
  bad_request: false,
  cancelled: false,
  unconfigured: false,
};

/** Generic, non-leaking text. The specific upstream message stays in the log. */
const CLIENT_SAFE_MESSAGE: Record<ErrorKind, string> = {
  auth: 'The provider rejected our credentials.',
  rate_limit: 'The provider is rate limiting this request.',
  context_length: 'This conversation is too long for the selected model.',
  content_filter: 'The provider blocked this request or response.',
  timeout: 'The provider did not respond in time.',
  server_error: 'The provider returned an internal error.',
  bad_request: 'The request was rejected as malformed by the provider.',
  cancelled: 'The request was cancelled.',
  unconfigured: 'This provider has no API key configured on the server.',
};

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

/**
 * HTTP status → ErrorKind. Every adapter starts here and then overrides with
 * whatever vendor-specific signal it has (Anthropic's `error.type`, Gemini's
 * `status` string, OpenAI's `error.code`), because status alone is lossy:
 * all three return 400 for both "your JSON is wrong" and "your prompt is too
 * long", and those need different handling.
 */
export function kindFromStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

/** Honour Retry-After (seconds, or an HTTP date) when the provider sends it. */
export function retryAfterFromHeaders(headers: Headers): number | undefined {
  const raw =
    headers.get('retry-after') ??
    headers.get('x-ratelimit-reset-requests') ??
    headers.get('x-ratelimit-reset-tokens');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  // Groq sends things like "2.5s" / "1m30s"; OpenAI sends "6ms".
  const duration = parseDuration(raw);
  if (duration !== undefined) return duration;

  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return undefined;
}

function parseDuration(raw: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  for (const m of raw.matchAll(re)) {
    matched = true;
    const value = Number(m[1]);
    const unit = m[2];
    total +=
      unit === 'ms' ? value : unit === 's' ? value * 1000 : unit === 'm' ? value * 60_000 : value * 3_600_000;
  }
  return matched ? total : undefined;
}

/** Wrap anything thrown by fetch/AbortController into the taxonomy. */
export function fromTransportError(e: unknown, provider: string): ProviderError {
  if (isProviderError(e)) return e;

  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === 'AbortError') {
    return new ProviderError({
      kind: 'cancelled',
      provider,
      message: 'Request aborted by caller.',
      raw: e,
    });
  }
  if (err?.name === 'TimeoutError' || err?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new ProviderError({ kind: 'timeout', provider, message: 'Upstream timed out.', raw: e });
  }
  return new ProviderError({
    kind: 'server_error',
    provider,
    message: err?.message ?? 'Unknown transport failure.',
    raw: e,
  });
}
