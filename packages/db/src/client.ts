import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { schema } from './schema.js';

/**
 * Two connections, on purpose.
 *
 *  - the APP connection authenticates as `polyglot_app`: not the table owner,
 *    no BYPASSRLS. Every request-scoped query goes through it, inside
 *    withTenant().
 *  - the OWNER connection is used only for migrations and for resolving a
 *    tenant slug during authentication — the one lookup that by definition
 *    happens before a tenant context exists.
 *
 * Keeping them separate is what makes the boundary structural. If the app used
 * the owner connection, RLS would still be enabled but FORCE would be the only
 * thing standing between a bug and a cross-tenant read.
 *
 * Both are created lazily. Connecting at import time would mean a unit test of
 * a pure chunking function needs a running Postgres, which is a good way to end
 * up with no unit tests.
 */

type Drizzle = ReturnType<typeof drizzle<typeof schema>>;

let appSql: postgres.Sql | null = null;
let ownerSql: postgres.Sql | null = null;
let appDbInstance: Drizzle | null = null;
let ownerDbInstance: Drizzle | null = null;

export function getAppDb(): Drizzle {
  if (appDbInstance) return appDbInstance;
  const url = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_APP_URL (or DATABASE_URL) must be set.');
  appSql = postgres(url, { max: 10, prepare: false });
  appDbInstance = drizzle(appSql, { schema });
  return appDbInstance;
}

/** Bypasses tenant scoping. Never call this from a route handler. */
export function getOwnerDb(): Drizzle {
  if (ownerDbInstance) return ownerDbInstance;
  const url = process.env.DATABASE_URL;
  if (!url) return getAppDb();
  ownerSql = postgres(url, { max: 2, prepare: false });
  ownerDbInstance = drizzle(ownerSql, { schema });
  return ownerDbInstance;
}

/** Convenience proxy so call sites read as `ownerDb.select()` while the
 *  connection is still opened on first use. */
export const ownerDb = new Proxy({} as Drizzle, {
  get: (_t, prop) => Reflect.get(getOwnerDb() as object, prop),
});

export const appDb = new Proxy({} as Drizzle, {
  get: (_t, prop) => Reflect.get(getAppDb() as object, prop),
});

export type Db = Drizzle;
export type TenantDb = Parameters<Parameters<Drizzle['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens a transaction, pins the tenant for its duration, and runs the callback.
 *
 * `set_config(..., true)` makes the setting LOCAL to the transaction, so it is
 * discarded on commit or rollback. That matters with a connection pool: a
 * session-level setting would leak to whichever request borrowed the connection
 * next, which is the exact bug this design exists to prevent.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    // Defence in depth: the value is parameterized below, but a non-UUID here
    // means something upstream skipped validation and we want to know loudly.
    throw new Error('withTenant requires a UUID tenant id.');
  }

  return getAppDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`);
    return fn(tx as TenantDb);
  });
}

export async function closeConnections(): Promise<void> {
  await appSql?.end({ timeout: 5 });
  if (ownerSql && ownerSql !== appSql) await ownerSql.end({ timeout: 5 });
}
