# Provider notes

The concrete differences hit while building the three adapters, and how each was
reconciled. Every item below is exercised by a test in
`packages/providers/test/`.

---

## 1. Where the system prompt goes

| Provider | Shape |
|---|---|
| Anthropic | `system` — a **top-level request parameter**. Sending `{role:'system'}` in `messages` is a 400. |
| Gemini | `systemInstruction: { parts: [{ text }] }` — a **sibling field**, with its own content shape. |
| OpenAI / Groq / DeepSeek | `{ role: 'system', content }` as the **first message**. |

**Reconciled:** `system` is top-level in `CompletionRequest`, matching
Anthropic, and each adapter places it. `toOpenAIMessages(messages, system)`
prepends it; Gemini builds `systemInstruction`; Anthropic passes it through.

## 2. Role vocabulary

| Provider | Roles |
|---|---|
| Anthropic | `user`, `assistant`. **No `tool` role** — a tool result is a content block inside a *user* message. |
| Gemini | `user`, `model`. No `assistant`, no `system`, no `tool` inside `contents`. |
| OpenAI-compatible | `system`, `user`, `assistant`, `tool`. |

**Reconciled:** our `Role` is `user | assistant | tool`. Anthropic collapses
`tool` into `user`; Gemini maps `assistant → model` and `tool → user`; OpenAI
passes through.

**The trap:** Anthropic and Gemini both reject two consecutive same-role turns.
Two sequential tool calls produce two `tool` messages, which become two `user`
messages, which is a 400. Both adapters **merge adjacent same-role turns** into
one before sending. This only shows up once you support more than one tool call
per turn, which is exactly what Module D asks for.

## 3. Tool result correlation — the sharpest divergence

| Provider | How a result is matched to its call |
|---|---|
| Anthropic | `tool_use_id` referencing the `tool_use` block's `id`. |
| OpenAI-compatible | `tool_call_id` on a dedicated `{role:'tool'}` message. |
| **Gemini** | **By `name`.** `functionResponse` has **no id field at all.** |

**Reconciled:** our contract is id-based (`toolUseId`). The Gemini adapter walks
back through the transcript to resolve the id to the tool's name
(`resolveToolName`). Gemini also refuses a bare string payload — the response
must be an object, so results are wrapped as `{result: ...}` or `{error: ...}`.

Because Gemini gives calls no id, the adapter **mints one**
(`gemini_<name>_<ts>_<n>`) so the rest of the system stays id-addressed. The
prefix makes its synthetic origin obvious in logs.

## 4. Tool argument streaming

| Provider | Delivery |
|---|---|
| Anthropic | `input_json_delta` fragments, addressed by block **`index`**. Complete at `content_block_stop`. Sends `""` (not `"{}"`) for a no-argument call — `JSON.parse` throws on it. |
| OpenAI-compatible | `delta.tool_calls[].function.arguments` fragments, addressed by **`index`**. The **`id` and `name` appear only on the first chunk**; later chunks carry `{index, function:{arguments}}` and nothing else. Complete only at `finish_reason`. |
| **Gemini** | **Never fragmented.** The whole `functionCall` with parsed `args` arrives in one chunk. |

**Reconciled:** all three normalize to `tool_use_start` →
`tool_use_delta`* → `tool_use_complete`. Gemini **synthesizes** all three from
its single event so downstream code sees one uniform shape. Anthropic and
OpenAI buffer by index, not id, because that is the only stable key across
chunks.

Two edge cases handled: Anthropic's empty-string arguments, and a stream
truncated mid-JSON by `max_tokens` — the latter yields `{}` rather than
throwing, so the model can be told the tool failed instead of losing the turn.

## 5. Token accounting — three incompatible conventions

| Provider | Field names | Cached tokens | Reasoning tokens |
|---|---|---|---|
| Anthropic | `input_tokens`, `output_tokens` | `cache_read_input_tokens` and `cache_creation_input_tokens` are **separate from** `input_tokens` | included in `output_tokens` |
| Gemini | `promptTokenCount`, `candidatesTokenCount` | `cachedContentTokenCount` is a **subset of** prompt | `thoughtsTokenCount` is **NOT** in `candidatesTokenCount` |
| OpenAI | `prompt_tokens`, `completion_tokens` | `prompt_tokens_details.cached_tokens` is a **subset of** prompt | `completion_tokens_details.reasoning_tokens` **is** in completion |

**Reconciled:** our `Usage` fixes one convention — *cached tokens are a subset
of `inputTokens`, reasoning tokens are included in `outputTokens`* — so
`computeCostUsd` has exactly one rule to follow.

- Anthropic: cache reads and writes are **added back into** `inputTokens`.
- Gemini: `thoughtsTokenCount` is **added into** `outputTokens`, or every
  thinking request under-reports its cost.
- OpenAI: passes through unchanged.

Getting this wrong is invisible — you get a number, it is just the wrong number.
It is asserted in all three adapter test files.

**Contract extension:** `Usage.cacheWriteTokens` was added. Anthropic bills
cache writes at 1.25× input and reads at 0.1×; folding them together misprices
every first request against a cached prefix.

## 6. Usage delivery during streaming

- **OpenAI / DeepSeek:** requires `stream_options: {include_usage: true}`, then
  sends a final chunk with `choices: []` and a `usage` object.
- **Groq:** rejects or ignores `stream_options`, and instead attaches usage to
  the last content chunk under a vendor field, `x_groq.usage`.
- **Anthropic:** input tokens at `message_start`, final output tokens at
  `message_delta`. The `message_start` output count is 1-2 and must be
  overwritten, not accumulated.
- **Gemini:** `usageMetadata` is repeated on **every** chunk with running
  totals. Accumulating instead of replacing counts the prompt N times.

Handled in config (`providers.groq.extra.supportsStreamOptions: false`) rather
than in code, so a fourth OpenAI-compatible provider with the same quirk is a
config entry.

## 7. SSE framing

- **Anthropic** sends named events (`event: content_block_delta`) — the type is
  in the event name *and* duplicated in the JSON.
- **OpenAI-compatible** sends anonymous `data:` lines terminated by the literal
  sentinel `data: [DONE]`, which is **not JSON** and throws if parsed.
- **Gemini** needs `?alt=sse` (without it you get a JSON array, streamed but not
  line-delimited), sends anonymous `data:` lines, and has **no terminator**.

**Reconciled:** one hand-written reader in `http.ts` that returns
`{event?, data}` frames and buffers across chunk boundaries. Frames split
mid-token across TCP reads are the classic "works locally, drops characters
behind a proxy" bug; the tests feed every fixture **split in half** to force
that path.

## 8. Tool/function schemas

- **Anthropic:** `input_schema`, accepts JSON Schema.
- **OpenAI:** `function.parameters`, accepts JSON Schema.
- **Gemini:** `functionDeclarations[].parameters`, an **OpenAPI 3.0 subset**.
  `$schema`, `additionalProperties`, `exclusiveMinimum`, `oneOf`, `$ref` and
  friends are hard 400s.

**Reconciled:** one `ToolDefinition` in our code. The Gemini adapter runs
`sanitizeSchemaForGemini`, which recursively strips the unsupported keywords —
cheaper and less error-prone than maintaining a second set of tool definitions.

## 9. Error taxonomies

Status code alone is lossy: all three return **400** for both "your JSON is
malformed" and "your prompt is too long", and those need opposite handling
(never retry vs. truncate and retry).

| Provider | Discriminator | Notes |
|---|---|---|
| Anthropic | `error.type` | `invalid_request_error`, `rate_limit_error`, `overloaded_error`. Returns **529** for overload — a non-standard code that generic `5xx` handling gets right by luck. |
| Gemini | `error.status` (a string) | `RESOURCE_EXHAUSTED`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `INVALID_ARGUMENT`, `UNAVAILABLE`. |
| OpenAI-compatible | `error.code` / `error.type` | `context_length_exceeded`, `invalid_api_key`, `insufficient_quota`, `rate_limit_exceeded`. |

**Reconciled:** each adapter starts from `kindFromStatus()` and then refines
using its vendor discriminator plus, where necessary, a message regex (an
over-long prompt is the case where only the message text distinguishes it).

**`Retry-After` is not consistent either:** OpenAI sends `ms` suffixes, Groq
sends `2.5s` / `1m30s`, some send an HTTP date, some send bare seconds.
`retryAfterFromHeaders()` parses all four forms.

## 10. Structured output — three unrelated mechanisms

| Provider | Mechanism |
|---|---|
| OpenAI-compatible | `response_format: { type: 'json_schema', json_schema: { schema, strict: true } }` |
| Gemini | `generationConfig.responseMimeType = 'application/json'` **plus** `generationConfig.responseSchema` (the same OpenAPI subset, so it needs the same sanitizer as tool schemas) |
| **Anthropic** | **No equivalent exists.** The supported route is to declare a single tool whose `input_schema` *is* the target schema and force it with `tool_choice: { type: 'tool', name: ... }` |

**Reconciled:** one `responseSchema` field on `CompletionRequest`. The Anthropic
adapter does the tool-forcing and then **unwraps the forced call back into a
text block**, so a caller receives JSON-as-text on all three. Streaming is
normalized the same way: Anthropic's `input_json_delta` fragments are emitted as
`text_delta`, so partial JSON renders identically everywhere and the synthetic
tool never leaks upward as a `tool_use` event.

Two consequences worth stating, because they are real limitations rather than
oversights:

- On Anthropic, structured output and caller-supplied tools are **mutually
  exclusive** — forcing `tool_choice` at one tool necessarily excludes the rest.
- Only Gemini and OpenAI enforce the schema server-side. Anthropic's tool
  forcing guarantees a *call*, not a *valid* one, so a validate-then-retry loop
  is still required for parity. That loop is **not built** — see the README.

## 11. Miscellaneous

- **`max_tokens` is required by Anthropic** and optional everywhere else. The
  adapter defaults it rather than sending `undefined`, which is a 400.
- **Images:** Anthropic wants `{source:{type:'base64', media_type, data}}`,
  Gemini wants `{inlineData:{mimeType, data}}`, OpenAI wants a `data:` URL in
  `{type:'image_url'}`. One `ContentBlock` with `mimeType` + `data`, three
  mappings.
- **Gemini accepts the API key as `?key=`.** We send `x-goog-api-key` instead —
  URLs end up in access logs, proxy logs and browser history.
- **DeepSeek** streams reasoning as a separate `reasoning_content` field on the
  delta, alongside `content`. Handled via `providers.deepseek.extra.reasoningField`.

---

## Pricing sources

⚠️ **Verify these against the live pricing pages before submitting** — the
numbers in `packages/config/models.json` were taken from the vendors' published
rates and vendors change them without notice. Record the URL and the date you
read each one here:

| Model | Input / Output per MTok | Source | Read on |
|---|---|---|---|
| `anthropic:claude-sonnet-4-6` | $3.00 / $15.00 (cached in $0.30, cache write $3.75) | https://www.anthropic.com/pricing | _fill in_ |
| `anthropic:claude-haiku-4-5` | $1.00 / $5.00 | https://www.anthropic.com/pricing | _fill in_ |
| `google:gemini-2.5-flash` | $0.30 / $2.50 | https://ai.google.dev/gemini-api/docs/pricing | _fill in_ |
| `google:gemini-2.5-pro` | $1.25 / $10.00 | https://ai.google.dev/gemini-api/docs/pricing | _fill in_ |
| `openai:gpt-4.1-mini` | $0.40 / $1.60 | https://openai.com/api/pricing/ | _fill in_ |
| `groq:llama-3.3-70b-versatile` | $0.59 / $0.79 | https://groq.com/pricing/ | _fill in_ |
| `deepseek:deepseek-chat` | $0.27 / $1.10 | https://api-docs.deepseek.com/quick_start/pricing | _fill in_ |
| `openai:text-embedding-3-small` | $0.02 | https://openai.com/api/pricing/ | _fill in_ |

Because pricing lives in config, correcting any of these is a one-line edit with
no rebuild.
