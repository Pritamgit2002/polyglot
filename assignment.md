# Take-Home Assignment — "Polyglot" Multi-Provider AI Workbench

---

## 1. Why this assignment exists

We want to see whether you can design and ship a production-shaped AI system, not whether you can call an LLM API. Anyone can `POST /v1/chat/completions`. What we are looking for is:

- Can you design an abstraction that survives contact with providers whose APIs genuinely disagree with each other?
- Do you understand streaming, token accounting, cost, latency, retries, and failure modes?
- Do you understand retrieval — chunking, embeddings, ranking, citations — rather than pasting a document into the prompt?
- Do you understand tool calling, and how it differs across vendors?
- Do you build securely and multi-tenant-safely by default, without being told to?
- Can you scope aggressively and finish?

If you have not worked with LLMs professionally before, this assignment is still passable. It is designed so that a strong engineer who reads the provider docs carefully can build a solid core in a week of evenings. We are testing engineering judgment applied to AI, not memorized trivia.

---

## 2. The scenario

You have joined a team that ships AI features to enterprise customers. Customers refuse to be locked into a single model vendor — for cost, for data-residency and compliance, for latency in specific regions, and because a provider outage cannot take the product down.

Your job is to build **Polyglot**, the internal workbench that the product teams will build on top of: one interface, several providers, several tenants, full visibility into what every request costs and how long it took.

---

## 3. What you must build

A working web application (backend + frontend) that does the following.

### Module A — Provider abstraction layer _(the most important module)_

**Implement at least three of these five providers:**

| Provider      | Notes                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Anthropic     | Messages API — note `system` is a top-level param, not a message                                                   |
| Google Gemini | `generateContent` / `streamGenerateContent` — different role names, different content shape, different tool schema |
| OpenAI        | Native `/v1/chat/completions` or Responses API                                                                     |
| Groq          | OpenAI-compatible surface, but not identical; different models, different rate limits                              |
| DeepSeek      | OpenAI-compatible surface; reasoning models expose separate reasoning content                                      |

**Your three must include Anthropic and Gemini, plus at least one of OpenAI / Groq / DeepSeek.** This is not arbitrary. OpenAI, Groq and DeepSeek share a broadly compatible request shape, so building only those three would let you skip the actual problem. Anthropic and Gemini each diverge in ways your abstraction has to absorb. Implement more than three if you want — extra providers are a plus, not a requirement.

#### The contract

There is no seed repository. The contract is defined here, in prose plus an illustrative TypeScript sketch. **If you are working in another language, translate it.** The shapes matter; the syntax does not.

This is a starting point, not a cage. Extend it where you need to. If you change something fundamental, say so in `docs/DESIGN.md` and explain why.

```ts
// ---------- provider-agnostic message format ----------
type Role = "user" | "assistant" | "tool";

interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  // text
  text?: string;
  // image
  mimeType?: string;
  data?: string; // base64
  // tool_use  (assistant asking for a tool)
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result (your answer back to the model)
  toolUseId?: string;
  content?: string;
  isError?: boolean;
}

interface Message {
  role: Role;
  content: ContentBlock[]; // always an array, even for plain text
}

// ---------- the call ----------
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

interface CompletionRequest {
  model: string; // your internal id, e.g. "anthropic:claude-sonnet-4-6"
  messages: Message[];
  system?: string; // top-level on purpose: Anthropic wants it there,
  // others need it folded into messages. That is the adapter's job.
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal; // cancellation must reach the upstream request
}

// ---------- what comes back ----------
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialJson: string } // arrives in fragments
  | {
      type: "tool_use_complete";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: FinishReason }
  | { type: "error"; error: ProviderError };

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number; // where the provider reports it
  reasoningTokens?: number; // where the provider reports it
}

type FinishReason =
  | "stop"
  | "max_tokens"
  | "tool_use"
  | "content_filter"
  | "error";

// ---------- the interface every adapter implements ----------
interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  stream(req: CompletionRequest): AsyncIterable<StreamEvent>;
  embed?(texts: string[], model: string): Promise<number[][]>;
}

// ---------- normalized errors ----------
type ErrorKind =
  | "auth"
  | "rate_limit"
  | "context_length"
  | "content_filter"
  | "timeout"
  | "server_error"
  | "bad_request";

interface ProviderError extends Error {
  kind: ErrorKind;
  provider: string;
  retryable: boolean;
  retryAfterMs?: number; // when the provider tells you
  raw?: unknown; // kept for logs, never sent to the client
}
```

**Model and pricing configuration lives in config, not code.** Something like:

```jsonc
{
  "anthropic:claude-sonnet-4-6": {
    "provider": "anthropic",
    "providerModelId": "claude-sonnet-4-6",
    "contextWindow": 200000,
    "capabilities": {
      "tools": true,
      "vision": true,
      "jsonSchema": true,
      "streaming": true,
    },
    "pricing": {
      "inputPerMTok": 3.0,
      "outputPerMTok": 15.0,
      "cachedInputPerMTok": 0.3,
    },
  },
}
```

Use real current prices from each provider's pricing page and cite where you got them in `docs/PROVIDER_NOTES.md`.

**Hard requirements:**

1. One interface, implemented once per provider.
2. **Adding one more provider must mean adding one new file and one config entry. Nothing else in the codebase may change.** We will test this claim by asking you to add a fourth provider live, and it is scored (Section 10).
3. **You may not use LangChain, LlamaIndex, Vercel AI SDK, LiteLLM, OpenRouter, or any other framework that already abstracts providers for you.** Official first-party SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`) or plain HTTP are both fine. This rule exists because the abstraction _is_ the assignment.
4. Provider-agnostic internal message format. Conversion to and from vendor shapes happens only inside the adapter.
5. Models, context windows, capability flags and pricing live in **configuration**, not in code.
6. Errors are normalized into the taxonomy above. The rest of the app must never need to know which vendor threw.

### Module B — Chat with true streaming

- Token-by-token streaming to the browser over SSE or WebSocket. Not "await the whole response, then fake a typewriter effect."
- The user can switch provider **and** model between messages inside the same conversation, and the conversation continues coherently.
- Conversations persist across page reload. SQLite or Postgres is fine; JSON files on disk are not.
- Cancel/stop must actually abort the upstream request, not just stop rendering.
- Handle context-window overflow deliberately — truncate, summarize, or reject, but make the choice explicit and documented.

### Module C — Retrieval over user documents (RAG)

- Upload PDF / TXT / Markdown. Multiple files per collection.
- Chunk, embed, store, retrieve. Any vector store is fine: pgvector, Qdrant, Chroma, FAISS, LanceDB, or a hand-rolled one — your call, defend it.
- Answers must carry **inline citations** that map to the specific chunk, and the UI must let the user see the retrieved chunk text.
- Retrieval parameters (chunk size, overlap, top-k, similarity threshold) are configurable at runtime from the UI.
- The system must answer "I don't know" when retrieval returns nothing relevant. Grounding matters more than fluency.
- Embeddings: OpenAI or Gemini embeddings, or a local model — but the embedding provider must be swappable through the same abstraction pattern.

### Module D — Tool calling, normalized

Implement at least **three** tools and make them work on **at least two of the providers you built**, one of which must be Anthropic or Gemini:

1. `calculator` — evaluate an arithmetic expression (do not `eval()` raw user input)
2. `get_weather` — call a real public weather API
3. `search_documents` — query the RAG index from Module C as a tool

Requirements:

- One tool definition format in your code, translated per provider.
- Full multi-turn loop: model requests tool, you execute, you feed the result back, model answers. Support at least two sequential tool calls in one turn.
- Tool calls must stream too — arguments arrive in fragments and must be accumulated correctly.
- If a provider or model does not support tools, degrade gracefully and tell the user why.

### Module E — Observability and resilience

A metrics panel showing, per request:

- Provider, model, timestamp, tenant
- **Time to first token** and total latency
- Input tokens, output tokens, and cached/reasoning tokens where the provider reports them
- **Cost in USD**, computed from your pricing config
- Finish reason, retry count, whether a fallback was used

Plus:

- Retry with exponential backoff **and jitter** on `rate_limit` and `server_error` only. Never on `auth` or `bad_request`.
- A configurable **fallback chain**: if the primary provider fails, automatically try the next one and surface that this happened in the UI.
- Per-request timeouts.
- Aggregate view: total spend and average latency grouped by provider.

---

## 4. Multi-tenancy

Polyglot is used by several teams, and by several of your company's customers, from one deployment.

**Collections, documents, conversations and usage records belong to a tenant. A user from Tenant A must never be able to retrieve, cite, see, or be billed for anything belonging to Tenant B.**

A simple header or session-based tenant identifier is fine for a take-home. We do not need real authentication. What we care about is the enforcement model:

- Where does the tenant identifier come from on each request, and can a caller forge it?
- Where is the boundary actually enforced? Application code, the data layer, the database itself, or some combination?
- **A new engineer joins your team on Monday and writes a query. What stops them leaking data?**
- How would you know, in production, if it had ever leaked?

Answer these in `docs/DESIGN.md`. **Design for the boundary to be structurally true rather than conventionally true** — that distinction is most of what we are looking at here.

---

## 5. Architecture and security expectations

We are looking for a strong, secure architecture. We are deliberately not giving you a checklist of security features, because we want to see what you do without being told. A senior engineer should not need to be reminded of most of this.

At minimum we expect the system to hold up under obvious scrutiny: sensible layering and separation of concerns, validated inputs and file uploads, no `eval()` on user input, no secrets in the repo, no keys or raw provider errors leaking to the client, sane limits on request size and cost, and **content retrieved from uploaded documents treated as untrusted data rather than as instructions to the model.**

Write down in your design doc what you protected against, what you consciously left out for a take-home, and what you would add before this went to production. We would rather see three defenses done properly and one honest paragraph about the gaps than a long list of half-implemented ones.

---

## 6. Optional extras

Only after the modules you chose to build are working. Pick what interests you. One done well beats four half-finished.

- **Structured output** — given a JSON Schema, return validated JSON. Use each provider's native mechanism where one exists (json_schema / response schema / tool-forcing) and fall back to prompt-then-validate-then-retry where it does not. Demo it by extracting structured fields from an uploaded document.
- **Side-by-side comparison** — same prompt, several providers concurrently, streaming in parallel columns, with a cost/latency comparison.
- **Semantic caching** — embed the incoming prompt, serve from cache on a similarity hit, show cache hit rate and money saved.
- **Evaluation harness** — a small golden dataset of Q&A, run across providers, score with an LLM judge, output a comparison table.
- **Hybrid retrieval** — BM25 + vector with reciprocal rank fusion, or a reranking pass.
- **Prompt caching** — use provider-side prompt caching for long documents and show the cost delta.
- **Streaming markdown + code rendering** that does not break on partial tokens.
- **Containerization** — entirely optional and not scored, but a working `docker compose up` makes our life easier when we run your code.

---

## 7. Constraints and freedoms

**Your choice:** language and framework. Next.js + TypeScript, or Python/FastAPI + React, or anything else you can defend. Database, vector store, styling, deployment — all yours.

**Not your choice:**

- At least three providers, including Anthropic and Gemini (Section 3.A).
- No provider-abstraction frameworks (Section 3.A.3).
- Real streaming.
- Tenant isolation exists and is explained (Section 4).
- Tests must exist for the adapter layer, with mocked HTTP responses. We do not expect broad coverage; we expect that the hard parts are tested.
- Secrets in `.env`, never committed. Ship a `.env.example`.

**About API keys and cost:** you are not expected to spend meaningful money. Gemini has a usable free tier, Groq's is generous, DeepSeek is very cheap, and Anthropic and OpenAI cost a few cents for this workload. If you genuinely cannot obtain a key for a provider you want to build, implement the adapter fully anyway and ship a recorded-fixture test proving the request/response mapping is correct, then say so in the README. We will run it with our own keys.

---

## 8. Scope: what we actually expect

**Read this section carefully. It is the one candidates most often get wrong.**

Building all five modules properly is more than a week of evenings. **We do not expect you to finish everything, and we are not scoring completeness.**

What we expect from a strong submission:

- **Module A done properly.** This is 25% of the score and it is the module that cannot be faked. Protect its quality above everything else.
- **Two or three more modules done well**, with the rest honestly cut.
- **Clear reasoning in the README about what you cut and why.**

**An engineer who ships A, B and C cleanly with a clear explanation of what they left out scores well above one who ships all five modules broken.** We mean that literally, and every year some candidates do not believe us.

**Suggested plan**

- **Days 1-2** — Contract, your chosen adapters, non-streaming first then streaming, error normalization, minimal chat UI, persistence, tenant model. If this slips, cut UI polish, never adapter quality.
- **Days 3-4** — RAG end to end with citations, then tool calling. These are the bulk of the remaining work.
- **Day 5** — Metrics, cost, retries and fallback. Adapter tests.
- **Days 6-7** — Buffer, then documentation. **Reserve real time for the docs.** Candidates routinely lose points because good work was invisible.

---

## 9. Deliverables

1. **GitHub repository** (public, or private with access granted to the reviewers listed in your email).

- Real commit history. Not one commit called "initial commit" containing everything.

2. `README.md` covering:

- Setup in under 5 minutes — exact commands, from clone to running.
- Which providers you implemented, and which you tested against live keys.
- **What is done, what is partially done, and what you cut, with reasoning.** Be honest; honesty scores better than overclaiming, and we will find out either way.

3. `docs/DESIGN.md` — architecture and decisions in one document:

- A diagram (Mermaid is fine) and how a request flows end to end.
- How the provider abstraction is layered, and **exactly what you would write to add one more provider**.
- Your tenant isolation model, answering the four questions in Section 4.
- Your security posture, per Section 5.
- 6-10 short decision entries: what you chose, what you rejected, why.
- At least two things you would do differently with more time.

4. `docs/PROVIDER_NOTES.md` — the concrete differences you hit between the APIs you implemented and how you reconciled them. **This document tells us more about your AI experience than almost anything else in the submission.**
5. `docs/AI_USAGE.md` — see Section 11.

**No demo video is required.** We will do a live walkthrough instead (Section 11).

---

## 10. How we score it

| Area                                                                                                | Weight |
| --------------------------------------------------------------------------------------------------- | ------ |
| Provider abstraction design and correctness                                                         | 25%    |
| **Extensibility: adding a fourth provider really is one file and one config entry**                 | 10%    |
| AI-specific depth (streaming, tool calling, token/cost handling)                                    | 15%    |
| RAG quality (chunking, retrieval, grounding, citations)                                             | 15%    |
| **Tenant isolation and security** (enforcement model, input validation, untrusted document content) | 15%    |
| Engineering quality (structure, error handling, tests, config)                                      | 10%    |
| Observability, resilience, cost tracking                                                            | 5%     |
| Documentation and communication                                                                     | 5%     |

Optional extras can add up to 10% on top.

**Scored on what you built, not on what you skipped.** A module you honestly cut is not scored against you. A module you claim in the README and did not build is.

**What loses points fast:** copy-pasted near-duplicate adapters, fake streaming, hardcoded model names and prices, secrets committed, unvalidated input, tenant boundary enforced only by convention, a README that does not match what the code does, tool calling that only works on one provider, RAG that stuffs the whole document into the prompt.

---

## 11. Use of AI coding assistants

Use them. Copilot, Cursor, Claude Code, ChatGPT — all fine, and pretending otherwise would be silly.

Two conditions:

1. Add `docs/AI_USAGE.md` describing what you used, for which parts, and **where you had to correct or reject what it produced.** That last part is the one we actually read.
2. **You will be asked to extend this system live.** In a 45-minute session you will share your screen and modify your own codebase in front of us: adding a provider, changing retrieval behavior, or debugging something we break. You will be asked why specific lines exist. **Submit only code you can explain and change under time pressure.**

---

## 12. Submission

Reply to the assignment email with:

- Repository URL (and access granted, if private)
- One paragraph: what you are proudest of, and the one thing you would fix first
