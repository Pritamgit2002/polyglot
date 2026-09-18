# Provider notes

The concrete differences hit while building the three adapters, and how each was
reconciled. Every item below is exercised by a test in
`packages/providers/test/`.

---

## 1. Where the system prompt goes

| Provider                 | Shape                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Anthropic                | `system` — a **top-level request parameter**. Sending `{role:'system'}` in `messages` is a 400. |
| Gemini                   | `systemInstruction: { parts: [{ text }] }` — a **sibling field**, with its own content shape.   |
| OpenAI / Groq / DeepSeek | `{ role: 'system', content }` as the **first message**.                                         |

**Reconciled:** `system` is top-level in `CompletionRequest`, matching
Anthropic, and each adapter places it. `toOpenAIMessages(messages, system)`
prepends it; Gemini builds `systemInstruction`; Anthropic passes it through.

## 2. Role vocabulary

| Provider          | Roles                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Anthropic         | `user`, `assistant`. **No `tool` role** — a tool result is a content block inside a _user_ message. |
| Gemini            | `user`, `model`. No `assistant`, no `system`, no `tool` inside `contents`.                          |
| OpenAI-compatible | `system`, `user`, `assistant`, `tool`.                                                              |

**Reconciled:** our `Role` is `user | assistant | tool`. Anthropic collapses
`tool` into `user`; Gemini maps `assistant → model` and `tool → user`; OpenAI
passes through.

**The trap:** Anthropic and Gemini both reject two consecutive same-role turns.
Two sequential tool calls produce two `tool` messages, which become two `user`
messages, which is a 400. Both adapters **merge adjacent same-role turns** into
one before sending. This only shows up once you support more than one tool call
per turn, which is exactly what Module D asks for.

## 3. Tool result correlation — the sharpest divergence

| Provider          | How a result is matched to its call                           |
| ----------------- | ------------------------------------------------------------- |
| Anthropic         | `tool_use_id` referencing the `tool_use` block's `id`.        |
| OpenAI-compatible | `tool_call_id` on a dedicated `{role:'tool'}` message.        |
| **Gemini**        | **By `name`.** `functionResponse` has **no id field at all.** |

**Reconciled:** our contract is id-based (`toolUseId`). The Gemini adapter walks
back through the transcript to resolve the id to the tool's name
(`resolveToolName`). Gemini also refuses a bare string payload — the response
must be an object, so results are wrapped as `{result: ...}` or `{error: ...}`.

Because Gemini gives calls no id, the adapter **mints one**
(`gemini_<name>_<ts>_<n>`) so the rest of the system stays id-addressed. The
prefix makes its synthetic origin obvious in logs.

## 4. Tool argument streaming

| Provider          | Delivery                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic         | `input_json_delta` fragments, addressed by block **`index`**. Complete at `content_block_stop`. Sends `""` (not `"{}"`) for a no-argument call — `JSON.parse` throws on it.                                                                 |
| OpenAI-compatible | `delta.tool_calls[].function.arguments` fragments, addressed by **`index`**. The **`id` and `name` appear only on the first chunk**; later chunks carry `{index, function:{arguments}}` and nothing else. Complete only at `finish_reason`. |
| **Gemini**        | **Never fragmented.** The whole `functionCall` with parsed `args` arrives in one chunk.                                                                                                                                                     |

**Reconciled:** all three normalize to `tool_use_start` →
`tool_use_delta`\* → `tool_use_complete`. Gemini **synthesizes** all three from
its single event so downstream code sees one uniform shape. Anthropic and
OpenAI buffer by index, not id, because that is the only stable key across
chunks.

Two edge cases handled: Anthropic's empty-string arguments, and a stream
truncated mid-JSON by `max_tokens` — the latter yields `{}` rather than
throwing, so the model can be told the tool failed instead of losing the turn.

## 5. Token accounting — three incompatible conventions

| Provider  | Field names                                | Cached tokens                                                                                    | Reasoning tokens                                                  |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Anthropic | `input_tokens`, `output_tokens`            | `cache_read_input_tokens` and `cache_creation_input_tokens` are **separate from** `input_tokens` | included in `output_tokens`                                       |
| Gemini    | `promptTokenCount`, `candidatesTokenCount` | `cachedContentTokenCount` is a **subset of** prompt                                              | `thoughtsTokenCount` is **NOT** in `candidatesTokenCount`         |
| OpenAI    | `prompt_tokens`, `completion_tokens`       | `prompt_tokens_details.cached_tokens` is a **subset of** prompt                                  | `completion_tokens_details.reasoning_tokens` **is** in completion |

**Reconciled:** our `Usage` fixes one convention — _cached tokens are a subset
of `inputTokens`, reasoning tokens are included in `outputTokens`_ — so
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
  in the event name _and_ duplicated in the JSON.
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

| Provider          | Discriminator               | Notes                                                                                                                                                               |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic         | `error.type`                | `invalid_request_error`, `rate_limit_error`, `overloaded_error`. Returns **529** for overload — a non-standard code that generic `5xx` handling gets right by luck. |
| Gemini            | `error.status` (a string)   | `RESOURCE_EXHAUSTED`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `INVALID_ARGUMENT`, `UNAVAILABLE`.                                                                    |
| OpenAI-compatible | `error.code` / `error.type` | `context_length_exceeded`, `invalid_api_key`, `insufficient_quota`, `rate_limit_exceeded`.                                                                          |

**Reconciled:** each adapter starts from `kindFromStatus()` and then refines
using its vendor discriminator plus, where necessary, a message regex (an
over-long prompt is the case where only the message text distinguishes it).

**`Retry-After` is not consistent either:** OpenAI sends `ms` suffixes, Groq
sends `2.5s` / `1m30s`, some send an HTTP date, some send bare seconds.
`retryAfterFromHeaders()` parses all four forms.

## 10. Cancellation — nobody reports what an aborted stream cost you

Aborting mid-stream is well supported on all three (pass an `AbortSignal` to
`fetch` and the upstream request really is torn down — measured: a generation
that runs 14.5s to completion stops at the 2s mark when the client disconnects).

What none of them do is send a final usage message on the way out. The tokens
generated before the abort were generated, and they are billed, but the
`message_delta` / `usageMetadata` / `usage` chunk that would tell you how many
never arrives.

**Reconciled:** the orchestrator counts the characters it actually streamed and
estimates the output tokens from them, recording the row with
`error_kind = 'cancelled'` so nobody mistakes the figure for a measured one.
Dropping the record instead — which is what happens if you just `return` —
makes cancelled spend invisible, and a user who cancels ten long generations has
genuinely spent money that never appears in the metrics panel.

## 11. Pricing is context-tiered, and a flat rate per model is wrong

Every provider now charges more once a prompt crosses a size threshold, and no
two express it the same way:

| Provider | Mechanism |
|---|---|
| **OpenAI** | A multiplier on the **whole request** once input exceeds **272K** tokens — 2x input, 1.5x output for `gpt-5.6-luna`. The published tables call these the "short context" and "long context" columns. |
| Gemini | A second rate table above its own threshold. |
| Anthropic | A separate long-context rate on the models that offer it. |

**Reconciled:** `pricing.longContext` in `models.json` — an optional
`{ thresholdInputTokens, inputMultiplier, outputMultiplier }`. `computeCostUsd`
applies the multipliers to input, cached, cache-write and output when
`inputTokens` **exceeds** the threshold, and is a no-op for models that declare
no tier. It is config, so a threshold change is a one-line edit.

Two details that are easy to get wrong and are asserted in
`packages/core/test/core.test.ts`:

- The surcharge applies to the **entire request**, not to the tokens above the
  threshold. Pricing only the excess under-reports a 300K-token prompt by
  roughly half.
- The rule is *exceeds*, not *reaches*: a request of exactly 272,000 tokens is
  still charged at base rates.

Left honest: **only `openai:gpt-5.6-luna` has been verified against the live
pricing page** (2026-09-18). The Anthropic and Gemini figures in `models.json`
are unverified, and neither declares a `longContext` tier yet even though both
have one — so long-prompt costs on those two are currently under-reported.

## 12. Quirks are per-MODEL, not just per-provider

The assumption that a vendor behaves one way is wrong, and it broke this build.
Both of these were verified against the live API on 2026-09-18:

- **`gpt-5.6-luna` rejects `max_tokens`** — *"Unsupported parameter: 'max_tokens'
  is not supported with this model. Use 'max_completion_tokens' instead."*
  Older OpenAI models accept `max_tokens`, so a provider-wide setting breaks one
  fleet or the other.
- **`gpt-5.6-luna` refuses function tools on `/v1/chat/completions`** unless
  `reasoning_effort` is `'none'` — *"To use function tools, use /v1/responses or
  set reasoning_effort to none."* The trade-off is no reasoning on tool turns;
  the alternative is a second adapter for the Responses API.

**Reconciled:** `extra` now exists on the MODEL as well as the provider, and is
merged over it. Two generic knobs cover both cases — `maxTokensField`, and
`paramsWhenToolsPresent`, which is spread into the body only when tools are
actually sent. No `if (model === 'gpt-5.6-luna')` anywhere in the adapter; the
next model with a different demand is a config entry.

**How this was found, and why it matters.** The first two "successful" calls
against this model were not successful at all — the fallback chain had quietly
served them from Anthropic, and the test only printed token counts, not the
serving provider. **A fallback chain is an availability feature that doubles as
a way to hide a permanently broken configuration.** Every verification run since
passes `fallbackChain: []` and asserts on `metrics.modelId`, so a masked failure
cannot pass as a pass.

## 13. Miscellaneous

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

**All figures verified 2026-09-18.** Prices are USD per million tokens. Token
limits were read from each provider's own API rather than its docs, because the
API is the thing that will actually reject your request.

| Model | Input | Output | Cached in | Cache write | Context | Max out |
|---|---|---|---|---|---|---|
| `anthropic:claude-sonnet-4-6` | $3.00 | $15.00 | $0.30 | $3.75 | 1,000,000 | 128,000 |
| `anthropic:claude-haiku-4-5` | $1.00 | $5.00 | $0.10 | $1.25 | 200,000 | 64,000 |
| `google:gemini-2.5-flash` | $0.30 | $2.50 | $0.03 | — | 1,048,576 | 65,536 |
| `google:gemini-2.5-pro` | $1.25 | $10.00 | $0.125 | — | 1,048,576 | 65,536 |
| `openai:gpt-5.6-luna` | $0.20 | $1.20 | $0.02 | $0.25 | 1,050,000 | 128,000 |

Sources:

- Anthropic — <https://docs.claude.com/en/docs/about-claude/pricing> and
  <https://docs.claude.com/en/docs/about-claude/models/overview>. Max output
  came from the API's own limit error (`max_tokens: 200000 > 128000, which is
  the maximum allowed…`), which is more reliable than the docs: Sonnet 4.6 is
  no longer listed in the featured comparison table at all.
- Gemini — <https://ai.google.dev/gemini-api/docs/pricing>; limits from
  `GET /v1beta/models`.
- OpenAI — <https://platform.openai.com/docs/models/gpt-5.6-luna>.

### What was wrong before verifying

Worth recording, because the errors were not where I expected. **Every headline
input/output price I had was already correct.** What was wrong were the details
nobody checks:

| Field | Had | Actual |
|---|---|---|
| `claude-sonnet-4-6` context window | 200,000 | **1,000,000** |
| `claude-sonnet-4-6` max output | 64,000 | **128,000** |
| `claude-haiku-4-5` max output | 32,000 | **64,000** |
| `gemini-2.5-flash` cached input | $0.075 | **$0.03** (2.5x over-charged) |
| `gemini-2.5-pro` cached input | $0.31 | **$0.125** (2.5x over-charged) |
| `gemini-2.5-pro` long-context tier | absent | **2x input / 1.5x output above 200K** |

The context-window figures matter beyond cost: `fitToContextWindow` truncates
against them, so a wrong window silently discards conversation history that
would have fit. Sonnet 4.6 was throwing away 80% of its usable context.

### Long-context tiers — all three differ

| Provider | Behaviour |
|---|---|
| **OpenAI** (`gpt-5.6-luna`) | 2x input, 1.5x output on the **whole request** above **272K** input tokens. |
| **Gemini** (`2.5-pro`) | Separate rate table above **200K**: $1.25→$2.50 in, $10→$15 out, $0.125→$0.25 cached. Same shape as a 2x/1.5x multiplier, so it is modelled that way. `2.5-flash` has no tier. |
| **Anthropic** | **No surcharge at all.** 4.6 and later include the full 1M window at standard pricing — *"a 900k-token request is billed at the same per-token rate as a 9k-token request."* |

So the naive assumption — "long prompts cost more everywhere" — is wrong on one
of the three, and the two that do charge use different thresholds *and*
different mechanisms. `pricing.longContext` is optional precisely so Anthropic
can decline to have one.

### Notes on what is deliberately not modelled

- **Anthropic cache-write TTL.** `cacheWritePerMTok` is the 5-minute rate. The
  1-hour TTL costs more ($6/MTok on Sonnet 4.6 vs $3.75). We never request the
  1h TTL, so the second rate is not in the schema.
- **Gemini cache storage.** Charged per token *per hour* held, not per request.
  It is a storage cost, not a request cost, so it does not belong in a
  per-request cost calculation.
- **Modality-specific input rates.** Gemini charges $1.00/MTok for audio input
  against $0.30 for text. We only send text and images, so one input rate is
  enough — this would need a per-modality table to support audio.
- **Batch, Flex and Priority tiers.** All three vendors offer cheaper batch and
  pricier fast lanes. We always use the standard tier.
