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
import RetrievalSettings from './RetrievalSettings';
import ThemeToggle from './ThemeToggle';
import Markdown from './Markdown';

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
const COMPOSER_MAX_PX = 200;
const ALL_TOOLS = ['calculator', 'get_weather', 'search_documents'];
const SUGGESTIONS = [
  'What is 1847 × 23? Use the calculator.',
  'What is the weather in Reykjavik right now?',
  'Summarise my uploaded documents.',
];

type Tab = 'sources' | 'usage' | 'retrieval';

export default function Chat() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState('');
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [tenant, setTenantState] = useState('acme');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('usage');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  // null = not naming a collection; a string = the in-progress name.
  const [newCollection, setNewCollection] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // ---- bootstrap ----------------------------------------------------------
  useEffect(() => {
    setTenantState(getTenant());
    api
      .models()
      .then((r) => {
        setModels(r.models);
        setModelId(r.models.find((m) => m.configured)?.id ?? r.defaults.chatModel);
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  // Grow the composer with its content, up to a cap.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;

    // Collapse to zero BEFORE measuring. scrollHeight is always >=
    // clientHeight, so measuring while the element still carries its previous
    // inline height reports that height straight back — and writing it again
    // ratchets the box open permanently. One bad frame and an empty composer
    // is stuck at the maximum forever, because every later pass measures the
    // value it just wrote. Starting from 0 makes the measurement depend only
    // on the content.
    ta.style.height = '0px';
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [input]);

  // ---- conversations ------------------------------------------------------
  async function openConversation(id: string) {
    setConversationId(id);
    setCitations([]);
    const detail = await api.conversation(id);
    // Rebuilt from persisted provider-agnostic blocks — which is why a
    // conversation survives a reload AND a provider switch.
    setTurns(
      detail.messages
        .filter((m) => m.role !== 'tool')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          text: m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
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

  function newConversation() {
    setConversationId(null);
    setTurns([]);
    setCitations([]);
    setError(null);
  }

  // ---- send ---------------------------------------------------------------
  async function send(text?: string) {
    const body = (text ?? input).trim();
    if (!body || streaming) return;

    setError(null);
    setInput('');
    setStreaming(true);

    const convId = await ensureConversation();
    const controller = new AbortController();
    abortRef.current = controller;

    setTurns((t) => [
      ...t,
      { role: 'user', text: body, tools: [], notices: [] },
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
          content: [{ type: 'text', text: body }],
          ...(collectionId ? { collectionId } : {}),
          enabledTools: toolsEnabled ? ALL_TOOLS : [],
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
              setTab('sources');
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
      // The first turn names the conversation server-side, so re-read the list
      // rather than guessing the title on the client.
      api.conversations().then(setConversations).catch(() => {});
    }
  }

  /** Aborting the fetch closes the socket, which the API turns into an abort on
   *  the upstream provider request. Stopping the render is not enough. */
  function stop() {
    abortRef.current?.abort();
  }

  /** Collections stay the unit of retrieval, but a first upload should not
   *  dead-end on an empty picker: with nothing selected we create the default
   *  collection and index into it. */
  async function upload(file: File) {
    setUploading(true);
    try {
      let target = collectionId;
      if (!target) {
        const created = await api.createCollection('My Documents');
        setCollections((c) => [created, ...c]);
        setCollectionId(created.id);
        target = created.id;
      }
      await api.uploadDocument(target, file);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setUploading(false);
    }
  }

  /** Named inline rather than through window.prompt(): prompt() is blocked
   *  outright in sandboxed iframes and embedded webviews, where it throws and
   *  leaves the button looking simply dead. */
  async function createCollection(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const created = await api.createCollection(trimmed);
      setCollections((c) => [created, ...c]);
      setCollectionId(created.id);
      setNewCollection(null);
      setTab('retrieval');
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  const selected = models.find((m) => m.id === modelId);
  const selectedCollection = collections.find((c) => c.id === collectionId);
  const toolsSupported = selected?.capabilities.tools ?? true;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">P</span>
          Polyglot
        </div>

        <div className="divider" />

        <select
          value={tenant}
          onChange={(e) => {
            setTenant(e.target.value);
            setTenantState(e.target.value);
            newConversation();
          }}
          title="Tenant — every request carries this, and Postgres enforces it"
        >
          {TENANTS.map((t) => (
            <option key={t} value={t}>
              ◆ {t}
            </option>
          ))}
        </select>

        <select value={modelId} onChange={(e) => setModelId(e.target.value)} title="Switchable between messages">
          {models.map((m) => (
            <option key={m.id} value={m.id} disabled={!m.configured}>
              {m.displayName}
              {m.configured ? '' : ' — no key'}
            </option>
          ))}
        </select>

        <div className="grow" />

        <select value={conversationId ?? ''} onChange={(e) => (e.target.value ? openConversation(e.target.value) : newConversation())}>
          <option value="">＋ New conversation</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>

        <button className="btn btn-icon only-narrow" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle panel">
          ☰
        </button>

        <ThemeToggle />
      </header>

      <div className="body">
        <main className="chat">
          {error && (
            <div style={{ padding: '10px 20px 0' }}>
              <div className="notice error">{error}</div>
            </div>
          )}

          <div className="messages">
            <div className="stream">
              {turns.length === 0 && (
                <div className="empty">
                  <h2>One interface, three providers</h2>
                  <p>
                    Switch model or tenant between messages — the conversation continues either way, because history is
                    stored in a provider-agnostic format.
                  </p>
                  <div className="suggestions">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} className="suggestion" onClick={() => void send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {turns.map((turn, i) => {
                const isLast = i === turns.length - 1;
                return (
                  <div key={i} className={`msg ${turn.role}`}>
                    <div className="msg-head">
                      <span className="avatar">{turn.role === 'user' ? 'U' : 'P'}</span>
                      <span className="role">{turn.role === 'user' ? 'You' : 'Assistant'}</span>
                      {turn.modelId && <span className="model-tag">{turn.modelId}</span>}
                    </div>

                    {turn.notices.map((n, j) => (
                      <div key={j} className={`notice ${n.level === 'warn' ? 'warn' : 'info'}`}>
                        {n.message}
                      </div>
                    ))}

                    {turn.tools.map((t, j) => (
                      <div key={j} className="tool" data-status={t.status}>
                        <div className="tool-head">
                          {t.status === 'running' || t.status === 'started' ? <span className="spinner" /> : null}
                          <span className="tool-name">{t.name}</span>
                          <span className={`chip ${t.status === 'error' ? 'error' : t.status === 'done' ? 'ok' : ''}`}>{t.status}</span>
                        </div>
                        {t.input ? <pre>{JSON.stringify(t.input)}</pre> : null}
                        {t.output ? <pre>{t.output.slice(0, 400)}</pre> : null}
                      </div>
                    ))}

                    <div className="bubble">
                      {/* User text stays verbatim — they typed it, and markdown
                          in a question is almost always literal. Assistant text
                          is rendered, streaming-safe. */}
                      {turn.role === 'user' ? turn.text : <Markdown text={turn.text} />}
                      {turn.role === 'assistant' && isLast && streaming && <span className="caret" />}
                    </div>

                    {turn.error && <div className="notice error" style={{ marginTop: 10 }}>{turn.error}</div>}

                    {turn.metrics && (
                      <div className="meta-row">
                        <span className="chip">{turn.metrics.provider}</span>
                        <span className="chip mono">ttft {turn.metrics.ttftMs ?? '—'}ms</span>
                        <span className="chip mono">{turn.metrics.totalMs}ms total</span>
                        <span className="chip mono">
                          {turn.metrics.usage.inputTokens}↓ {turn.metrics.usage.outputTokens}↑
                        </span>
                        <span className="chip cost">${turn.metrics.costUsd.toFixed(6)}</span>
                        {turn.metrics.retryCount > 0 && <span className="chip warn">{turn.metrics.retryCount} retries</span>}
                        {turn.metrics.fallbackFrom && <span className="chip warn">↩ from {turn.metrics.fallbackFrom}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className="composer-wrap">
            <div className="composer-inner">
              <div className="composer-tools">
                <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)} title="Ground answers in a document collection">
                  <option value="">No documents</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>

                {newCollection === null ? (
                  <button className="btn" onClick={() => setNewCollection('')}>
                    ＋ Collection
                  </button>
                ) : (
                  <>
                    <input
                      className="input"
                      autoFocus
                      placeholder="Collection name"
                      value={newCollection}
                      style={{ width: 150 }}
                      onChange={(e) => setNewCollection(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createCollection(newCollection);
                        if (e.key === 'Escape') setNewCollection(null);
                      }}
                      onBlur={() => {
                        if (!newCollection.trim()) setNewCollection(null);
                      }}
                    />
                    <button
                      className="btn"
                      onClick={() => void createCollection(newCollection)}
                      disabled={!newCollection.trim()}
                    >
                      Add
                    </button>
                  </>
                )}

                <label className="btn" style={{ cursor: uploading ? 'not-allowed' : 'pointer', opacity: uploading ? 0.5 : 1 }}>
                  {uploading ? <span className="spinner" /> : '⇪'} {uploading ? 'Indexing…' : 'Upload'}
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,.markdown"
                    hidden
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(f);
                      e.target.value = '';
                    }}
                  />
                </label>

                <button
                  className="chip chip-toggle"
                  data-on={toolsEnabled && toolsSupported}
                  disabled={!toolsSupported}
                  onClick={() => setToolsEnabled((v) => !v)}
                  title={toolsSupported ? 'calculator · get_weather · search_documents' : 'This model does not support tool calling'}
                >
                  ⚙ Tools {toolsSupported ? (toolsEnabled ? 'on' : 'off') : 'unsupported'}
                </button>
              </div>

              <div className="composer">
                <textarea
                  ref={taRef}
                  rows={1}
                  value={input}
                  placeholder="Ask anything…"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                {streaming ? (
                  <button className="btn btn-danger" onClick={stop}>
                    ■ Stop
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={() => void send()} disabled={!input.trim() || !modelId}>
                    Send ↵
                  </button>
                )}
              </div>

              <div className="hint">
                <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line · Stop aborts the upstream
                request, not just the render
              </div>
            </div>
          </div>
        </main>

        <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
          <div className="tabs" role="tablist">
            {(
              [
                ['sources', 'Sources', citations.length],
                ['usage', 'Usage', 0],
                ['retrieval', 'Retrieval', 0],
              ] as const
            ).map(([key, label, count]) => (
              <button key={key} role="tab" aria-selected={tab === key} className="tab" onClick={() => setTab(key as Tab)}>
                {label}
                {count > 0 && <span className="count">{count}</span>}
              </button>
            ))}
          </div>

          <div className="tabpanel" key={tab}>
            {tab === 'sources' && <Citations citations={citations} />}
            {tab === 'usage' && <MetricsPanel refreshKey={turns.length} tenant={tenant} />}
            {tab === 'retrieval' && (
              <RetrievalSettings
                collection={selectedCollection}
                onSaved={(updated) => setCollections((cs) => cs.map((c) => (c.id === updated.id ? updated : c)))}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
