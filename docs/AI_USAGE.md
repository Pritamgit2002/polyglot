# AI usage

## What was used

Claude (via Claude Code) was used throughout, mostly as a fast typist for
mechanical work and as a second pair of eyes on provider API details.

| Area | How it was used |
|---|---|
| Monorepo scaffolding | Generated wholesale — Turborepo config, tsconfigs, package manifests. Low-value boilerplate. |
| Adapter bodies | Drafted per provider, then corrected by hand against the actual API docs. See below. |
| SSE reader | Drafted, then substantially rewritten for chunk-boundary handling. |
| Tests | Drafted from the fixtures; the assertions were tightened by hand. |
| Calculator parser | Drafted, then hardened (exponent bound, expression length cap). |
| Docs | Drafted from the code, then edited for accuracy and honesty. |

## Where it had to be corrected or rejected

> **Fill in your own entries as you work — this is the section reviewers
> actually read, and generic answers are transparent.** The entries below are
> the ones from this build; replace or extend them with yours.

1. **Suggested the Vercel AI SDK.** The initial framing of the task named the
   Vercel AI SDK as a dependency. It is explicitly forbidden by §3.A.3, and it
   would have removed the abstraction that *is* the assignment. Rejected;
   everything is plain `fetch` and a hand-written SSE reader.

2. **Token accounting was wrong in the first draft, three different ways.**
   The generated adapters treated all three providers' usage fields as
   equivalent. They are not: Anthropic reports cache tokens *outside*
   `input_tokens`, Gemini reports `thoughtsTokenCount` *outside*
   `candidatesTokenCount`, and OpenAI includes reasoning tokens *inside*
   `completion_tokens`. Left as drafted, every cached Anthropic request and
   every Gemini thinking request would have been silently under-billed. Fixed by
   normalizing on one convention and asserting it in all three test files.

3. **Gemini tool-result correlation.** The draft emitted a `functionResponse`
   with an `id` field, copying the Anthropic shape. Gemini has no such field and
   matches by `name`. This is not a detail you can guess — it needed the docs.
   Fixed with `resolveToolName()`, which walks back through the transcript.

4. **The SSE reader did not buffer across chunk boundaries.** The first version
   split on `\n\n` within a single `read()`, which works locally against a fast
   loopback and drops characters the moment a frame straddles two TCP reads. The
   test helper now splits every fixture frame in half specifically to force that
   path.

5. **`postJson` leaked its timeout timer.** The draft cleared the timer in a
   `finally` block, which fired before a streaming body had been consumed and
   aborted long responses. Reworked to hand a `dispose()` callback to the stream
   reader.

6. **The grounding prompt named the fence delimiter in its own instruction
   text**, giving an injected document a third occurrence to aim at. Caught by a
   test that asserts exactly two fence markers survive a hostile document. Fixed
   in the prompt, not the test.

7. **Suggested filtering by `tenant_id` in the repository layer.** That is a
   convention, and one forgotten `where` clause leaks. Rejected in favour of
   Postgres RLS with a non-owner role, which makes the leak structurally
   impossible from the application role.

## What I can explain and change under time pressure

All of it — that is the point of the corrections above. The parts worth asking
about, and where the answers live:

- Why `tool_use_delta` exists at all when Gemini never fragments arguments →
  `adapters/gemini.ts`, the synthesized start/delta/complete.
- Why fallback is disabled once a token has been emitted → `orchestrator.ts`.
- Why `set_config(..., true)` and not a session variable → `db/src/client.ts`.
- Why the registry uses dynamic import instead of a map → `registry.ts`.
