import type { Message } from './types.js';
import type { ModelConfig } from './models.js';

/**
 * Context-window handling.
 *
 * The assignment asks us to make this choice explicitly, so: we TRUNCATE from
 * the oldest turn, never from the newest, and we never split a tool_use from
 * its matching tool_result — every provider rejects an orphaned pair, and
 * Anthropic rejects it with a 400 that reads like a schema error, which is a
 * miserable thing to debug at 2am.
 *
 * Rejected alternatives:
 *  - Summarizing the dropped prefix. Better UX, but it costs an extra model
 *    call per overflow and introduces a second place where hallucination can
 *    enter the transcript. Noted as future work in docs/DESIGN.md.
 *  - Hard rejection. Honest, but makes long RAG conversations unusable.
 */

/** ~3.6 chars/token is a decent cross-tokenizer average for English prose and
 *  deliberately conservative — overestimating truncates early, which is safe;
 *  underestimating gets you a 400 from the provider, which is not. */
const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(m: Message): number {
  let total = 4; // per-message role/framing overhead
  for (const b of m.content) {
    if (b.text) total += estimateTokens(b.text);
    if (b.content) total += estimateTokens(b.content);
    if (b.input) total += estimateTokens(JSON.stringify(b.input));
    // A base64 image is ~750 tokens for a typical screenshot; rough but bounded.
    if (b.type === 'image' && b.data) total += Math.min(1600, Math.ceil(b.data.length / 750));
  }
  return total;
}

export interface FitResult {
  messages: Message[];
  droppedCount: number;
  estimatedInputTokens: number;
}

export function fitToContextWindow(
  messages: Message[],
  model: ModelConfig,
  opts: { system?: string; reserveOutputTokens?: number } = {},
): FitResult {
  const reserve = opts.reserveOutputTokens ?? Math.min(model.maxOutputTokens, 4096);
  const systemTokens = opts.system ? estimateTokens(opts.system) : 0;
  const budget = model.contextWindow - reserve - systemTokens - 64;

  const sizes = messages.map(estimateMessageTokens);
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) {
    return { messages, droppedCount: 0, estimatedInputTokens: total + systemTokens };
  }

  let start = 0;
  while (start < messages.length - 1 && total > budget) {
    total -= sizes[start]!;
    start++;
  }

  // Never begin a transcript with an orphaned tool_result: its tool_use is gone.
  while (start < messages.length && startsWithOrphanToolResult(messages[start]!)) {
    total -= sizes[start]!;
    start++;
  }

  return {
    messages: messages.slice(start),
    droppedCount: start,
    estimatedInputTokens: total + systemTokens,
  };
}

function startsWithOrphanToolResult(m: Message): boolean {
  return m.role === 'tool' || m.content.some((b) => b.type === 'tool_result');
}
