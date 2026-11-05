import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/client';
import { MemoryEmailService } from '../src/services/email';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://x',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
});
const make = (checkDb: () => Promise<boolean>) =>
  createApp({ config, db: {} as Db, email: new MemoryEmailService(), checkDb });

describe('GET /health', () => {
  it('returns 200 when the database is up', async () => {
    const res = await request(make(async () => true)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('returns 503 when the database is down', async () => {
    const res = await request(make(async () => false)).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', db: 'down' });
  });

  it('returns 503 when the database check throws', async () => {
    const res = await request(
      make(async () => {
        throw new Error('boom');
      }),
    ).get('/health');
    expect(res.status).toBe(503);
  });

  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(make(async () => true)).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(make(async () => true)).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns a JSON 400 for malformed JSON bodies', async () => {
    const res = await request(make(async () => true))
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });
});
