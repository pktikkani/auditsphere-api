import { config } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Load .env.local first, fall back to .env
config({ path: '.env.local' });
config({ path: '.env' });

export default defineConfig({
  earlyAccess: true,
  schema: './schema.prisma',
  migrate: {
    adapter: async () => {
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      return new PrismaPg(pool);
    },
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
