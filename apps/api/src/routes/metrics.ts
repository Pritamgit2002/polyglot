import type { FastifyInstance } from 'fastify';
import { avg, count, desc, sum } from 'drizzle-orm';
import { requestLogs, withTenant } from '@polyglot/db';

export function registerMetricsRoutes(app: FastifyInstance): void {
  /** Per-request rows. Scoped by RLS, so a tenant can only ever see — and only
   *  ever be billed for — its own traffic. */
  app.get('/api/metrics/requests', async (req) =>
    withTenant(req.tenantId, (tx) => tx.select().from(requestLogs).orderBy(desc(requestLogs.createdAt)).limit(200)),
  );

  /** Aggregate spend and latency by provider. */
  app.get('/api/metrics/summary', async (req) =>
    withTenant(req.tenantId, async (tx) => {
      const byProvider = await tx
        .select({
          provider: requestLogs.provider,
          requests: count(),
          totalCostUsd: sum(requestLogs.costUsd),
          avgTotalMs: avg(requestLogs.totalMs),
          avgTtftMs: avg(requestLogs.ttftMs),
          inputTokens: sum(requestLogs.inputTokens),
          outputTokens: sum(requestLogs.outputTokens),
        })
        .from(requestLogs)
        .groupBy(requestLogs.provider);

      return {
        byProvider,
        totals: {
          requests: byProvider.reduce((a, r) => a + Number(r.requests), 0),
          costUsd: byProvider.reduce((a, r) => a + Number(r.totalCostUsd ?? 0), 0),
        },
      };
    }),
  );
}
