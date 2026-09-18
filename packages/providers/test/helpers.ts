import { vi } from 'vitest';

/** Builds a Response whose body streams the given SSE frames, one chunk each,
 *  so tests exercise the same incremental path production does. */
export function sseResponse(frames: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

/** Splits every frame across two chunks at a random-ish point. A parser that
 *  passes only the whole-frame version is the classic "works locally, drops
 *  characters behind a proxy" bug. */
export function splitSseResponse(frames: string[]): Response {
  const parts: string[] = [];
  for (const f of frames) {
    const mid = Math.max(1, Math.floor(f.length / 2));
    parts.push(f.slice(0, mid), f.slice(mid));
  }
  return sseResponse(parts);
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** Replaces global fetch and records what the adapter actually sent. Asserting
 *  on the REQUEST is most of the value: that is where the vendor differences
 *  live, and it needs no API key. */
export function mockFetch(responder: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fn = vi.fn(async (input: any, init: any) => {
    const call: CapturedCall = {
      url: typeof input === 'string' ? input : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    return responder(call);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

export const CTX = {
  apiKey: 'test-key',
  providerModelId: 'test-model',
  timeoutMs: 5000,
};
