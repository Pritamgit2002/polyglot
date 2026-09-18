# AI usage

Claude Code wrote the code. I set the architecture, the provider and tenancy
decisions, and ran the verification that found everything below. This doc is
short on purpose — the two things it needs to prove are what I rejected/fixed,
and that I can still explain and change any of it live.

---

## What I rejected

| Suggested                                      | Rejected because                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Vercel AI SDK / LangChain                       | Forbidden by the brief, and it removes the exact abstraction being graded.                     |
| Official vendor SDKs (`openai`, `@anthropic-ai/sdk`, …) | 3 different streaming/error/cancel models to normalize. Plain `fetch` + one SSE reader instead. |
| `tenant_id` filtered in app code                | One forgotten `WHERE` leaks everyone's data. Replaced with Postgres RLS, non-owner role.       |
| 3 near-identical provider adapters              | Same shape, different config. One `openai-compat` adapter driven by config instead.            |
| A registry map / barrel file                    | Adding a provider becomes a 2-file change. Adapters resolve by dynamic import instead.         |
| A separate vector DB (Qdrant/Chroma/FAISS)      | A second datastore = a second tenant-isolation story. `pgvector` stays in the same Postgres schema. |
| Ship all 5 OpenAI-compatible providers          | Scoped to 3 shipped. Groq/DeepSeek proven via the same adapter, not configured with live keys.  |

---

## What it got wrong (and how it was caught)

| # | Bug | Fix |
| - | --- | --- |
| 1 | Usage fields treated as equivalent across vendors (cache tokens, reasoning tokens counted differently) | Normalized to one convention, asserted in each adapter's tests |
| 2 | SSE reader didn't buffer across chunk boundaries — dropped frames split across TCP reads | Fixed; test now splits fixture frames mid-frame |
| 3 | `postJson` cleared its timeout on response headers, killing slow streams mid-stream | Timer ownership handed to the stream reader via `dispose()` |
| 4 | Cancel button did nothing — listened on a `close` event that never fires | Listens on the response stream instead, guarded by `writableEnded` |
| 5 | Cancelled requests were retried and re-billed as "retryable server error" | Classified as `cancelled`; cost still recorded from streamed chars |
| 6 | `enabledTools: []` was falsy, so it served **all** tools instead of none | `undefined` = no preference, `[]` = none |
| 7 | Citations pointed at the last heading in a chunk, not the one it opened under | Track the opening heading instead |
| 8 | Forcing RLS on `tenants` deadlocked provisioning (can't scope a lookup by the thing being looked up) | `tenants`/`tenant_access_log` are control-plane: RLS enabled, not forced; access via `GRANT` |
| 9 | Metrics panel kept showing the previous tenant's spend after switching (UI only, server was correct) | Refetch on tenant switch |
| 10 | System prompt named its own delimiter, so a hostile doc could spoof it | Reworded the prompt, not the test |
| 11 | Docs described an audit trail (`tenant_access_log`) that nothing wrote to | Implemented it |
| 12 | Fallback chain silently served a broken model from a different provider, so tests "passed" | Verification now forces `fallbackChain: []` and asserts `metrics.modelId` |
| 13 | Gemini cached-input pricing was 2.5× too high; several context-window figures were stale | Re-verified against live APIs, sources logged in `PROVIDER_NOTES.md` |

---

## Live-session prep

Four things I'd expect to be asked to do, and how I'd approach each:

| Topic | Approach |
| ----- | -------- |
| **Add a new provider** | One `models.json` entry (`baseUrl`, `apiKeyEnv`, `adapter`) + an env var. OpenAI-compatible → zero code. Otherwise, a new adapter file matching the shared interface; `registry.ts` picks it up by dynamic import, nothing else changes. |
| **Change retrieval behavior** | Chunk size / `topK` / similarity threshold live in `collections.settings` (jsonb), editable per collection, bounds checked server-side. Changing settings doesn't retroactively re-chunk existing documents — that needs a re-ingest. |
| **Debug a broken/misbehaving model** | Check `extra` on that model in `models.json` first (e.g. `maxTokensField`, `paramsWhenToolsPresent`) — most vendor quirks are config, not code. Set `fallbackChain: []` so a broken model can't hide behind a silent fallback. |
| **Debug or prove tenant isolation** | Confirm `withTenant()` set `app.current_tenant` for that transaction; the table's RLS policy checks `tenant_id = current_tenant_id()`. `tenants` and `tenant_access_log` are the deliberate exception — RLS enabled but not forced, access controlled by `GRANT` instead. |
