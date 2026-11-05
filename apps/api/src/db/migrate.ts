import path from 'node:path';
import dotenv from 'dotenv';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, sslFromEnv } from './client';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url, { ssl: sslFromEnv(process.env.DATABASE_SSL), max: 1 });
  // works from src/db (tsx) and from dist (bundled)
  const folder = __dirname.endsWith('dist')
    ? path.resolve(__dirname, '../drizzle')
    : path.resolve(__dirname, '../../drizzle');
  await migrate(db, { migrationsFolder: folder });
  await pool.end();
  console.log('Migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
