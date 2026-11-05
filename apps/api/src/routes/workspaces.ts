import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { WORKSPACE_ROLES } from '@crm/shared';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { users, workspaceMembers, workspaces } from '../db/schema';
import { wrap } from '../lib/async';
import { one } from '../lib/db';
import { authenticate, requireMember, requirePermission } from '../middleware/auth';
import { AppError } from '../middleware/errors';
import { getMember, listWorkspacesFor } from '../services/workspaces';

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });
const roleSchema = z.object({ role: z.enum(WORKSPACE_ROLES) });
const uuid = z.guid(); // any 8-4-4-4-12 hex id, like zod 3's .uuid()

export function workspacesRouter({ config, db }: { config: Config; db: Db }) {
  const r = Router();
  r.use(authenticate(config));

  r.get(
    '/',
    wrap(async (req, res) => {
      res.json({ workspaces: await listWorkspacesFor(db, req.userId ?? '') });
    }),
  );

  r.post(
    '/',
    wrap(async (req, res) => {
      const { name } = createSchema.parse(req.body);
      const userId = req.userId ?? '';
      const workspace = await db.transaction(async (tx) => {
        const ws = one(await tx.insert(workspaces).values({ name }).returning());
        await tx.insert(workspaceMembers).values({ workspaceId: ws.id, userId, role: 'owner' });
        return ws;
      });
      res
        .status(201)
        .json({ workspace: { id: workspace.id, name: workspace.name, role: 'owner' } });
    }),
  );

  // everything below is scoped to one workspace the caller must belong to
  const scoped = Router({ mergeParams: true });
  r.use('/:workspaceId', requireMember(db), scoped);

  scoped.get(
    '/',
    wrap(async (req, res) => {
      const ws = req.workspace;
      const [row] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, ws?.id ?? ''))
        .limit(1);
      res.json({ workspace: { ...row, role: ws?.role } });
    }),
  );

  scoped.get(
    '/members',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const members = await db
        .select({
          userId: users.id,
          name: users.name,
          email: users.email,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, req.workspace?.id ?? ''));
      res.json({ members });
    }),
  );

  scoped.patch(
    '/members/:userId',
    requirePermission('members:manage'),
    wrap(async (req, res) => {
      const { role } = roleSchema.parse(req.body);
      const targetId = uuid.parse(req.params['userId']);
      const actor = req.workspace;
      if (!actor) throw new AppError(404, 'Workspace not found', 'not_found');

      if (targetId === req.userId) {
        throw new AppError(400, 'You cannot change your own role', 'invalid_target');
      }
      const target = await getMember(db, actor.id, targetId);
      if (!target) throw new AppError(404, 'Member not found', 'not_found');

      // only owners may grant or change the owner role
      if ((target.role === 'owner' || role === 'owner') && actor.role !== 'owner') {
        throw new AppError(403, 'Only an owner can change owner roles', 'forbidden');
      }
      await db
        .update(workspaceMembers)
        .set({ role })
        .where(
          and(eq(workspaceMembers.workspaceId, actor.id), eq(workspaceMembers.userId, targetId)),
        );
      res.json({ member: { userId: targetId, role } });
    }),
  );

  scoped.delete(
    '/members/:userId',
    requirePermission('members:manage'),
    wrap(async (req, res) => {
      const targetId = uuid.parse(req.params['userId']);
      const actor = req.workspace;
      if (!actor) throw new AppError(404, 'Workspace not found', 'not_found');

      if (targetId === req.userId) {
        throw new AppError(400, 'You cannot remove yourself', 'invalid_target');
      }
      const target = await getMember(db, actor.id, targetId);
      if (!target) throw new AppError(404, 'Member not found', 'not_found');
      if (target.role === 'owner' && actor.role !== 'owner') {
        throw new AppError(403, 'Only an owner can remove an owner', 'forbidden');
      }
      await db
        .delete(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, actor.id), eq(workspaceMembers.userId, targetId)),
        );
      res.status(204).end();
    }),
  );

  return r;
}
