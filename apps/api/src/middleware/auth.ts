import type { RequestHandler } from 'express';
import { and, eq } from 'drizzle-orm';
import { can, type Permission } from '@crm/shared';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { workspaceMembers } from '../db/schema';
import { wrap } from '../lib/async';
import { ACCESS_COOKIE } from '../lib/cookies';
import { verifyAccessToken } from '../lib/tokens';
import { AppError } from './errors';

export const authenticate =
  (config: Config): RequestHandler =>
  (req, _res, next) => {
    const token: unknown = req.cookies?.[ACCESS_COOKIE];
    const userId = typeof token === 'string' ? verifyAccessToken(config, token) : null;
    if (!userId) throw new AppError(401, 'Sign in required', 'unauthorized');
    req.userId = userId;
    next();
  };

/**
 * Tenant gate for /workspaces/:workspaceId/*. Non-members get a 404, so a workspace id
 * never reveals whether it exists.
 */
export const requireMember = (db: Db): RequestHandler =>
  wrap(async (req, _res, next) => {
    const workspaceId = req.params['workspaceId'] ?? '';
    if (!z.guid().safeParse(workspaceId).success) {
      throw new AppError(404, 'Workspace not found', 'not_found');
    }
    const [membership] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, req.userId ?? ''),
        ),
      )
      .limit(1);
    if (!membership) throw new AppError(404, 'Workspace not found', 'not_found');
    req.workspace = { id: workspaceId, role: membership.role };
    next();
  });

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.workspace || !can(req.workspace.role, permission)) {
      throw new AppError(403, 'You do not have permission to do this', 'forbidden');
    }
    next();
  };
