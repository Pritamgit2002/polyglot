'use client';

export interface Citation {
  id: string;
  index: number;
  filename: string;
  locator: string | null;
  text: string;
  similarity: number;
}

/**
 * Module C requires the user to be able to see the chunk a citation points at,
 * not just its number. The full chunk text is rendered verbatim, and the
 * similarity is shown as a bar as well as a figure so a weak match is obvious
 * at a glance rather than needing to be read.
 */
export default function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) {
    return (
      <div className="placeholder">
        No sources retrieved yet.
        <br />
        Select a collection and ask a question.
      </div>
    );
  }

  return (
    <div className="sec">
      <h3 className="sec-title">Retrieved chunks</h3>
      {citations.map((c) => (
        <div key={c.id} className="card">
          <div className="cite-head">
            <span className="cite-idx">{c.index}</span>
            <span className="cite-src" title={`${c.filename}${c.locator ? ` · ${c.locator}` : ''}`}>
              {c.filename}
              {c.locator ? ` · ${c.locator}` : ''}
            </span>
            <span className="chip mono">{(c.similarity * 100).toFixed(0)}%</span>
          </div>
          <div className="bar">
            <i style={{ width: `${Math.max(2, Math.min(100, c.similarity * 100))}%` }} />
          </div>
          <div className="cite-body">{c.text}</div>
        </div>
      ))}
    </div>
  );
}
