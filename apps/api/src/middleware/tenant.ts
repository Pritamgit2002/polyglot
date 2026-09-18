import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, or } from 'drizzle-orm';
import { ownerDb, tenants } from '@polyglot/db';

/**
 * Where the tenant identifier comes from, and what stops a caller forging it.
 *
 * Right now: the `x-tenant-id` header, resolved against the tenants table. For
 * a take-home with no auth, a caller CAN forge it — and that is the honest
 * answer to Section 4's first question. What matters is that this is the ONLY
 * place the tenant is decided, and everything downstream receives an opaque,
 * already-validated UUID it cannot influence.
 *
 * In production this function body changes and nothing else does: verify a
 * signed session cookie or a JWT, and read the tenant from a claim the client
 * cannot rewrite. Because every query already goes through withTenant(), the
 * blast radius of that change is one file.
 */

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    tenantSlug: string;
  }
}

const cache = new Map<string, { id: string; slug: string }>();

export async function resolveTenant(raw: string | undefined): Promise<{ id: string; slug: string } | null> {
  if (!raw || raw.length > 64 || !/^[\w-]+$/.test(raw)) return null;

  const hit = cache.get(raw);
  if (hit) return hit;

  // The one query that legitimately runs outside a tenant context: you cannot
  // scope a lookup by the thing you are looking up.
  const rows = await ownerDb
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(or(eq(tenants.slug, raw), isUuid(raw) ? eq(tenants.id, raw) : undefined))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  cache.set(raw, row);
  return row;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function registerTenantGuard(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply) => {
    // Health and model listing are tenant-agnostic.
    if (req.url.startsWith('/health') || req.url.startsWith('/api/models')) return;

    const header = req.headers['x-tenant-id'];
    const tenant = await resolveTenant(Array.isArray(header) ? header[0] : header);

    if (!tenant) {
      return reply.code(401).send({ error: { kind: 'auth', message: 'Unknown or missing x-tenant-id header.' } });
    }

    req.tenantId = tenant.id;
    req.tenantSlug = tenant.slug;
  });
}
