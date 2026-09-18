import { afterEach, describe, expect, it, vi } from 'vitest';
import gemini, { sanitizeSchemaForGemini, toGeminiContents } from '../src/adapters/gemini.js';
import { CTX, collect, jsonResponse, mockFetch, splitSseResponse } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('gemini request mapping', () => {
  it('uses model/user roles, parts, and systemInstruction', async () => {
    const { calls } = mockFetch(() => jsonResponse({ candidates: [{ content: { parts: [] } }] }));

    await gemini.complete(
      {
        model: 'google:x',
        system: 'Be terse.',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        ],
      },
      { ...CTX, baseUrl: 'https://generativelanguage.googleapis.com' },
    );

    const body = calls[0]!.body;
    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model']);
    expect(body.contents[0].parts[0]).toEqual({ text: 'hi' });
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] });
  });

  it('sends the API key as a header, never in the query string', async () => {
    const { calls } = mockFetch(() => jsonResponse({ candidates: [] }));
    await gemini.complete({ model: 'google:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, CTX);

    expect(calls[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(calls[0]!.url).not.toContain('test-key');
  });

  it('matches a function response to its call by NAME, since Gemini has no call id', () => {
    const contents = toGeminiContents([
      { role: 'user', content: [{ type: 'text', text: 'weather in Oslo?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'Oslo' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '{"temperatureC":3}' }] },
    ]);

    const fr = contents[2]!.parts[0]!.functionResponse!;
    expect(fr.name).toBe('get_weather');
    // The payload must be an object; a bare string is rejected.
    expect(fr.response).toEqual({ result: '{"temperatureC":3}' });
  });

  it('strips JSON Schema keywords Gemini rejects', () => {
    const cleaned = sanitizeSchemaForGemini({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        n: { type: 'number', exclusiveMinimum: 0 },
        nested: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
      },
      required: ['n'],
    }) as any;

    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.additionalProperties).toBeUndefined();
    expect(cleaned.properties.n.exclusiveMinimum).toBeUndefined();
    expect(cleaned.properties.nested.additionalProperties).toBeUndefined();
    // Everything Gemini DOES understand must survive.
    expect(cleaned.properties.nested.properties.a).toEqual({ type: 'string' });
    expect(cleaned.required).toEqual(['n']);
  });
});

describe('gemini streaming', () => {
  it('synthesizes start/delta/complete for an atomic function call', async () => {
    mockFetch(() =>
      splitSseResponse([
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Checking"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"calculator","args":{"expression":"6*7"}}}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":80,"candidatesTokenCount":12,"thoughtsTokenCount":30,"cachedContentTokenCount":20}}\n\n',
      ]),
    );

    const events = await collect(
      gemini.stream({ model: 'google:x', messages: [{ role: 'user', content: [{ type: 'text', text: '6*7' }] }] }, CTX),
    );

    // Gemini never fragments arguments, but the rest of the app must still see
    // the same three-event shape it gets from Anthropic and OpenAI.
    expect(events.filter((e) => e.type === 'tool_use_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_use_delta')).toHaveLength(1);
    const complete = events.find((e) => e.type === 'tool_use_complete') as any;
    expect(complete.input).toEqual({ expression: '6*7' });

    // A turn that requested a tool finishes as 'tool_use', even though Gemini
    // reported STOP.
    expect((events.find((e) => e.type === 'done') as any).finishReason).toBe('tool_use');
  });

  it('adds thoughtsTokenCount into outputTokens and keeps cached as a subset', async () => {
    mockFetch(() =>
      splitSseResponse([
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":80,"candidatesTokenCount":12,"thoughtsTokenCount":30,"cachedContentTokenCount":20}}\n\n',
      ]),
    );

    const events = await collect(
      gemini.stream({ model: 'google:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, CTX),
    );
    const usage = (events.find((e) => e.type === 'usage') as any).usage;

    expect(usage.inputTokens).toBe(80);
    expect(usage.cachedInputTokens).toBe(20);
    expect(usage.outputTokens).toBe(42); // 12 visible + 30 thinking
    expect(usage.reasoningTokens).toBe(30);
  });
});

describe('gemini error normalization', () => {
  it('maps RESOURCE_EXHAUSTED to rate_limit', async () => {
    mockFetch(() => jsonResponse({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429));

    const err = await gemini
      .complete({ model: 'google:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, CTX)
      .catch((e) => e);

    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
  });

  it('maps an INVALID_ARGUMENT token-count message to context_length', async () => {
    mockFetch(() =>
      jsonResponse({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The input token count exceeds the maximum' } }, 400),
    );

    const err = await gemini
      .complete({ model: 'google:x', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, CTX)
      .catch((e) => e);

    expect(err.kind).toBe('context_length');
  });
});
