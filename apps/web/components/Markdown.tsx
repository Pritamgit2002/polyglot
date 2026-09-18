'use client';

import { Fragment, type ReactNode } from 'react';

/**
 * A small markdown renderer built for STREAMING text.
 *
 * Two constraints shaped it:
 *
 * 1. **It must not break on partial input.** Every frame re-renders a string
 *    that may end mid-token — an unclosed `**`, a fence with no closing ```.
 *    A parser that throws, or that swallows the tail until the token closes,
 *    makes the text visibly stutter. Here an unterminated fence renders as a
 *    code block of what has arrived so far, and an unterminated inline marker
 *    renders as the literal characters. Nothing is ever hidden.
 *
 * 2. **It builds React elements, never HTML.** No dangerouslySetInnerHTML.
 *    This text is model output, and in a RAG turn the model has been reading
 *    user-uploaded documents — so it is untrusted by construction. Returning
 *    elements means an injected <img onerror=...> is text, not a tag.
 *
 * Deliberately not supported: tables, links, blockquotes, nested lists. They
 * are rare in chat answers and each one is a new partial-input edge case.
 */

const INLINE = /(`[^`]*`?|\*\*[^*]*\*?\*?|\*[^*\n]*\*?|\[\d+\])/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;

  for (const m of text.matchAll(INLINE)) {
    const token = m[0];
    const at = m.index!;
    if (at > last) out.push(text.slice(last, at));
    last = at + token.length;
    const key = `${keyBase}-${i++}`;

    // Inline code: `x` — a lone unclosed backtick stays literal.
    if (token.startsWith('`')) {
      if (token.length > 1 && token.endsWith('`')) out.push(<code key={key}>{token.slice(1, -1)}</code>);
      else out.push(token);
      continue;
    }

    // Citation marker [1] — styled so it reads as a reference, not as text.
    if (/^\[\d+\]$/.test(token)) {
      out.push(
        <sup key={key} className="cite-ref">
          {token.slice(1, -1)}
        </sup>,
      );
      continue;
    }

    if (token.startsWith('**')) {
      if (token.length > 4 && token.endsWith('**')) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
      else out.push(token); // still streaming
      continue;
    }

    if (token.startsWith('*')) {
      if (token.length > 2 && token.endsWith('*')) out.push(<em key={key}>{token.slice(1, -1)}</em>);
      else out.push(token);
      continue;
    }

    out.push(token);
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ text }: { text: string }) {
  if (!text) return null;

  const blocks: ReactNode[] = [];
  const lines = text.split('\n');

  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // ---- fenced code ----------------------------------------------------
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) body.push(lines[i++]!);
      i++; // consume the closing fence if it arrived; harmless if it has not

      blocks.push(
        <pre key={key++} className="md-code">
          {lang && <span className="md-code-lang">{lang}</span>}
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // ---- horizontal rule -------------------------------------------------
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    // ---- heading ---------------------------------------------------------
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push(
        <p key={key++} className="md-h" data-level={h[1]!.length}>
          {renderInline(h[2]!, `h${key}`)}
        </p>,
      );
      i++;
      continue;
    }

    // ---- list ------------------------------------------------------------
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key++} className="md-list">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `l${key}-${n}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }

    // ---- paragraph (consume until a blank line) ---------------------------
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.trimStart().startsWith('```') &&
      !/^(#{1,4})\s+/.test(lines[i]!) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    if (para.length) {
      blocks.push(
        <p key={key++} className="md-p">
          {renderInline(para.join('\n'), `p${key}`)}
        </p>,
      );
    } else {
      i++; // blank line
    }
  }

  return <Fragment>{blocks}</Fragment>;
}
