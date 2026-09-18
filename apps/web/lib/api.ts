/**
 * Thin client. Every call carries the tenant header; nothing else in the app
 * decides tenancy, so there is exactly one place to change when this becomes a
 * real session cookie.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function getTenant(): string {
  if (typeof window === 'undefined') return 'acme';
  return window.localStorage.getItem('polyglot.tenant') ?? 'acme';
}

export function setTenant(slug: string): void {
  window.localStorage.setItem('polyglot.tenant', slug);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': getTenant(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  models: () => request<ModelsResponse>('/api/models'),
  conversations: () => request<ConversationSummary[]>('/api/conversations'),
  createConversation: () => request<ConversationSummary>('/api/conversations', { method: 'POST', body: '{}' }),
  conversation: (id: string) => request<ConversationDetail>(`/api/conversations/${id}`),
  collections: () => request<Collection[]>('/api/collections'),
  createCollection: (name: string) =>
    request<Collection>('/api/collections', { method: 'POST', body: JSON.stringify({ name }) }),
  metricsSummary: () => request<MetricsSummary>('/api/metrics/summary'),
  metricsRequests: () => request<RequestLog[]>('/api/metrics/requests'),

  uploadDocument: async (collectionId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/api/collections/${collectionId}/documents`, {
      method: 'POST',
      headers: { 'x-tenant-id': getTenant() },
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message ?? 'Upload failed.');
    }
    return res.json();
  },
};

/**
 * Streams the chat response.
 *
 * This is a hand-rolled SSE reader over fetch rather than EventSource because
 * EventSource cannot POST and cannot send headers — and we need both. The
 * AbortSignal is passed straight to fetch so the socket closes, which is what
 * makes the server abort the upstream provider call.
 */
export async function streamChat(
  body: ChatRequestBody,
  signal: AbortSignal,
  onEvent: (event: ClientEvent) => void,
): Promise<void> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': getTenant() },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Chat failed (${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // The buffer must survive across reads: a frame can be split mid-token.
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(5).trim()) as ClientEvent);
    }
  }
}

// ---------------------------------------------------------------------------
// types shared with the API (kept narrow on purpose)
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: { tools: boolean; vision: boolean; jsonSchema: boolean; streaming: boolean };
  pricing: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number };
  configured: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
  defaults: { chatModel: string; fallbackChain: string[]; retrieval: Record<string, number> };
}

export interface ConversationSummary {
  id: string;
  title: string;
  lastModelId: string | null;
  updatedAt: string;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: Array<{ id: string; role: string; content: ContentBlockDto[]; modelId: string | null; createdAt: string }>;
}

export interface ContentBlockDto {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: string;
  isError?: boolean;
}

export interface Collection {
  id: string;
  name: string;
  embeddingModelId: string;
  settings: Record<string, number>;
}

export interface RequestLog {
  id: string;
  modelId: string;
  provider: string;
  ttftMs: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  finishReason: string;
  retryCount: number;
  fallbackFrom: string | null;
  createdAt: string;
}

export interface MetricsSummary {
  byProvider: Array<{
    provider: string;
    requests: number;
    totalCostUsd: string | null;
    avgTotalMs: string | null;
    avgTtftMs: string | null;
  }>;
  totals: { requests: number; costUsd: number };
}

export interface ChatRequestBody {
  conversationId: string;
  modelId: string;
  content: Array<{ type: 'text'; text: string }>;
  collectionId?: string;
  enabledTools?: string[];
}

export type ClientEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; status: string; input?: unknown; output?: string }
  | { type: 'citations'; chunks: Array<{ id: string; index: number; filename: string; locator: string | null; text: string; similarity: number }> }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | { type: 'metrics'; metrics: { provider: string; modelId: string; ttftMs: number | null; totalMs: number; costUsd: number; usage: { inputTokens: number; outputTokens: number }; retryCount: number; fallbackFrom: string | null } }
  | { type: 'error'; kind: string; message: string }
  | { type: 'done'; messageId: string | null };
