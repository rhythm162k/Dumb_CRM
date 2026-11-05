import type { RequestHandler } from 'express';
import type { Config } from '../config';
import { AppError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie auth: SameSite=Lax cookies plus a rejection of any
 * state-changing request whose Origin header is not our web app.
 */
export const originCheck = (config: Config): RequestHandler => {
  const allowed = new URL(config.WEB_ORIGIN).origin;
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== allowed) {
      throw new AppError(403, 'Cross-origin request blocked', 'csrf');
    }
    next();
  };
};
