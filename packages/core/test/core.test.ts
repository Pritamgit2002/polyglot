import { describe, expect, it } from 'vitest';
import {
  computeCostUsd,
  computeDelay,
  fitToContextWindow,
  fromTransportError,
  ProviderError,
  withRetry,
} from '../src/index.js';

describe('cost', () => {
  const pricing = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3, cacheWritePerMTok: 3.75 };

  it('bills cached input at the cached rate, not the full rate', () => {
    const full = computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, pricing);
    const cached = computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }, pricing);

    expect(full).toBeCloseTo(3.0, 6);
    expect(cached).toBeCloseTo(0.3, 6);
  });

  it('treats an absent cached count as "not reported", not as zero-cost', () => {
    expect(computeCostUsd({ inputTokens: 1000, outputTokens: 1000 }, pricing)).toBeCloseTo(0.003 + 0.015, 6);
  });

  it('bills cache writes at the write premium', () => {
    const cost = computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 }, pricing);
    expect(cost).toBeCloseTo(3.75, 6);
  });
});

describe('long-context pricing', () => {
  // gpt-5.6-luna, read from the OpenAI model page on 2026-09-18.
  const luna = {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cachedInputPerMTok: 0.02,
    cacheWritePerMTok: 0.25,
    longContext: { thresholdInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  };

  it('uses base rates below the threshold', () => {
    expect(computeCostUsd({ inputTokens: 100_000, outputTokens: 10_000 }, luna)).toBeCloseTo(0.02 + 0.012, 6);
  });

  it('does not surcharge exactly AT the threshold — the rule is "exceeds"', () => {
    const at = computeCostUsd({ inputTokens: 272_000, outputTokens: 1_000 }, luna);
    expect(at).toBeCloseTo((272_000 / 1e6) * 0.2 + (1_000 / 1e6) * 1.2, 6);
  });

  it('surcharges the WHOLE request once the threshold is exceeded', () => {
    const over = computeCostUsd({ inputTokens: 300_000, outputTokens: 10_000 }, luna);
    // 2x on all input, 1.5x on all output — not just the excess.
    expect(over).toBeCloseTo((300_000 / 1e6) * 0.2 * 2 + (10_000 / 1e6) * 1.2 * 1.5, 6);
  });

  it('applies the input multiplier to cached and cache-write tokens too', () => {
    const cost = computeCostUsd(
      { inputTokens: 300_000, outputTokens: 0, cachedInputTokens: 300_000 },
      luna,
    );
    expect(cost).toBeCloseTo((300_000 / 1e6) * 0.02 * 2, 6);
  });

  it("reproduces Gemini 2.5 Pro's published two-tier table exactly", () => {
    // Published 2026-09-18: $1.25 in / $10 out / $0.125 cached up to 200k,
    // and $2.50 / $15.00 / $0.25 above it. Modelled as 2x input, 1.5x output.
    const pro = {
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cachedInputPerMTok: 0.125,
      longContext: { thresholdInputTokens: 200_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    };

    // 1M tokens at each rate makes the per-MTok price directly readable.
    expect(computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, { ...pro, longContext: undefined })).toBeCloseTo(1.25, 6);
    expect(computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, pro)).toBeCloseTo(2.5, 6);
    expect(computeCostUsd({ inputTokens: 300_000, outputTokens: 1_000_000 }, pro)).toBeCloseTo(0.3 * 2.5 + 15, 6);
    // The cached rate doubles too: $0.125 -> $0.25.
    expect(
      computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }, pro),
    ).toBeCloseTo(0.25, 6);
  });

  it('is a no-op for a model with no long-context tier', () => {
    const flat = { inputPerMTok: 3, outputPerMTok: 15 };
    expect(computeCostUsd({ inputTokens: 500_000, outputTokens: 1_000 }, flat)).toBeCloseTo(1.5 + 0.015, 6);
  });
});

describe('context fitting', () => {
  const model = {
    provider: 'anthropic',
    providerModelId: 'x',
    displayName: 'x',
    contextWindow: 1000,
    maxOutputTokens: 100,
    capabilities: { tools: true, vision: true, jsonSchema: true, streaming: true },
    pricing: { inputPerMTok: 1, outputPerMTok: 1 },
  };

  it('drops the oldest turns first and never leaves an orphan tool_result', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'a'.repeat(3000) }] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'calc', input: {} }] },
      { role: 'tool' as const, content: [{ type: 'tool_result' as const, toolUseId: 't1', content: 'ok' }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'short question' }] },
    ];

    const fitted = fitToContextWindow(messages, model, { reserveOutputTokens: 100 });

    expect(fitted.droppedCount).toBeGreaterThan(0);
    const first = fitted.messages[0]!;
    expect(first.role).not.toBe('tool');
    expect(first.content.some((b) => b.type === 'tool_result')).toBe(false);
  });

  it('leaves a conversation that already fits untouched', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
    expect(fitToContextWindow(messages, model).droppedCount).toBe(0);
  });
});

describe('retry', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: 'none' as const };

  it('never retries auth or bad_request', async () => {
    let calls = 0;
    const run = withRetry(async () => {
      calls++;
      throw new ProviderError({ kind: 'auth', provider: 'x', message: 'bad key' });
    }, policy);

    await expect(run).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toBe(1);
  });

  it('retries rate_limit up to maxAttempts', async () => {
    let calls = 0;
    const run = withRetry(async () => {
      calls++;
      throw new ProviderError({ kind: 'rate_limit', provider: 'x', message: '429', retryAfterMs: 1 });
    }, policy);

    await expect(run).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(calls).toBe(3);
  });

  it('grows the delay exponentially and caps it', () => {
    expect(computeDelay(1, policy)).toBe(100);
    expect(computeDelay(2, policy)).toBe(200);
    expect(computeDelay(4, policy)).toBe(800);
    expect(computeDelay(9, policy)).toBe(1000);
  });

  it('keeps full jitter inside [0, cap]', () => {
    const jittered = { ...policy, jitter: 'full' as const };
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(3, jittered);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(400);
    }
  });
});

describe('abort classification', () => {
  it('classifies an AbortError as cancelled, not as a retryable server error', () => {
    // This is what escapes the SSE read loop when the caller aborts: a raw
    // DOMException that never passes through the adapter's HTTP error handling.
    const err = fromTransportError(new DOMException('The operation was aborted.', 'AbortError'), 'anthropic');

    expect(err.kind).toBe('cancelled');
    // The consequence that matters: a cancelled request must NOT be retried,
    // or pressing Stop kicks off a fresh generation on the next provider.
    expect(err.retryable).toBe(false);
  });

  it('still classifies a genuine transport failure as a retryable server error', () => {
    const err = fromTransportError(new Error('socket hang up'), 'openai');

    expect(err.kind).toBe('server_error');
    expect(err.retryable).toBe(true);
  });
});
