import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Migrations run as the OWNER. The app never uses this URL at runtime.
    url: process.env.DATABASE_URL!,
  },
  strict: false,
  verbose: true,
});
