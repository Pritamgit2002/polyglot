'use client';

import { useEffect, useState } from 'react';
import { api, type MetricsSummary, type RequestLog } from '@/lib/api';

/** Module E: cost and latency, per request and aggregated by provider. Both
 *  endpoints are tenant-scoped by RLS, so this panel can only ever show the
 *  current tenant's spend. */
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
        // A slow response for the OLD tenant must not land after a switch.
        if (cancelled) return;
        setSummary(s);
        setRequests(r.slice(0, 12));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [refreshKey, tenant]);

  return (
    <>
      <div className="section">
        <h3>Spend by provider</h3>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Reqs</th>
              <th>Cost</th>
              <th>Avg ms</th>
              <th>TTFT</th>
            </tr>
          </thead>
          <tbody>
            {(summary?.byProvider ?? []).map((row) => (
              <tr key={row.provider}>
                <td>{row.provider}</td>
                <td>{row.requests}</td>
                <td>${Number(row.totalCostUsd ?? 0).toFixed(4)}</td>
                <td>{Math.round(Number(row.avgTotalMs ?? 0))}</td>
                <td>{Math.round(Number(row.avgTtftMs ?? 0))}</td>
              </tr>
            ))}
            {summary && (
              <tr>
                <td colSpan={2}>
                  <strong>Total</strong>
                </td>
                <td colSpan={3}>
                  <strong>${summary.totals.costUsd.toFixed(4)}</strong>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h3>Recent requests</h3>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>ms</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td title={`${r.finishReason}${r.fallbackFrom ? ` · fell back from ${r.fallbackFrom}` : ''}`}>
                  {r.modelId.split(':')[1] ?? r.modelId}
                </td>
                <td>{r.totalMs}</td>
                <td>
                  {r.inputTokens}/{r.outputTokens}
                </td>
                <td>${Number(r.costUsd).toFixed(5)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
