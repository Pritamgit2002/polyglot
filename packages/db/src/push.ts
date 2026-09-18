/**
 * One-command schema setup:
 *   1. extensions (vector, pgcrypto) — must exist before a vector column
 *   2. drizzle-kit push, as the owner
 *   3. roles, grants, RLS policies and the HNSW index
 *
 * Step 3 is deliberately separate from the drizzle schema: policies are
 * security, and security belongs in a reviewable SQL file, not buried in an
 * ORM's generated diff.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const sqlFile = (name: string) => readFileSync(fileURLToPath(new URL(`../sql/${name}`, import.meta.url)), 'utf8');

// Silence NOTICEs: 'DROP POLICY IF EXISTS ... skipping' on a first run is
// expected and drowns out real output.
const owner = postgres(url, { max: 1, onnotice: () => {} });

try {
  console.log('→ extensions');
  try {
    await owner.unsafe(sqlFile('0000_extensions.sql'));
  } catch (e) {
    // CREATE EXTENSION needs a superuser, and the owner role is deliberately
    // NOT one: a superuser bypasses RLS outright, which would hollow out the
    // whole tenant-isolation model. Managed Postgres (Neon, RDS) pre-installs
    // these for the same reason, so this only bites on a local database.
    if (String(e).includes('permission denied to create extension')) {
      console.error(
        `\n✗ "${url!.split('/').pop()}" is missing the vector extension, and the app's owner role is` +
          '\n  not a superuser (on purpose — a superuser bypasses row-level security).' +
          '\n\n  Install it once as a superuser:\n' +
          `\n    psql -d ${url!.split('/').pop()?.split('?')[0]} -c 'CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;'\n`,
      );
      process.exit(1);
    }
    throw e;
  }

  console.log('→ tables (drizzle-kit push)');
  execSync('npx drizzle-kit push --force', { stdio: 'inherit', env: process.env });

  console.log('→ roles, RLS policies, vector index');
  await owner.unsafe(sqlFile('0002_policies.sql'));

  console.log('\n✓ schema ready. Run `npm run db:seed` to create demo tenants.');
} catch (e) {
  console.error('\n✗ push failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await owner.end();
}
