import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { createDb } from '../src/db/client';
import { TEST_DATABASE_URL } from './env';

/** Creates the test database if needed and applies migrations. Refuses non "_test" databases. */
export default async function setup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${dbName}": the database name must end with _test`,
    );
  }

  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query('select 1 from pg_database where datname = $1', [dbName]);
  if (exists.rowCount === 0) await client.query(`create database "${dbName}"`);
  await client.end();

  const { db, pool } = createDb(TEST_DATABASE_URL);
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  await pool.end();
}
