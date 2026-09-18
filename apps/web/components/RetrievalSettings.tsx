'use client';

import { useEffect, useState } from 'react';
import { api, type Collection } from '@/lib/api';

/**
 * Module C requires retrieval parameters to be tunable at runtime from the UI.
 *
 * The two halves behave differently and the panel says so rather than hiding
 * it: top-k and the similarity threshold take effect on the next question,
 * while chunk size and overlap only apply to documents uploaded afterwards —
 * re-chunking existing documents means re-embedding them, which costs money and
 * is not something to do behind the user's back on a slider drag.
 */

const FIELDS = [
  { key: 'topK', label: 'Top-k', min: 1, max: 50, step: 1, live: true, hint: 'How many chunks to retrieve per question.' },
  { key: 'similarityThreshold', label: 'Min similarity', min: 0, max: 1, step: 0.05, live: true, hint: 'Chunks below this are discarded. Raise it to force an honest "I don’t know".' },
  { key: 'chunkSize', label: 'Chunk size', min: 100, max: 8000, step: 50, live: false, hint: 'Characters per chunk.' },
  { key: 'chunkOverlap', label: 'Chunk overlap', min: 0, max: 2000, step: 10, live: false, hint: 'Carried between chunks so a fact spanning a boundary survives in one of them.' },
] as const;

export default function RetrievalSettings({
  collection,
  onSaved,
}: {
  collection: Collection | undefined;
  onSaved: (c: Collection) => void;
}) {
  const [values, setValues] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues({ ...(collection?.settings ?? {}) });
    setStatus(null);
  }, [collection?.id, collection?.settings]);

  if (!collection) {
    return (
      <div className="placeholder">
        No collection selected.
        <br />
        Create one and upload a document to tune retrieval.
      </div>
    );
  }

  async function save(key: string, value: number) {
    setValues((v) => ({ ...v, [key]: value }));
    setSaving(true);
    try {
      const res = await api.updateCollection(collection!.id, { [key]: value });
      onSaved(res);
      setStatus(res.note ?? null);
    } catch (e) {
      setStatus((e as Error).message);
      setValues({ ...collection!.settings }); // roll back to what the server has
    } finally {
      setSaving(false);
    }
  }

  const fmt = (k: string, v: number) => (k === 'similarityThreshold' ? v.toFixed(2) : String(v));

  return (
    <div className="sec">
      <h3 className="sec-title">{collection.name}</h3>

      {FIELDS.map((f) => (
        <div key={f.key} className="field">
          <div className="field-head">
            <span className="field-label">
              {f.label}
              {!f.live && <span className="chip">new uploads</span>}
            </span>
            <span className="field-value">{fmt(f.key, values[f.key] ?? f.min)}</span>
          </div>
          <input
            type="range"
            min={f.min}
            max={f.max}
            step={f.step}
            value={values[f.key] ?? f.min}
            disabled={saving}
            aria-label={f.label}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
            // Persist on release, not on every pixel of the drag.
            onMouseUp={(e) => save(f.key, Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => save(f.key, Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => save(f.key, Number((e.target as HTMLInputElement).value))}
          />
          <div className="field-hint">{f.hint}</div>
        </div>
      ))}

      {status && <div className="notice info">{status}</div>}

      <p className="muted-note">
        Embeddings: <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{collection.embeddingModelId}</code>
      </p>
    </div>
  );
}
