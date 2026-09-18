# Polyglot — Multi-Provider AI Workbench

One interface, several providers, several tenants, full visibility into what
every request costs and how long it took.

---

## Setup (under 5 minutes)

**Prerequisites:** Node 20+, and Postgres 14+ with the `pgvector` extension.

```bash
git clone <this-repo> && cd polyglot
npm install
cp .env.example .env          # then fill in at least one provider key
npm run db:push               # extensions, tables, roles, RLS policies, vector index
npm run db:seed               # creates the "acme" and "globex" demo tenants
npm run dev                   # api on :3001, web on :3000
```

Open <http://localhost:3000>.

**No Postgres handy?** `docker compose up -d` starts one with pgvector
preinstalled, matching the default `DATABASE_URL`.

**On macOS with Homebrew Postgres:**

```bash
brew install pgvector && brew services start postgresql@18
createdb polyglot && createuser -s polyglot
```

### Verify without touching a provider

```bash
npm test            # 43 tests, all adapter behaviour against mocked HTTP
npm run check-types
npm run verify      # resolves every configured provider to its adapter, prints the cost maths
```

The adapter tests use recorded request/response fixtures, so they prove the
request and response mapping is correct with **no API keys and no network**.

---

## What is implemented

### Providers

| Provider | Adapter file | Status |
|---|---|---|
| Anthropic | `adapters/anthropic.ts` | Full — complete + stream + tools |
| Google Gemini | `adapters/gemini.ts` | Full — complete + stream + tools + embeddings |
| OpenAI | `adapters/openai-compat.ts` | Full — complete + stream + tools + embeddings |
| Groq | `adapters/openai-compat.ts` | Full, via the shared OpenAI-compatible adapter |
| DeepSeek | `adapters/openai-compat.ts` | Full, incl. separate `reasoning_content` |

Five providers, three adapter files. OpenAI, Groq and DeepSeek share one
adapter because their differences are genuinely configuration (base URL, usage
location, `stream_options` support), not shape — and three near-identical files
would be the copy-paste anti-pattern the brief warns about.

> **Live-key testing:** _[Update this line before submitting.]_ Fill in which
> providers you exercised against real keys and which were verified only by
> fixture test. Do not claim more than you ran.

### Modules

| Module | Status | Notes |
|---|---|---|
| **A — Provider abstraction** | **Done** | The contract, the three adapters, dynamic registry, config-driven models and pricing, normalized error taxonomy, 33 adapter/core tests. |
| **B — Chat with true streaming** | **Done** | SSE, token-by-token. Provider and model switchable between messages inside one conversation. Persisted in Postgres. Stop aborts the upstream request. Context overflow truncates oldest-first and says so in the UI. |
| **C — RAG** | **Mostly done** | PDF/TXT/MD upload, paragraph-aware chunking with overlap, pgvector cosine retrieval, inline citations, chunk text visible in the UI, explicit "I don't know" grounding. **Cut:** runtime tuning of chunk size / top-k from the UI — the values are configurable per collection through the API and `models.json`, but there are no sliders. |
| **D — Tool calling** | **Done** | `calculator`, `get_weather`, `search_documents`. One definition format, translated per provider. Multi-round loop, streamed and accumulated arguments, graceful degradation when a model has no tool support. |
| **E — Observability & resilience** | **Done** | Per-request TTFT, total latency, tokens (incl. cached/reasoning), USD cost, finish reason, retry count, fallback flag. Aggregate spend and latency by provider. Exponential backoff with full jitter on `rate_limit`/`server_error`/`timeout` only. Configurable fallback chain, surfaced in the UI when it fires. |

### Cut deliberately

- **Optional extras.** None of Section 6 is built. Structured output has adapter
  support (`responseSchema` maps to Anthropic tool-forcing, Gemini's
  `responseSchema` and OpenAI's `json_schema`) but no UI or validation-retry
  loop.
- **Background ingestion.** Uploads are processed synchronously in the request.
  The `status` column exists precisely so this can become a queue without a
  schema change.
- **Authentication.** The tenant comes from an `x-tenant-id` header. A caller
  can forge it. That is a deliberate take-home simplification and the
  enforcement model is designed so replacing it touches one file — see
  `docs/DESIGN.md`.
- **UI polish.** Plain CSS, no markdown rendering, no virtualized transcript.
  Adapter quality was protected above UI, per the brief's own advice.

---

## Adding a fourth provider

Two things, and nothing else in the codebase changes:

1. **One file:** `packages/providers/src/adapters/<name>.ts`, default-exporting
   an object that satisfies `Provider`.
2. **One config block** in `packages/config/models.json` — a `providers` entry
   naming that adapter and the env var holding its key, plus a `models` entry
   per model you want to expose.

There is no barrel file, no `switch`, and no registration call. The registry
resolves the adapter by dynamic import from the `adapter` field in config.
Worked example in `docs/DESIGN.md`.

---

## Layout

```
apps/
  api/        Fastify: SSE chat, RAG, metrics, tenant guard, tools
  web/        Next.js 15 App Router: chat UI, citations, metrics panel
packages/
  core/       The contract: types, error taxonomy, config loader, cost, retry
  providers/  Adapters + registry + orchestrator (retry, fallback, timeouts)
  db/         Drizzle schema, RLS policies, tenant-scoped client
  config/     models.json — models, capabilities, pricing, defaults
docs/
  DESIGN.md           architecture, tenant model, security posture, decisions
  PROVIDER_NOTES.md   the concrete API differences and how they were reconciled
  AI_USAGE.md         what AI assistance was used for, and what was rejected
```

## Notable constraint

**No provider-abstraction framework is used.** No LangChain, no LlamaIndex, no
Vercel AI SDK, no LiteLLM, no OpenRouter. The HTTP calls, the SSE parsing and
the streaming are hand-written, because the abstraction is the assignment.
