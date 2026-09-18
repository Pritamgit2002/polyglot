'use client';

import { useEffect, useState } from 'react';
import { api, type MetricsSummary, type RequestLog } from '@/lib/api';

/** Cost figures are tiny per request, so a fixed 2dp would render every row as
 *  $0.00. Scale the precision to the magnitude instead. */
function money(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export default function MetricsPanel({ refreshKey, tenant }: { refreshKey: number; tenant: string }) {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [requests, setRequests] = useState<RequestLog[]>([]);

  useEffect(() => {
    // `tenant` is in the dependency list, and the panel is blanked before the
    // refetch. Without both, switching tenant leaves the previous tenant's
    // spend on screen — the server scopes correctly, but a stale client still
    // looks exactly like a leak, which is the one thing this app must not do.
    setSummary(null);
    setRequests([]);

    let cancelled = false;
    Promise.all([api.metricsSummary(), api.metricsRequests()])
      .then(([s, r]) => {
        if (cancelled) return; // a slow response for the OLD tenant must not land
        setSummary(s);
        setRequests(r.slice(0, 14));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [refreshKey, tenant]);

  if (!summary) return <div className="placeholder">Loading usage…</div>;
  if (summary.totals.requests === 0) {
    return <div className="placeholder">No requests yet for this tenant.</div>;
  }

  const avgTtft =
    summary.byProvider.reduce((a, r) => a + Number(r.avgTtftMs ?? 0), 0) / Math.max(1, summary.byProvider.length);

  return (
    <>
      <div className="stat-grid">
        <div className="stat money">
          <div className="label">Total spend</div>
          <div className="value">{money(summary.totals.costUsd)}</div>
        </div>
        <div className="stat">
          <div className="label">Requests</div>
          <div className="value">{summary.totals.requests}</div>
        </div>
        <div className="stat">
          <div className="label">Avg TTFT</div>
          <div className="value">{Math.round(avgTtft)}ms</div>
        </div>
        <div className="stat">
          <div className="label">Providers</div>
          <div className="value">{summary.byProvider.length}</div>
        </div>
      </div>

      <div className="sec">
        <h3 className="sec-title">By provider</h3>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th className="num">Reqs</th>
              <th className="num">Cost</th>
              <th className="num">Avg ms</th>
            </tr>
          </thead>
          <tbody>
            {summary.byProvider.map((row) => (
              <tr key={row.provider}>
                <td style={{ color: 'var(--text)' }}>{row.provider}</td>
                <td className="num">{row.requests}</td>
                <td className="num" style={{ color: 'var(--cost)' }}>{money(Number(row.totalCostUsd ?? 0))}</td>
                <td className="num">{Math.round(Number(row.avgTotalMs ?? 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sec">
        <h3 className="sec-title">Recent requests</h3>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">ms</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td
                  style={{ color: r.errorKind ? 'var(--error)' : 'var(--text)' }}
                  title={[
                    r.modelId,
                    `finish: ${r.finishReason}`,
                    r.retryCount ? `${r.retryCount} retries` : null,
                    r.fallbackFrom ? `fell back from ${r.fallbackFrom}` : null,
                    r.errorKind ? `error: ${r.errorKind}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  {r.modelId.split(':')[1] ?? r.modelId}
                  {r.fallbackFrom ? ' ↩' : ''}
                </td>
                <td className="num">{r.totalMs}</td>
                <td className="num">
                  {r.inputTokens}/{r.outputTokens}
                </td>
                <td className="num" style={{ color: 'var(--cost)' }}>{money(Number(r.costUsd))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted-note" style={{ marginTop: 10 }}>
          ↩ marks a request the fallback chain rerouted. Hover a row for the finish reason.
        </p>
      </div>
    </>
  );
}
