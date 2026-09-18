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

const owner = postgres(url, { max: 1 });

try {
  console.log('→ extensions');
  await owner.unsafe(sqlFile('0000_extensions.sql'));

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
