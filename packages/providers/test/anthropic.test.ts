import { afterEach, describe, expect, it, vi } from 'vitest';
import anthropic, { toAnthropicMessages } from '../src/adapters/anthropic.js';
import { isProviderError } from '@polyglot/core';
import { CTX, collect, jsonResponse, mockFetch, splitSseResponse } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('anthropic request mapping', () => {
  it('sends system as a top-level parameter, never as a message', async () => {
    const { calls } = mockFetch(() => jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} }));

    await anthropic.complete(
      { model: 'anthropic:x', system: 'You are terse.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      { ...CTX, baseUrl: 'https://api.anthropic.com' },
    );

    const body = calls[0]!.body;
    expect(body.system).toBe('You are terse.');
    expect(body.messages.some((m: any) => m.role === 'system')).toBe(false);
    // max_tokens is required by Anthropic and must be defaulted, not omitted.
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(calls[0]!.headers['x-api-key']).toBe('test-key');
  });

  it('folds tool results into a user message and merges same-role turns', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'Oslo' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '{"temperatureC":3}' }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_2', content: '{"result":7}' }] },
    ]);

    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // Both tool results land in ONE user turn: Anthropic rejects two user
    // messages in a row.
    expect(out[2]!.content).toHaveLength(2);
    expect(out[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
  });

  it('maps images to the source/base64 shape', () => {
    const [msg] = toAnthropicMessages([
      { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
    ]);
    expect(msg!.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  });
});

describe('anthropic streaming', () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":10}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"check."}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_9","name":"calculator"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"expres"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"sion\\":\\"2+2\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  it('accumulates fragmented tool arguments across chunk boundaries', async () => {
    // Frames are split mid-JSON on purpose: this is the bug that only shows up
    // in production if the SSE buffer does not survive across reads.
    mockFetch(() => splitSseResponse(frames));

    const events = await collect(
      anthropic.stream(
        { model: 'anthropic:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is 2+2' }] }] },
        { ...CTX, baseUrl: 'https://api.anthropic.com' },
      ),
    );

    const text = events.filter((e) => e.type === 'text_delta').map((e: any) => e.text).join('');
    expect(text).toBe('Let me check.');

    const complete = events.find((e) => e.type === 'tool_use_complete') as any;
    expect(complete.input).toEqual({ expression: '2+2' });
    expect(complete.name).toBe('calculator');

    expect((events.find((e) => e.type === 'done') as any).finishReason).toBe('tool_use');
  });

  it('adds cache reads and writes back into inputTokens', async () => {
    mockFetch(() => splitSseResponse(frames));

    const events = await collect(
      anthropic.stream({ model: 'anthropic:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, { ...CTX }),
    );
    const usage = (events.find((e) => e.type === 'usage') as any).usage;

    // Anthropic reports input_tokens EXCLUSIVE of cache; our contract says
    // cached tokens are a subset of inputTokens.
    expect(usage.inputTokens).toBe(150);
    expect(usage.cachedInputTokens).toBe(40);
    expect(usage.cacheWriteTokens).toBe(10);
    expect(usage.outputTokens).toBe(42);
  });
});

describe('anthropic error normalization', () => {
  it('classifies an over-long prompt as context_length, not bad_request', async () => {
    mockFetch(() =>
      jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000' } }, 400),
    );

    const err = await anthropic
      .complete({ model: 'anthropic:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, CTX)
      .catch((e) => e);

    expect(isProviderError(err)).toBe(true);
    expect(err.kind).toBe('context_length');
    expect(err.retryable).toBe(false);
  });

  it('marks 429 retryable and honours retry-after', async () => {
    mockFetch(() => jsonResponse({ error: { type: 'rate_limit_error' } }, 429, { 'retry-after': '3' }));

    const err = await anthropic
      .complete({ model: 'anthropic:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, CTX)
      .catch((e) => e);

    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000);
  });

  it('never leaks the raw provider body to the client projection', async () => {
    mockFetch(() => jsonResponse({ error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-secret' } }, 401));

    const err = await anthropic
      .complete({ model: 'anthropic:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, CTX)
      .catch((e) => e);

    const client = err.toClient();
    expect(JSON.stringify(client)).not.toContain('sk-ant-secret');
    expect(client.kind).toBe('auth');
    expect(client.retryable).toBe(false);
  });
});
