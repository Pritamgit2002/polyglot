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
 * is not something to do behind the user's back.
 */

const FIELDS = [
  { key: 'topK', label: 'Top-k', min: 1, max: 50, step: 1, live: true, hint: 'How many chunks to retrieve.' },
  { key: 'similarityThreshold', label: 'Min similarity', min: 0, max: 1, step: 0.05, live: true, hint: 'Below this, a chunk is discarded — raise it to force "I don\'t know".' },
  { key: 'chunkSize', label: 'Chunk size', min: 100, max: 8000, step: 50, live: false, hint: 'Characters per chunk.' },
  { key: 'chunkOverlap', label: 'Chunk overlap', min: 0, max: 2000, step: 10, live: false, hint: 'Carried between chunks so a fact spanning a boundary survives.' },
] as const;

export default function RetrievalSettings({
  collection,
  onSaved,
}: {
  collection: Collection;
  onSaved: (c: Collection) => void;
}) {
  const [values, setValues] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues({ ...collection.settings });
    setStatus(null);
  }, [collection.id, collection.settings]);

  async function save(key: string, value: number) {
    setValues((v) => ({ ...v, [key]: value }));
    setSaving(true);
    try {
      const res = await api.updateCollection(collection.id, { [key]: value });
      onSaved(res);
      setStatus(res.note ?? null);
    } catch (e) {
      setStatus((e as Error).message);
      setValues({ ...collection.settings }); // roll back to what the server has
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section">
      <h3>Retrieval — {collection.name}</h3>

      {FIELDS.map((f) => (
        <div key={f.key} className="field">
          <label title={f.hint}>
            <span>
              {f.label}
              {!f.live && <span className="chip" style={{ marginLeft: 6 }}>new uploads</span>}
            </span>
            <strong>{values[f.key] ?? '—'}</strong>
          </label>
          <input
            type="range"
            min={f.min}
            max={f.max}
            step={f.step}
            value={values[f.key] ?? f.min}
            disabled={saving}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
            // Persist on release, not on every pixel of the drag.
            onMouseUp={(e) => save(f.key, Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => save(f.key, Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => save(f.key, Number((e.target as HTMLInputElement).value))}
          />
        </div>
      ))}

      {status && <div className="chip" style={{ marginTop: 4 }}>{status}</div>}
    </div>
  );
}
