import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type DbSsl = 'off' | 'require' | 'verify';

export const sslFromEnv = (value: string | undefined): DbSsl =>
  value === 'require' || value === 'verify' ? value : 'off';

/**
 * pg options for a connection string. With TLS on, sslmode and friends are removed from the URL
 * because pg lets URL parameters override the explicit `ssl` option, which would silently turn
 * `sslmode=require` into full certificate verification (Supabase's poolers then fail with
 * "self-signed certificate in certificate chain").
 *   require: encrypted, certificate not verified (same meaning as libpq's sslmode=require)
 *   verify:  encrypted and verified against the system CAs (set NODE_EXTRA_CA_CERTS for a custom CA)
 */
export function connectionOptions(url: string, ssl: DbSsl = 'off'): PoolConfig {
  if (ssl === 'off') return { connectionString: url };
  const parsed = new URL(url);
  for (const key of ['sslmode', 'ssl', 'uselibpqcompat', 'sslcert', 'sslkey', 'sslrootcert']) {
    parsed.searchParams.delete(key);
  }
  return {
    connectionString: parsed.toString(),
    ssl: ssl === 'require' ? { rejectUnauthorized: false } : true,
  };
}

export function createDb(connectionString: string, opts: { ssl?: DbSsl; max?: number } = {}) {
  const pool = new Pool({
    ...connectionOptions(connectionString, opts.ssl),
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000, // fail fast instead of hanging when the database is unreachable
  });
  // A connection that the database or pooler drops while idle emits 'error' on the pool.
  // Without a listener Node treats it as an uncaught exception and the whole API crashes.
  pool.on('error', (err) => {
    console.error('Idle database client error:', err.message);
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
