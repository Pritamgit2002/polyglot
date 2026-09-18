import { z } from 'zod';
import type { ToolDefinition } from '@polyglot/core';
import { evaluateExpression } from './calculator.js';
import { defaultRetrievalSettings, retrieve, type RetrievedChunk } from '../services/rag.js';

/**
 * ONE tool definition format. Adapters translate it per provider — Anthropic
 * wants `input_schema`, OpenAI wants `function.parameters`, Gemini wants a
 * sanitized OpenAPI subset under `functionDeclarations`. None of that is
 * visible here.
 *
 * Every tool validates its own input with zod before doing anything. Model
 * output is untrusted: it is influenced by the user and, in a RAG turn, by
 * uploaded document text.
 */

export interface ToolContext {
  tenantId: string;
  collectionId?: string;
  embeddingModelId: string;
  signal?: AbortSignal;
  /** Chunks the tool retrieved, surfaced so the UI can show citations for
   *  documents the MODEL chose to look up, not just ones we pre-retrieved. */
  onRetrieved?: (chunks: RetrievedChunk[]) => void;
}

export interface ToolImplementation {
  definition: ToolDefinition;
  execute(input: unknown, ctx: ToolContext): Promise<string>;
}

// ---------------------------------------------------------------------------

const calculatorInput = z.object({
  expression: z.string().min(1).max(500),
});

const calculator: ToolImplementation = {
  definition: {
    name: 'calculator',
    description:
      'Evaluate an arithmetic expression. Supports + - * / % ^, parentheses, and the functions sqrt, abs, round, floor, ceil, min, max, log. Use this instead of doing arithmetic yourself.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The expression to evaluate, e.g. "(1200 * 1.08) / 3".',
        },
      },
      required: ['expression'],
    },
  },
  async execute(input) {
    const { expression } = calculatorInput.parse(input);
    const result = evaluateExpression(expression);
    return JSON.stringify({ expression, result });
  },
};

// ---------------------------------------------------------------------------

const weatherInput = z.object({
  location: z.string().min(1).max(120),
});

/** Open-Meteo: a real public API, no key, generous free tier. Two hops —
 *  geocode the name, then fetch the forecast for those coordinates. */
const getWeather: ToolImplementation = {
  definition: {
    name: 'get_weather',
    description: 'Get the current weather for a city or place name.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City or place name, e.g. "Bengaluru" or "Lisbon, Portugal".' },
      },
      required: ['location'],
    },
  },
  async execute(input, ctx) {
    const { location } = weatherInput.parse(input);

    const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
    geoUrl.searchParams.set('name', location);
    geoUrl.searchParams.set('count', '1');

    const geoRes = await fetch(geoUrl, { signal: ctx.signal });
    if (!geoRes.ok) throw new Error(`Geocoding failed (${geoRes.status}).`);
    const geo = (await geoRes.json()) as {
      results?: Array<{ latitude: number; longitude: number; name: string; country: string }>;
    };

    const place = geo.results?.[0];
    if (!place) return JSON.stringify({ error: `No place found matching "${location}".` });

    const wxUrl = new URL('https://api.open-meteo.com/v1/forecast');
    wxUrl.searchParams.set('latitude', String(place.latitude));
    wxUrl.searchParams.set('longitude', String(place.longitude));
    wxUrl.searchParams.set('current', 'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code');

    const wxRes = await fetch(wxUrl, { signal: ctx.signal });
    if (!wxRes.ok) throw new Error(`Weather lookup failed (${wxRes.status}).`);
    const wx = (await wxRes.json()) as { current?: Record<string, number>; current_units?: Record<string, string> };

    return JSON.stringify({
      location: `${place.name}, ${place.country}`,
      temperatureC: wx.current?.temperature_2m,
      humidityPct: wx.current?.relative_humidity_2m,
      windSpeedKmh: wx.current?.wind_speed_10m,
      observedAt: new Date().toISOString(),
    });
  },
};

// ---------------------------------------------------------------------------

const searchInput = z.object({
  query: z.string().min(1).max(500),
  topK: z.number().int().min(1).max(20).optional(),
});

/** The RAG index, exposed as a tool so the model can decide to look something
 *  up mid-answer rather than only receiving a single pre-retrieved context. */
const searchDocuments: ToolImplementation = {
  definition: {
    name: 'search_documents',
    description:
      "Search the user's uploaded documents and return the most relevant passages with their chunk ids. Use this whenever the question might be answered by their files.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in natural language.' },
        topK: { type: 'integer', description: 'How many passages to return (1-20).' },
      },
      required: ['query'],
    },
  },
  async execute(input, ctx) {
    const { query, topK } = searchInput.parse(input);
    if (!ctx.collectionId) {
      return JSON.stringify({ error: 'No document collection is selected for this conversation.' });
    }

    const settings = { ...defaultRetrievalSettings(), ...(topK ? { topK } : {}) };
    // tenantId comes from the request context, never from the model's arguments
    // — otherwise the model could be talked into reading another tenant's index.
    const results = await retrieve({
      tenantId: ctx.tenantId,
      collectionId: ctx.collectionId,
      query,
      settings,
      embeddingModelId: ctx.embeddingModelId,
    });

    ctx.onRetrieved?.(results);

    return JSON.stringify({
      query,
      results: results.map((r, i) => ({
        citation: i + 1,
        chunkId: r.id,
        source: r.filename,
        section: r.locator,
        similarity: Number(r.similarity.toFixed(4)),
        text: r.text,
      })),
    });
  },
};

// ---------------------------------------------------------------------------

export const TOOLS: Record<string, ToolImplementation> = {
  calculator: calculator,
  get_weather: getWeather,
  search_documents: searchDocuments,
};

export function toolDefinitions(names?: string[]): ToolDefinition[] {
  const selected = names?.length ? names : Object.keys(TOOLS);
  return selected.flatMap((n) => (TOOLS[n] ? [TOOLS[n]!.definition] : []));
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<{ content: string; isError: boolean }> {
  const tool = TOOLS[name];
  if (!tool) return { content: `Unknown tool "${name}".`, isError: true };

  try {
    return { content: await tool.execute(input, ctx), isError: false };
  } catch (e) {
    // The error goes BACK TO THE MODEL as a tool result, not up as an
    // exception: a model that gets "division by zero" can correct itself, and
    // throwing here would lose the whole turn.
    const message = e instanceof z.ZodError ? `Invalid arguments: ${e.issues.map((i) => i.message).join('; ')}` : String(e instanceof Error ? e.message : e);
    return { content: JSON.stringify({ error: message }), isError: true };
  }
}
