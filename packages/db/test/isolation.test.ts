import { beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Integration test for the claim the whole tenant model rests on: that the
 * boundary is enforced by Postgres, not by remembering a WHERE clause.
 *
 * It connects as `polyglot_app` — the same non-owner, non-BYPASSRLS role the
 * API uses — and tries to do the things a careless or malicious engineer would
 * do. Skipped when DATABASE_APP_URL is unset so unit runs stay offline.
 */

const APP_URL = process.env.DATABASE_APP_URL;
const ACME = '11111111-1111-4111-8111-111111111111';
const GLOBEX = '22222222-2222-4222-8222-222222222222';

const describeIf = APP_URL ? describe : describe.skip;

describeIf('tenant isolation (RLS)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(APP_URL!, { max: 2, onnotice: () => {} });

    // Seed one conversation per tenant, each inside its own tenant context.
    for (const tenant of [ACME, GLOBEX]) {
      await sql.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${tenant}, true)`;
        await tx`
          INSERT INTO conversations (tenant_id, title) VALUES (${tenant}::uuid, ${'seed-' + tenant.slice(0, 4)})
          ON CONFLICT DO NOTHING
        `;
      });
    }
  });

  it('returns NOTHING when no tenant context is set', async () => {
    // The failure mode points the safe way: forgetting withTenant() yields
    // zero rows, not every row.
    const rows = await sql`SELECT * FROM conversations`;
    expect(rows).toHaveLength(0);
  });

  it('shows only the pinned tenant\'s rows, with no WHERE clause in the query', async () => {
    const acme = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${ACME}, true)`;
      return tx`SELECT tenant_id FROM conversations`;
    });

    expect(acme.length).toBeGreaterThan(0);
    expect([...new Set(acme.map((r: any) => r.tenant_id))]).toEqual([ACME]);
  });

  it('cannot read another tenant\'s row even when asked for it BY ID', async () => {
    const [globexRow] = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${GLOBEX}, true)`;
      return tx`SELECT id FROM conversations LIMIT 1`;
    });

    const stolen = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${ACME}, true)`;
      return tx`SELECT * FROM conversations WHERE id = ${(globexRow as any).id}`;
    });

    // Not filtered out — invisible. The handler 404s rather than 403s.
    expect(stolen).toHaveLength(0);
  });

  it('rejects an INSERT that claims a different tenant_id', async () => {
    const attempt = sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${ACME}, true)`;
      // An engineer passing the wrong tenant id is caught by WITH CHECK, so a
      // mismatch between the pinned context and the column cannot be written.
      return tx`INSERT INTO conversations (tenant_id, title) VALUES (${GLOBEX}::uuid, 'smuggled')`;
    });

    await expect(attempt).rejects.toThrow(/row-level security/i);
  });

  it('does not leak the tenant setting to the next transaction on the same connection', async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${ACME}, true)`;
      return tx`SELECT 1`;
    });

    // set_config(..., true) is transaction-LOCAL. A session-level setting here
    // would leak to whichever request borrowed this pooled connection next.
    const after = await sql`SELECT current_setting('app.current_tenant', true) AS t`;
    expect((after[0] as any).t ?? '').toBe('');
  });

  it('cannot turn RLS off, because the app role does not own the tables', async () => {
    await expect(sql`ALTER TABLE conversations DISABLE ROW LEVEL SECURITY`).rejects.toThrow(/must be owner|permission denied/i);
  });

  it('cannot create or delete tenants', async () => {
    await expect(
      sql`INSERT INTO tenants (slug, name) VALUES ('rogue', 'Rogue')`,
    ).rejects.toThrow(/permission denied/i);
  });
});
