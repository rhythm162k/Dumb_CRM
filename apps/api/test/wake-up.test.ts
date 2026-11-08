import http from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/client';
import { RENDER_TRUST_PROXY } from '../src/lib/proxy';
import { applyServerTimeouts } from '../src/lib/server-timeouts';
import { MemoryEmailService } from '../src/services/email';

const env = { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'x'.repeat(40) };
const make = (checkDb: () => Promise<boolean>) =>
  createApp({ config: loadConfig(env), db: {} as Db, email: new MemoryEmailService(), checkDb });

describe('liveness endpoint', () => {
  it('answers without touching the database, so a slow database cannot get the service restarted', async () => {
    let touched = false;
    const app = make(async () => {
      touched = true;
      throw new Error('database is down');
    });
    const res = await request(app).get('/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(touched).toBe(false);
  });

  it('keeps /health honest about the database and uncacheable', async () => {
    const down = await request(make(async () => false)).get('/health');
    expect(down.status).toBe(503);
    const up = await request(make(async () => true)).get('/api/health');
    expect(up.status).toBe(200);
    expect(up.headers['cache-control']).toBe('no-store');
  });
});

describe('server timeouts', () => {
  it('keeps connections open longer than the proxies in front of the API', () => {
    const server = applyServerTimeouts(http.createServer());
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });
});

describe('TRUST_PROXY setting', () => {
  it('accepts render, a hop count, and rejects anything else', () => {
    expect(loadConfig({ ...env, TRUST_PROXY: 'render' }).TRUST_PROXY).toBe(RENDER_TRUST_PROXY);
    expect(loadConfig({ ...env, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(loadConfig(env).TRUST_PROXY).toBe(1);
    expect(() => loadConfig({ ...env, TRUST_PROXY: 'cloudflare' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...env, TRUST_PROXY: '9' })).toThrow(/TRUST_PROXY/);
  });
});
