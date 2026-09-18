import { ProviderError, isProviderError } from './errors.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: 'none' | 'full' | 'equal';
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
}

/**
 * Exponential backoff with jitter.
 *
 * Two rules that are easy to get wrong and expensive when you do:
 *  1. We retry ONLY rate_limit / server_error / timeout. Retrying `auth` just
 *     burns your rate limit with the same bad key; retrying `bad_request`
 *     sends the same malformed body three times.
 *  2. Jitter is not decoration. Without it, every client that got 429'd at the
 *     same instant retries at the same instant and re-creates the spike.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  opts: { signal?: AbortSignal; onRetry?: (e: ProviderError, attempt: number, delayMs: number) => void } = {},
): Promise<RetryOutcome<T>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new ProviderError({ kind: 'cancelled', provider: 'polyglot', message: 'Aborted before attempt.' });
    }
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (e) {
      lastError = e;
      const isLast = attempt === policy.maxAttempts;
      if (!isProviderError(e) || !e.retryable || isLast) throw e;

      const delay = computeDelay(attempt, policy, e.retryAfterMs);
      opts.onRetry?.(e, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}

export function computeDelay(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  // A provider-supplied Retry-After is authoritative — it knows when the window
  // actually reopens. We still jitter it so we do not stampede at that instant.
  const base = retryAfterMs ?? policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(base, policy.maxDelayMs);

  switch (policy.jitter) {
    case 'none':
      return capped;
    case 'equal':
      return capped / 2 + Math.random() * (capped / 2);
    case 'full':
    default:
      return Math.random() * capped;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new ProviderError({ kind: 'cancelled', provider: 'polyglot', message: 'Aborted during backoff.' }));
      },
      { once: true },
    );
  });
}
