import { ProviderError, fromTransportError, kindFromStatus, retryAfterFromHeaders } from '@polyglot/core';

/**
 * Shared transport. Every adapter goes through here so that timeouts,
 * cancellation and the "never leak the raw body" rule are implemented once.
 */

export interface HttpCallInit {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  provider: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Links the caller's AbortSignal to a per-request timeout. Returns a signal
 * plus a disposer, because an un-cleared timer keeps the event loop alive and
 * silently aborts the NEXT request that reuses the controller.
 */
export function linkedSignal(timeoutMs: number, upstream?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);

  const onAbort = () => controller.abort(upstream?.reason);
  if (upstream) {
    if (upstream.aborted) onAbort();
    else upstream.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', onAbort);
    },
  };
}

export interface HttpCallResult {
  res: Response;
  /** MUST be called once the body is fully consumed. Clears the timeout timer
   *  and unhooks the upstream abort listener; skipping it leaks both. */
  dispose: () => void;
}

export async function postJson(init: HttpCallInit): Promise<HttpCallResult> {
  const { signal, dispose } = linkedSignal(init.timeoutMs, init.signal);
  try {
    const res = await fetch(init.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
      signal,
    });
    if (!res.ok) {
      const err = await errorFromResponse(res, init.provider);
      dispose();
      throw err;
    }
    // Ownership of `dispose` passes to the caller, which holds it until the
    // body is drained — a streaming response is not finished when headers land.
    return { res, dispose };
  } catch (e) {
    dispose();
    throw fromTransportError(e, init.provider);
  }
}

/** Reads the error body once, classifies it, and keeps the raw text for logs. */
export async function errorFromResponse(res: Response, provider: string): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return new ProviderError({
    kind: kindFromStatus(res.status),
    provider,
    message: `${provider} returned ${res.status}: ${truncate(text, 500)}`,
    status: res.status,
    retryAfterMs: retryAfterFromHeaders(res.headers),
    raw: parsed,
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * Minimal SSE reader.
 *
 * Written by hand rather than pulled from a library because the three vendors
 * disagree on the parts libraries paper over: Anthropic sends named `event:`
 * lines that carry the type, OpenAI sends anonymous `data:` lines terminated by
 * the sentinel string `[DONE]`, and Gemini sends anonymous `data:` lines with
 * no terminator at all. A frame can also be split across TCP chunks mid-token,
 * so the buffer must survive across reads — that is the bug that turns into
 * "streaming works locally but drops characters in prod".
 */
export async function* readSse(res: Response, onDispose?: () => void): AsyncGenerator<SseFrame> {
  const body = res.body;
  if (!body) throw new Error('Response has no body to stream.');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      // Frames end with a blank line. \r\n\r\n shows up behind some proxies.
      while ((sep = indexOfFrameEnd(buffer)) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');

        const frame = parseFrame(rawFrame);
        if (frame) yield frame;
      }
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
    onDispose?.();
  }
}

function indexOfFrameEnd(buffer: string): number {
  const a = buffer.indexOf('\n\n');
  const b = buffer.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }

  if (dataLines.length === 0) return null;
  return event ? { event, data: dataLines.join('\n') } : { data: dataLines.join('\n') };
}
