import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshTokens, users, workspaceMembers } from '../src/db/schema';
import type { GoogleClient } from '../src/services/google';
import {
  buildApp,
  closeDb,
  cookiePairs,
  db,
  resetDb,
  signUp,
  strongPassword,
  uniqueEmail,
} from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

describe('registration', () => {
  it('creates the user, a workspace and an owner membership, and signs in', async () => {
    const { app } = buildApp();
    const { agent, res, body } = await signUp(app, { workspaceName: 'Acme' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(body.email);
    expect(res.body.user.emailVerified).toBe(false);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.workspaces[0]).toMatchObject({ name: 'Acme', role: 'owner' });

    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/access_token=.*HttpOnly/i);
    expect(cookies).toMatch(/refresh_token=.*Path=\/api\/auth.*HttpOnly/i);

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(body.email);
  });

  it('stores a bcrypt hash, never the password', async () => {
    const { app } = buildApp();
    const { body } = await signUp(app);
    const [row] = await db.select().from(users).where(eq(users.email, body.email));
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(row?.passwordHash).not.toContain(strongPassword);
  });

  it('rejects weak passwords and invalid emails', async () => {
    const { app } = buildApp();
    expect((await signUp(app, { password: 'short' })).res.status).toBe(400);
    expect((await signUp(app, { email: 'not-an-email' })).res.status).toBe(400);
    expect((await signUp(app, { password: 'x'.repeat(73) })).res.status).toBe(400);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const { app } = buildApp();
    const first = await signUp(app, { email: 'Same@Example.com' });
    expect(first.res.status).toBe(201);
    const second = await signUp(app, { email: 'same@example.com' });
    expect(second.res.status).toBe(409);
  });

  it('sends a verification email', async () => {
    const { app, email } = buildApp();
    await signUp(app);
    expect(email.sent).toHaveLength(1);
    expect(email.lastToken()).toBeTruthy();
  });

  it('does not sign in when verification is required', async () => {
    const { app } = buildApp({ env: { REQUIRE_EMAIL_VERIFICATION: 'true' } });
    const { agent, res } = await signUp(app);
    expect(res.status).toBe(201);
    expect(res.body.verificationRequired).toBe(true);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('login', () => {
  it('signs in with correct credentials (case-insensitive email)', async () => {
    const { app } = buildApp();
    const { body } = await signUp(app, { email: 'Mixed@Example.com' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email.toUpperCase(), password: strongPassword });
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const { app } = buildApp();
    const { body } = await signUp(app);
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: 'wrong-password-1' });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail('nobody'), password: 'wrong-password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('locks the account after 5 failed attempts, even for the right password', async () => {
    const { app } = buildApp();
    const { body } = await signUp(app);
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/auth/login')
        .send({ email: body.email, password: 'wrong-password-1' });
      expect(r.status).toBe(401);
    }
    const locked = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: strongPassword });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('locked');
  });

  it('rate limits repeated auth requests per IP', async () => {
    const { app } = buildApp({ env: { AUTH_RATE_LIMIT_MAX: '3' } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/auth/login')
        .send({ email: uniqueEmail(), password: 'wrong-password-1' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[4]).toBe(429);
  });

  it('blocks unverified users when verification is required', async () => {
    const { app } = buildApp({ env: { REQUIRE_EMAIL_VERIFICATION: 'true' } });
    const { body } = await signUp(app);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: strongPassword });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('email_not_verified');
  });
});

describe('sessions', () => {
  it('requires authentication for /me', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a tampered access token', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/auth/me').set('Cookie', 'access_token=not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('rotates refresh tokens and revokes all sessions when an old one is reused', async () => {
    const { app } = buildApp();
    const { body } = await signUp(app);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: strongPassword });
    const cookiesA = cookiePairs(login).join('; ');

    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookiesA);
    expect(refreshed.status).toBe(204);
    const cookiesB = cookiePairs(refreshed).join('; ');
    expect(cookiesB).not.toEqual(cookiesA);

    // replaying the already-rotated token is treated as theft
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', cookiesA);
    expect(replay.status).toBe(401);

    // ...which also kills the newer token
    const afterReplay = await request(app).post('/api/auth/refresh').set('Cookie', cookiesB);
    expect(afterReplay.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { app } = buildApp();
    const { body } = await signUp(app);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: strongPassword });
    const cookies = cookiePairs(login).join('; ');

    expect((await request(app).post('/api/auth/logout').set('Cookie', cookies)).status).toBe(204);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookies)).status).toBe(401);
  });

  it('refuses refresh without a cookie', async () => {
    const { app } = buildApp();
    expect((await request(app).post('/api/auth/refresh')).status).toBe(401);
  });
});

describe('csrf protection', () => {
  it('blocks state-changing requests from a foreign origin', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: uniqueEmail(), password: strongPassword });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf');
  });

  it('allows the configured web origin', async () => {
    const { app, config } = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', config.WEB_ORIGIN)
      .send({ email: uniqueEmail(), password: strongPassword });
    expect(res.status).toBe(401); // reached the handler
  });
});

describe('email verification', () => {
  it('verifies the email once, and the link cannot be reused', async () => {
    const { app, email } = buildApp();
    const { agent } = await signUp(app);
    const token = email.lastToken();

    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(204);
    expect((await agent.get('/api/auth/me')).body.user.emailVerified).toBe(true);
    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(400);
  });

  it('rejects an unknown token', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: 'x'.repeat(43) });
    expect(res.status).toBe(400);
  });
});

describe('password reset', () => {
  it('does not reveal whether an account exists', async () => {
    const { app, email } = buildApp();
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: uniqueEmail('ghost') });
    expect(res.status).toBe(204);
    expect(email.sent).toHaveLength(0);
  });

  it('resets the password, signs out other sessions and works only once', async () => {
    const { app, email } = buildApp();
    const { body } = await signUp(app);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: strongPassword });
    const oldCookies = cookiePairs(login).join('; ');

    await request(app).post('/api/auth/forgot-password').send({ email: body.email });
    const token = email.lastToken();
    const newPassword = 'a-brand-new-password';

    expect(
      (await request(app).post('/api/auth/reset-password').send({ token, password: newPassword }))
        .status,
    ).toBe(204);
    expect(
      (await request(app).post('/api/auth/reset-password').send({ token, password: newPassword }))
        .status,
    ).toBe(400);

    expect((await request(app).post('/api/auth/refresh').set('Cookie', oldCookies)).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: body.email, password: strongPassword })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: body.email, password: newPassword })
      ).status,
    ).toBe(200);
  });

  it('enforces the password policy on reset', async () => {
    const { app, email } = buildApp();
    const { body } = await signUp(app);
    await request(app).post('/api/auth/forgot-password').send({ email: body.email });
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: email.lastToken(), password: 'short' });
    expect(res.status).toBe(400);
  });

  it('resetting clears a lockout', async () => {
    const { app, email } = buildApp();
    const { body } = await signUp(app);
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: body.email, password: 'wrong-password-1' });
    }
    await request(app).post('/api/auth/forgot-password').send({ email: body.email });
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: email.lastToken(), password: 'fresh-password-123' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: 'fresh-password-123' });
    expect(res.status).toBe(200);
  });
});

describe('google sign-in', () => {
  const makeGoogle = (profile: Partial<Awaited<ReturnType<GoogleClient['profile']>>> = {}) => {
    const client: GoogleClient = {
      authUrl: (state) => `https://accounts.example/auth?state=${state}`,
      profile: vi.fn(async () => ({
        sub: 'google-123',
        email: 'g.user@example.com',
        emailVerified: true,
        name: 'G User',
        ...profile,
      })),
    };
    return client;
  };

  async function startFlow(app: ReturnType<typeof buildApp>['app']) {
    const agent = request.agent(app);
    const start = await agent.get('/api/auth/google');
    expect(start.status).toBe(302);
    const state = new URL(start.headers['location'] as string).searchParams.get('state');
    return { agent, state };
  }

  it('is unavailable when not configured', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/api/auth/google')).status).toBe(501);
  });

  it('creates an account with a workspace and signs in', async () => {
    const { app } = buildApp({ google: makeGoogle() });
    const { agent, state } = await startFlow(app);
    const cb = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers['location']).not.toContain('error');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: 'g.user@example.com', emailVerified: true });
    expect(me.body.workspaces).toHaveLength(1);
  });

  it('rejects a callback whose state does not match', async () => {
    const { app } = buildApp({ google: makeGoogle() });
    const { agent } = await startFlow(app);
    const cb = await agent.get('/api/auth/google/callback?code=abc&state=forged');
    expect(cb.status).toBe(302);
    expect(cb.headers['location']).toContain('error=google_failed');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('refuses unverified Google emails', async () => {
    const { app } = buildApp({ google: makeGoogle({ emailVerified: false }) });
    const { agent, state } = await startFlow(app);
    const cb = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
    expect(cb.headers['location']).toContain('error=google_failed');
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('links to an existing account with the same email instead of duplicating it', async () => {
    const { app } = buildApp({ google: makeGoogle() });
    const existing = await signUp(app, { email: 'g.user@example.com' });
    const { agent, state } = await startFlow(app);
    await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);

    const me = await agent.get('/api/auth/me');
    expect(me.body.user.id).toBe(existing.userId);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(workspaceMembers)).toHaveLength(1);
  });
});

describe('data hygiene', () => {
  it('stores only hashes of refresh tokens', async () => {
    const { app } = buildApp();
    const { res } = await signUp(app);
    const raw = cookiePairs(res)
      .find((c) => c.startsWith('refresh_token='))
      ?.split('=')[1];
    const rows = await db.select().from(refreshTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(raw);
  });
});
