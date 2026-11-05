import { sql } from 'drizzle-orm';
import request from 'supertest';
import type { Express } from 'express';
import type { WorkspaceRole } from '@crm/shared';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { workspaceMembers } from '../src/db/schema';
import { MemoryEmailService } from '../src/services/email';
import type { GoogleClient } from '../src/services/google';
import { TEST_DATABASE_URL } from './env';

const { db, pool } = createDb(TEST_DATABASE_URL);
export { db };

export const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-1234',
  BCRYPT_COST: '4', // fast hashes in tests
  AUTH_RATE_LIMIT_MAX: '1000',
};

export function buildApp(opts: { google?: GoogleClient; env?: Record<string, string> } = {}) {
  const config = loadConfig({ ...baseEnv, ...opts.env });
  const email = new MemoryEmailService();
  const app = createApp({ config, db, email, google: opts.google, checkDb: async () => true });
  return { app, email, config };
}

export async function resetDb() {
  await db.execute(
    sql`truncate table audit_logs, activities, deals, contacts, companies, email_tokens, refresh_tokens, workspace_members, workspaces, users restart identity cascade`,
  );
}

export const closeDb = () => pool.end();

export const strongPassword = 'correct-horse-battery';
let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}${++counter}@example.com`;

export async function signUp(app: Express, overrides: Record<string, unknown> = {}) {
  const agent = request.agent(app);
  const body = { name: 'Test User', email: uniqueEmail(), password: strongPassword, ...overrides };
  const res = await agent.post('/api/auth/register').send(body);
  return {
    agent,
    res,
    body,
    userId: res.body?.user?.id as string,
    workspaceId: res.body?.workspaces?.[0]?.id as string,
  };
}

export async function addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
  await db.insert(workspaceMembers).values({ workspaceId, userId, role });
}

/** "name=value" pairs from a response's Set-Cookie headers. */
export function cookiePairs(res: { headers: Record<string, unknown> }): string[] {
  const raw = (res.headers['set-cookie'] ?? []) as string[];
  return raw.map((c) => c.split(';')[0] ?? '');
}
