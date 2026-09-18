-- ---------------------------------------------------------------------------
-- Tenant isolation, enforced by Postgres rather than by remembering to add a
-- WHERE clause.
--
-- The application connects as `polyglot_app`. That role:
--   * is not the table owner, so it cannot ALTER ... DISABLE ROW LEVEL SECURITY
--   * does not have BYPASSRLS
--   * sees only rows whose tenant_id matches app.current_tenant, a setting that
--     is set per transaction by withTenant() and reset when it commits
--
-- A new engineer who writes `select * from messages` on Monday gets their own
-- tenant's messages. There is no query they can write, from the application
-- role, that returns another tenant's rows.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'polyglot_app') THEN
    CREATE ROLE polyglot_app LOGIN PASSWORD 'polyglot_app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO polyglot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO polyglot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO polyglot_app;

-- Helper: NULL when unset, which makes every policy comparison NULL, which
-- denies. Forgetting to call withTenant() therefore returns zero rows rather
-- than every row — the failure mode points the safe way.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversations', 'messages', 'collections', 'documents', 'chunks', 'request_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE also applies the policy to the table owner. Without it, a migration
    -- script or a psql session as the owner silently sees everything.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- `tenants` is a CONTROL-PLANE table, and is handled differently on purpose.
--
-- Provisioning a tenant, and resolving an inbound identifier to a tenant, both
-- happen BEFORE any tenant context exists — you cannot scope a lookup by the
-- thing you are looking up. So RLS is ENABLEd (the app role sees only its own
-- row) but NOT FORCEd, leaving the owner role able to administer the table.
--
-- FORCE here would deadlock the system: the owner could not seed a tenant, and
-- the middleware's slug lookup would return zero rows, 401ing every request.
-- The app role is instead locked down by GRANT: it can read its own row and
-- nothing else, and it cannot create, rename or delete a tenant at all.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants FOR SELECT USING (id = current_tenant_id());
REVOKE INSERT, UPDATE, DELETE ON tenants FROM polyglot_app;

-- ---------------------------------------------------------------------------
-- The access log is the audit trail, so the app role may append to it and
-- nothing else — it must not be able to read other tenants' entries, edit its
-- own, or erase evidence. NOT FORCEd so an operator (owner) can actually read
-- the trail; an audit log nobody can query is not an audit log.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_access_log NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_log_insert ON tenant_access_log;
CREATE POLICY access_log_insert ON tenant_access_log FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS access_log_read_own ON tenant_access_log;
CREATE POLICY access_log_read_own ON tenant_access_log FOR SELECT USING (tenant_id = current_tenant_id());
REVOKE UPDATE, DELETE ON tenant_access_log FROM polyglot_app;

-- Vector index. Cosine because our embeddings are normalized; HNSW because
-- recall matters more than build time for a corpus this size.
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);
