import path from 'node:path';
import dotenv from 'dotenv';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, sslFromEnv } from './client';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

const ATTEMPTS = 5;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  // works from src/db (tsx) and from dist (bundled)
  const folder = __dirname.endsWith('dist')
    ? path.resolve(__dirname, '../drizzle')
    : path.resolve(__dirname, '../../drizzle');

  // This runs every time the container starts, including every wake-up of the free server. One slow
  // or dropped first connection to the database must not stop the whole service from starting, so
  // retry a few times. It is safe to repeat: migrations run in a transaction.
  for (let attempt = 1; ; attempt++) {
    const { db, pool } = createDb(url, { ssl: sslFromEnv(process.env.DATABASE_SSL), max: 1 });
    try {
      await migrate(db, { migrationsFolder: folder });
      break;
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`Migration attempt ${attempt} of ${ATTEMPTS} failed (${reason}). Retrying...`);
      await sleep(attempt * 3000);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  console.log('Migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
