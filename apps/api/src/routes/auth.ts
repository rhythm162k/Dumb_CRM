import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
} from '@crm/shared';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { wrap } from '../lib/async';
import {
  AUTH_PATH,
  OAUTH_STATE_COOKIE,
  REFRESH_COOKIE,
  baseCookie,
  clearAuthCookies,
  setAuthCookies,
} from '../lib/cookies';
import { randomToken, safeEqual } from '../lib/tokens';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errors';
import { toPublicUser, type AuthService } from '../services/auth';
import type { GoogleClient } from '../services/google';
import { listWorkspacesFor } from '../services/workspaces';

interface Deps {
  config: Config;
  db: Db;
  auth: AuthService;
  google?: GoogleClient;
}

export function authRouter({ config, db, auth, google }: Deps) {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const requireAuth = authenticate(config);

  r.post(
    '/register',
    limiter,
    wrap(async (req, res) => {
      const input = registerSchema.parse(req.body);
      const { user, workspace } = await auth.register(input);
      const workspaces = [{ id: workspace.id, name: workspace.name, role: 'owner' as const }];

      if (config.REQUIRE_EMAIL_VERIFICATION) {
        res.status(201).json({ user: toPublicUser(user), workspaces, verificationRequired: true });
        return;
      }
      setAuthCookies(res, config, await auth.startSession(user.id, req.get('user-agent')));
      res.status(201).json({ user: toPublicUser(user), workspaces, verificationRequired: false });
    }),
  );

  r.post(
    '/login',
    limiter,
    wrap(async (req, res) => {
      const { email, password } = loginSchema.parse(req.body);
      const user = await auth.login(email, password);
      setAuthCookies(res, config, await auth.startSession(user.id, req.get('user-agent')));
      res.json({ user: toPublicUser(user), workspaces: await listWorkspacesFor(db, user.id) });
    }),
  );

  r.post(
    '/refresh',
    wrap(async (req, res) => {
      const raw: unknown = req.cookies?.[REFRESH_COOKIE];
      try {
        if (typeof raw !== 'string') throw new AppError(401, 'Session expired', 'unauthorized');
        setAuthCookies(res, config, await auth.refresh(raw, req.get('user-agent')));
        res.status(204).end();
      } catch (err) {
        clearAuthCookies(res, config);
        throw err;
      }
    }),
  );

  r.post(
    '/logout',
    wrap(async (req, res) => {
      const raw: unknown = req.cookies?.[REFRESH_COOKIE];
      await auth.logout(typeof raw === 'string' ? raw : undefined);
      clearAuthCookies(res, config);
      res.status(204).end();
    }),
  );

  r.get(
    '/me',
    requireAuth,
    wrap(async (req, res) => {
      const user = await auth.getUser(req.userId ?? '');
      if (!user) throw new AppError(401, 'Sign in required', 'unauthorized');
      res.json({ user: toPublicUser(user), workspaces: await listWorkspacesFor(db, user.id) });
    }),
  );

  r.post(
    '/verify-email',
    limiter,
    wrap(async (req, res) => {
      await auth.verifyEmail(tokenSchema.parse(req.body).token);
      res.status(204).end();
    }),
  );

  r.post(
    '/resend-verification',
    requireAuth,
    limiter,
    wrap(async (req, res) => {
      await auth.resendVerification(req.userId ?? '');
      res.status(204).end();
    }),
  );

  r.post(
    '/forgot-password',
    limiter,
    wrap(async (req, res) => {
      await auth.requestPasswordReset(forgotPasswordSchema.parse(req.body).email);
      res.status(204).end();
    }),
  );

  r.post(
    '/reset-password',
    limiter,
    wrap(async (req, res) => {
      const { token, password } = resetPasswordSchema.parse(req.body);
      await auth.resetPassword(token, password);
      res.status(204).end();
    }),
  );

  // ---------- Google OAuth (authorization code flow) ----------
  r.get('/google', (_req, res) => {
    if (!google) throw new AppError(501, 'Google sign-in is not configured', 'not_configured');
    const state = randomToken();
    res.cookie(OAUTH_STATE_COOKIE, state, {
      ...baseCookie(config),
      path: AUTH_PATH,
      maxAge: 10 * 60_000,
    });
    res.redirect(google.authUrl(state));
  });

  r.get(
    '/google/callback',
    wrap(async (req, res) => {
      if (!google) throw new AppError(501, 'Google sign-in is not configured', 'not_configured');
      const failure = `${config.WEB_ORIGIN}/login?error=google_failed`;
      const expected: unknown = req.cookies?.[OAUTH_STATE_COOKIE];
      res.clearCookie(OAUTH_STATE_COOKIE, { ...baseCookie(config), path: AUTH_PATH });

      const { code, state, error } = req.query;
      if (error || typeof code !== 'string' || !safeEqual(state, expected)) {
        res.redirect(failure);
        return;
      }
      try {
        const user = await auth.loginWithGoogle(await google.profile(code));
        setAuthCookies(res, config, await auth.startSession(user.id, req.get('user-agent')));
        res.redirect(`${config.WEB_ORIGIN}/`);
      } catch (err) {
        console.error('Google sign-in failed', err);
        res.redirect(failure);
      }
    }),
  );

  return r;
}
