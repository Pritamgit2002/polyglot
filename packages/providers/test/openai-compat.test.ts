import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAdapter, toOpenAIMessages } from '../src/adapters/openai-compat.js';
import { CTX, collect, jsonResponse, mockFetch, splitSseResponse } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

const openai = makeAdapter('openai');
const groq = makeAdapter('groq');
const deepseek = makeAdapter('deepseek');
const ctx = { ...CTX, baseUrl: 'https://api.openai.com/v1' };

describe('openai-compatible request mapping', () => {
  it('folds system into the first message instead of a top-level field', () => {
    const out = toOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'Be terse.');
    expect(out[0]).toEqual({ role: 'system', content: 'Be terse.' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('serializes tool arguments to a STRING and emits tool results as their own messages', () => {
    const out = toOpenAIMessages([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'calculator', input: { expression: '2+2' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: '{"result":4}' }] },
    ]);

    // Arguments are an object on Anthropic/Gemini, a JSON string here.
    expect(out[0]!.tool_calls![0]!.function!.arguments).toBe('{"expression":"2+2"}');
    expect(out[0]!.content).toBeNull();
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"result":4}' });
  });

  it('omits stream_options for providers that reject it (Groq)', async () => {
    const { calls } = mockFetch(() => splitSseResponse(['data: [DONE]\n\n']));

    await collect(
      groq.stream({ model: 'groq:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, {
        ...ctx,
        extra: { supportsStreamOptions: false },
      }),
    );

    expect(calls[0]!.body.stream).toBe(true);
    expect(calls[0]!.body.stream_options).toBeUndefined();
  });
});

describe('openai-compatible streaming', () => {
  it('accumulates index-keyed tool arguments that arrive without an id', async () => {
    mockFetch(() =>
      splitSseResponse([
        'data: {"choices":[{"delta":{"content":"One moment"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","function":{"name":"calculator","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"expres"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"sion\\":\\"2+2\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":20}}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(
      openai.stream({ model: 'openai:x', messages: [{ role: 'user', content: [{ type: 'text', text: '2+2' }] }] }, ctx),
    );

    const complete = events.find((e) => e.type === 'tool_use_complete') as any;
    expect(complete.id).toBe('call_7');
    expect(complete.name).toBe('calculator');
    expect(complete.input).toEqual({ expression: '2+2' });

    const usage = (events.find((e) => e.type === 'usage') as any).usage;
    expect(usage.inputTokens).toBe(50);
    expect(usage.cachedInputTokens).toBe(20);
    expect((events.find((e) => e.type === 'done') as any).finishReason).toBe('tool_use');
  });

  it('reads usage from x_groq on the final chunk', async () => {
    mockFetch(() =>
      splitSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"x_groq":{"usage":{"prompt_tokens":11,"completion_tokens":3}}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(
      groq.stream({ model: 'groq:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, ctx),
    );
    expect((events.find((e) => e.type === 'usage') as any).usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
  });

  it('surfaces DeepSeek reasoning_content as reasoning_delta, separate from text', async () => {
    mockFetch(() =>
      splitSseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"The user wants..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"4"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(
      deepseek.stream({ model: 'deepseek:x', messages: [{ role: 'user', content: [{ type: 'text', text: '2+2' }] }] }, {
        ...ctx,
        extra: { reasoningField: 'reasoning_content' },
      }),
    );

    expect(events.filter((e) => e.type === 'reasoning_delta')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text_delta').map((e: any) => e.text).join('')).toBe('4');
  });

  it('survives truncated tool arguments instead of throwing away the turn', async () => {
    mockFetch(() =>
      splitSseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"calculator","arguments":"{\\"expr"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(
      openai.stream({ model: 'openai:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, ctx),
    );

    expect((events.find((e) => e.type === 'tool_use_complete') as any).input).toEqual({});
    expect((events.find((e) => e.type === 'done') as any).finishReason).toBe('max_tokens');
  });
});

describe('openai-compatible error normalization', () => {
  it('maps context_length_exceeded', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'context_length_exceeded', message: "maximum context length" } }, 400));

    const err = await openai
      .complete({ model: 'openai:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, ctx)
      .catch((e) => e);

    expect(err.kind).toBe('context_length');
    expect(err.provider).toBe('openai');
  });
});
