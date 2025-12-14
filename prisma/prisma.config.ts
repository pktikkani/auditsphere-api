import { defineConfig } from 'prisma/config';

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
    url: process.env.DATABASE_URL!,
  },
});
