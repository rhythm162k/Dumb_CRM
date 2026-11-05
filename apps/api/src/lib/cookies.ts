import type { Response } from 'express';
import type { Config } from '../config';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const OAUTH_STATE_COOKIE = 'oauth_state';
export const AUTH_PATH = '/api/auth';

export const baseCookie = (config: Config) => ({
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'lax' as const,
});

export function setAuthCookies(
  res: Response,
  config: Config,
  session: { accessToken: string; refreshToken: string },
) {
  res.cookie(ACCESS_COOKIE, session.accessToken, {
    ...baseCookie(config),
    path: '/',
    maxAge: config.ACCESS_TOKEN_TTL_MIN * 60_000,
  });
  // the refresh token is only ever sent to the auth endpoints
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    ...baseCookie(config),
    path: AUTH_PATH,
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearAuthCookies(res: Response, config: Config) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(config), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(config), path: AUTH_PATH });
}
