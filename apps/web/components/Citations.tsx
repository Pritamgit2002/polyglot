'use client';

export interface Citation {
  id: string;
  index: number;
  filename: string;
  locator: string | null;
  text: string;
  similarity: number;
}

/** Module C requires the user to be able to see the chunk a citation points at,
 *  not just the number. The full chunk text is rendered here verbatim. */
export default function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;

  return (
    <div className="section">
      <h3>Retrieved chunks</h3>
      {citations.map((c) => (
        <div key={c.id} className="citation">
          <div className="head">
            <span>
              [{c.index}] {c.filename}
              {c.locator ? ` · ${c.locator}` : ''}
            </span>
            <span>{(c.similarity * 100).toFixed(1)}%</span>
          </div>
          <div className="text">{c.text}</div>
        </div>
      ))}
    </div>
  );
}
