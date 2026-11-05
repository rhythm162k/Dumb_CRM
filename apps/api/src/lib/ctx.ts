import type { Request } from 'express';
import { AppError } from '../middleware/errors';

/** Caller identity and workspace, set by authenticate + requireMember. */
export function ctx(req: Request) {
  if (!req.userId || !req.workspace) throw new AppError(401, 'Sign in required', 'unauthorized');
  return { userId: req.userId, workspaceId: req.workspace.id, role: req.workspace.role };
}

export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
