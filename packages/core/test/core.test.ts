import { describe, expect, it } from 'vitest';
import { computeCostUsd, fitToContextWindow, computeDelay, ProviderError, withRetry } from '../src/index.js';

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
