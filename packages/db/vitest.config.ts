import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// These are integration tests against a real database, so they need the same
// DATABASE_APP_URL the app uses. Vitest does not read .env on its own.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // One shared database: parallel files would race the "no tenant set" check
    // against another file's seeding.
    fileParallelism: false,
    env: { DATABASE_APP_URL: process.env.DATABASE_APP_URL ?? '' },
  },
});
