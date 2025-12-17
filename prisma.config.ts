import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Load .env.local first, fall back to .env
config({ path: '.env.local' });
config({ path: '.env' });

// Use placeholder during build (prisma generate doesn't need real DB connection)
// Real DATABASE_URL is required at runtime for migrations and queries
const databaseUrl = process.env.DATABASE_URL || 'postgresql://placeholder:placeholder@localhost:5432/placeholder';

export default defineConfig({
  earlyAccess: true,
  schema: './prisma/schema.prisma',
  migrate: {
    adapter: async () => {
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      return new PrismaPg(pool);
    },
  },
  datasource: {
    url: databaseUrl,
  },
});
