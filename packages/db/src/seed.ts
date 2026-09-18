/**
 * Demo tenants with fixed UUIDs so the UI's tenant switcher and the docs can
 * refer to them by value. Seeding runs as the owner because creating a tenant
 * is by definition something that happens outside any tenant's context.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const TENANTS = [
  { id: '11111111-1111-4111-8111-111111111111', slug: 'acme', name: 'Acme Corp' },
  { id: '22222222-2222-4222-8222-222222222222', slug: 'globex', name: 'Globex Inc' },
];

const sql = postgres(url, { max: 1 });

try {
  for (const t of TENANTS) {
    await sql`
      INSERT INTO tenants (id, slug, name)
      VALUES (${t.id}::uuid, ${t.slug}, ${t.name})
      ON CONFLICT (slug) DO NOTHING
    `;
    console.log(`  ${t.slug.padEnd(8)} ${t.id}`);
  }
  console.log('\n✓ tenants seeded.');
} finally {
  await sql.end();
}
