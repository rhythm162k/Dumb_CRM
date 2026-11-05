import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { connectionOptions, createDb, sslFromEnv, type Db } from '../src/db/client';
import { ConsoleEmailService, MemoryEmailService } from '../src/services/email';

const env = { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'x'.repeat(40) };

afterEach(() => vi.restoreAllMocks());

describe('deployment settings', () => {
  it('has safe defaults', () => {
    const c = loadConfig(env);
    expect(c).toMatchObject({
      TRUST_PROXY: 1,
      DATABASE_SSL: 'off',
      DB_POOL_MAX: 10,
      DEBUG_CLIENT_IP: false,
    });
  });

  it('accepts overrides and rejects nonsense', () => {
    const c = loadConfig({
      ...env,
      TRUST_PROXY: '2',
      DATABASE_SSL: 'require',
      DB_POOL_MAX: '5',
      DEBUG_CLIENT_IP: 'true',
    });
    expect(c).toMatchObject({
      TRUST_PROXY: 2,
      DATABASE_SSL: 'require',
      DB_POOL_MAX: 5,
      DEBUG_CLIENT_IP: true,
    });
    expect(() => loadConfig({ ...env, DATABASE_SSL: 'maybe' })).toThrow(/DATABASE_SSL/);
    expect(() => loadConfig({ ...env, TRUST_PROXY: '9' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...env, DB_POOL_MAX: '0' })).toThrow(/DB_POOL_MAX/);
  });
});

describe('database connection options', () => {
  const url =
    'postgresql://postgres.abc:p%40ss%23word@aws-0-eu.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true&application_name=kin';

  it('leaves the URL alone when TLS is off', () => {
    expect(connectionOptions(url, 'off')).toEqual({ connectionString: url });
  });

  it('require: encrypts without verifying, and drops URL ssl parameters that would override it', () => {
    const o = connectionOptions(url, 'require');
    expect(o.ssl).toEqual({ rejectUnauthorized: false });
    const parsed = new URL(o.connectionString ?? '');
    expect(parsed.searchParams.has('sslmode')).toBe(false);
    expect(parsed.searchParams.has('uselibpqcompat')).toBe(false);
    expect(parsed.searchParams.get('application_name')).toBe('kin');
    expect(parsed.username).toBe('postgres.abc');
    expect(parsed.password).toBe('p%40ss%23word');
    expect(parsed.host).toBe('aws-0-eu.pooler.supabase.com:6543');
    expect(parsed.pathname).toBe('/postgres');
  });

  it('verify: full certificate verification', () => {
    expect(connectionOptions(url, 'verify').ssl).toBe(true);
  });

  it('reads the mode from an environment value', () => {
    expect(sslFromEnv('require')).toBe('require');
    expect(sslFromEnv('verify')).toBe('verify');
    expect(sslFromEnv('anything else')).toBe('off');
    expect(sslFromEnv(undefined)).toBe('off');
  });

  it('survives an idle connection error instead of crashing the process', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { pool } = createDb('postgresql://u:p@127.0.0.1:1/none');
    expect(() =>
      pool.emit('error', new Error('terminating connection due to administrator command')),
    ).not.toThrow();
    await pool.end();
  });
});

describe('health alias and production email logging', () => {
  it('serves health at /health and /api/health', async () => {
    const app = createApp({
      config: loadConfig(env),
      db: {} as Db,
      email: new MemoryEmailService(),
      checkDb: async () => true,
    });
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok', db: 'up' });
  });

  it('never prints email bodies (reset links) in production', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const message = {
      to: 'a@example.com',
      subject: 'Reset your password',
      text: 'https://app/reset?token=SECRET',
      html: '',
    };
    await new ConsoleEmailService(true).send(message);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(log.mock.calls)).toContain('Reset your password');

    log.mockClear();
    await new ConsoleEmailService().send(message);
    expect(JSON.stringify(log.mock.calls)).toContain('SECRET'); // dev still prints the link
  });
});
