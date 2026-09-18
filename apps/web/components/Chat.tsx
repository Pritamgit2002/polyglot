'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  getTenant,
  setTenant,
  streamChat,
  type ClientEvent,
  type Collection,
  type ConversationSummary,
  type ModelInfo,
} from '@/lib/api';
import MetricsPanel from './MetricsPanel';
import Citations, { type Citation } from './Citations';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  modelId?: string;
  tools: Array<{ id: string; name: string; status: string; input?: unknown; output?: string }>;
  notices: Array<{ level: string; message: string }>;
  metrics?: Extract<ClientEvent, { type: 'metrics' }>['metrics'];
  error?: string;
}

const TENANTS = ['acme', 'globex'];

export default function Chat() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState<string>('');
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [tenant, setTenantState] = useState('acme');
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ---- bootstrap ----------------------------------------------------------
  useEffect(() => {
    setTenantState(getTenant());
    api
      .models()
      .then((r) => {
        setModels(r.models);
        const firstConfigured = r.models.find((m) => m.configured);
        setModelId(firstConfigured?.id ?? r.defaults.chatModel);
      })
      .catch((e) => setError(String(e.message)));
  }, []);

  const refreshTenantData = useCallback(async () => {
    try {
      const [convos, cols] = await Promise.all([api.conversations(), api.collections()]);
      setConversations(convos);
      setCollections(cols);
      setCollectionId('');
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  useEffect(() => {
    void refreshTenantData();
  }, [tenant, refreshTenantData]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  // ---- conversation loading ----------------------------------------------
  async function openConversation(id: string) {
    setConversationId(id);
    setCitations([]);
    const detail = await api.conversation(id);
    // Rebuild the visible transcript from persisted provider-agnostic blocks —
    // this is why conversations survive a reload and a provider switch.
    setTurns(
      detail.messages
        .filter((m) => m.role !== 'tool')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          text: m.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join(''),
          modelId: m.modelId ?? undefined,
          tools: m.content
            .filter((b) => b.type === 'tool_use')
            .map((b) => ({ id: '', name: b.name ?? '', status: 'done', input: b.input })),
          notices: [],
        })),
    );
  }

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const created = await api.createConversation();
    setConversationId(created.id);
    setConversations((c) => [created, ...c]);
    return created.id;
  }

  // ---- send ---------------------------------------------------------------
  async function send() {
    const text = input.trim();
    if (!text || streaming) return;

    setError(null);
    setInput('');
    setStreaming(true);

    const convId = await ensureConversation();
    const controller = new AbortController();
    abortRef.current = controller;

    setTurns((t) => [
      ...t,
      { role: 'user', text, tools: [], notices: [] },
      { role: 'assistant', text: '', modelId, tools: [], notices: [] },
    ]);

    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((t) => {
        const next = [...t];
        next[next.length - 1] = fn(next[next.length - 1]!);
        return next;
      });

    try {
      await streamChat(
        {
          conversationId: convId,
          modelId,
          content: [{ type: 'text', text }],
          ...(collectionId ? { collectionId } : {}),
          ...(toolsEnabled ? { enabledTools: ['calculator', 'get_weather', 'search_documents'] } : {}),
        },
        controller.signal,
        (event) => {
          switch (event.type) {
            case 'text':
              patch((t) => ({ ...t, text: t.text + event.text }));
              break;
            case 'tool_call':
              patch((t) => {
                const tools = [...t.tools];
                const i = tools.findIndex((x) => x.id === event.id);
                const entry = { id: event.id, name: event.name, status: event.status, input: event.input, output: event.output };
                if (i === -1) tools.push(entry);
                else tools[i] = { ...tools[i]!, ...entry };
                return { ...t, tools };
              });
              break;
            case 'citations':
              setCitations(event.chunks);
              break;
            case 'notice':
              patch((t) => ({ ...t, notices: [...t.notices, event] }));
              break;
            case 'metrics':
              patch((t) => ({ ...t, metrics: event.metrics }));
              break;
            case 'error':
              patch((t) => ({ ...t, error: `${event.kind}: ${event.message}` }));
              break;
          }
        },
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(String((e as Error).message));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  /** Aborting the fetch closes the socket, which the API turns into an abort on
   *  the upstream provider request. Stopping the render is not enough. */
  function stop() {
    abortRef.current?.abort();
  }

  async function upload(file: File) {
    if (!collectionId) {
      setError('Create or select a collection first.');
      return;
    }
    try {
      await api.uploadDocument(collectionId, file);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  const selected = models.find((m) => m.id === modelId);

  return (
    <div className="layout">
      <div className="main">
        <div className="toolbar">
          <span className="brand">Polyglot</span>

          <select
            value={tenant}
            onChange={(e) => {
              setTenant(e.target.value);
              setTenantState(e.target.value);
              setConversationId(null);
              setTurns([]);
              setCitations([]);
            }}
            title="Tenant — every request carries this, and the database enforces it"
          >
            {TENANTS.map((t) => (
              <option key={t} value={t}>
                tenant: {t}
              </option>
            ))}
          </select>

          <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.configured}>
                {m.displayName}
                {m.configured ? '' : ' — no API key'}
              </option>
            ))}
          </select>

          <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
            <option value="">no documents</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <button
            onClick={async () => {
              const name = prompt('Collection name');
              if (!name) return;
              const created = await api.createCollection(name);
              setCollections((c) => [created, ...c]);
              setCollectionId(created.id);
            }}
          >
            + collection
          </button>

          <label className="chip">
            <input
              type="checkbox"
              checked={toolsEnabled}
              onChange={(e) => setToolsEnabled(e.target.checked)}
              disabled={!selected?.capabilities.tools}
            />
            tools
            {selected && !selected.capabilities.tools ? ' (unsupported)' : ''}
          </label>

          <input
            type="file"
            accept=".pdf,.txt,.md,.markdown"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            style={{ maxWidth: 190 }}
          />

          <div className="spacer" />

          <select
            value={conversationId ?? ''}
            onChange={(e) => (e.target.value ? openConversation(e.target.value) : (setConversationId(null), setTurns([])))}
          >
            <option value="">new conversation</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div style={{ padding: '8px 16px', color: 'var(--error)' }}>{error}</div>
        )}

        <div className="messages">
          {turns.map((turn, i) => (
            <div key={i} className={`msg ${turn.role}`}>
              <div className="who">
                {turn.role}
                {turn.modelId ? ` · ${turn.modelId}` : ''}
              </div>

              {turn.notices.map((n, j) => (
                <div key={j} className={`chip ${n.level === 'warn' ? 'warn' : ''}`} style={{ marginBottom: 6 }}>
                  {n.message}
                </div>
              ))}

              {turn.tools.map((t, j) => (
                <div key={j} className="tool">
                  <span className="name">{t.name}</span>{' '}
                  <span className={`chip ${t.status === 'error' ? 'error' : t.status === 'done' ? 'ok' : ''}`}>{t.status}</span>
                  {t.input ? <pre>{JSON.stringify(t.input)}</pre> : null}
                  {t.output ? <pre>{t.output.slice(0, 400)}</pre> : null}
                </div>
              ))}

              <div className="body">{turn.text}</div>

              {turn.error && <div className="chip error" style={{ marginTop: 8 }}>{turn.error}</div>}

              {turn.metrics && (
                <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="chip">{turn.metrics.provider}</span>
                  <span className="chip">ttft {turn.metrics.ttftMs ?? '—'} ms</span>
                  <span className="chip">total {turn.metrics.totalMs} ms</span>
                  <span className="chip">
                    {turn.metrics.usage.inputTokens} in / {turn.metrics.usage.outputTokens} out
                  </span>
                  <span className="chip">${turn.metrics.costUsd.toFixed(6)}</span>
                  {turn.metrics.retryCount > 0 && <span className="chip warn">{turn.metrics.retryCount} retries</span>}
                  {turn.metrics.fallbackFrom && <span className="chip warn">fell back from {turn.metrics.fallbackFrom}</span>}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          <textarea
            value={input}
            placeholder="Ask something. Switch model or tenant between messages — the conversation continues."
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {streaming ? (
            <button onClick={stop}>Stop</button>
          ) : (
            <button onClick={() => void send()} disabled={!input.trim() || !modelId}>
              Send
            </button>
          )}
        </div>
      </div>

      <div className="side">
        <Citations citations={citations} />
        <MetricsPanel refreshKey={turns.length} />
      </div>
    </div>
  );
}
