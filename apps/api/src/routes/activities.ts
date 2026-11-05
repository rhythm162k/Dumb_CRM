import { Router } from 'express';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { can, createActivitySchema, listActivitiesQuery, updateActivitySchema } from '@crm/shared';
import { z } from 'zod';
import type { Db } from '../db/client';
import { activities, contacts, deals, users } from '../db/schema';
import { audit } from '../lib/audit';
import { wrap } from '../lib/async';
import { ctx } from '../lib/ctx';
import { one } from '../lib/db';
import { requirePermission } from '../middleware/auth';
import { AppError } from '../middleware/errors';

const uuid = z.guid(); // any 8-4-4-4-12 hex id, like zod 3's .uuid()

export function activitiesRouter(db: Db) {
  const r = Router();

  const columns = {
    id: activities.id,
    type: activities.type,
    content: activities.content,
    dueAt: activities.dueAt,
    completedAt: activities.completedAt,
    contactId: activities.contactId,
    dealId: activities.dealId,
    createdBy: activities.createdBy,
    createdByName: users.name,
    createdAt: activities.createdAt,
  };

  const base = () =>
    db.select(columns).from(activities).leftJoin(users, eq(users.id, activities.createdBy));

  async function get(workspaceId: string, id: string) {
    const [row] = await base()
      .where(and(eq(activities.workspaceId, workspaceId), eq(activities.id, id)))
      .limit(1);
    return row;
  }

  // an activity may only point at a contact / deal from its own workspace
  async function assertLinks(workspaceId: string, contactId: string | null, dealId: string | null) {
    if (contactId) {
      const [c] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
        .limit(1);
      if (!c) throw new AppError(400, 'Contact not found in this workspace', 'invalid_contact');
    }
    if (dealId) {
      const [d] = await db
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.workspaceId, workspaceId)))
        .limit(1);
      if (!d) throw new AppError(400, 'Deal not found in this workspace', 'invalid_deal');
    }
  }

  r.get(
    '/',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);
      const { contactId, dealId, type, status, limit } = listActivitiesQuery.parse(req.query);
      const items = await base()
        .where(
          and(
            eq(activities.workspaceId, workspaceId),
            contactId ? eq(activities.contactId, contactId) : undefined,
            dealId ? eq(activities.dealId, dealId) : undefined,
            type ? eq(activities.type, type) : undefined,
            status ? eq(activities.type, 'task') : undefined,
            status === 'open' ? isNull(activities.completedAt) : undefined,
            status === 'done' ? isNotNull(activities.completedAt) : undefined,
          ),
        )
        .orderBy(desc(activities.createdAt), activities.id)
        .limit(limit);
      res.json({ items });
    }),
  );

  r.post(
    '/',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const input = createActivitySchema.parse(req.body);
      await assertLinks(workspaceId, input.contactId, input.dealId);
      const created = one(
        await db
          .insert(activities)
          .values({
            type: input.type,
            content: input.content,
            dueAt: input.dueAt ? new Date(input.dueAt) : null,
            contactId: input.contactId,
            dealId: input.dealId,
            workspaceId,
            createdBy: userId,
          })
          .returning({ id: activities.id }),
      );
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'activity.created',
        entityType: 'activity',
        entityId: created.id,
        metadata: { type: input.type },
      });
      res.status(201).json({ activity: await get(workspaceId, created.id) });
    }),
  );

  r.patch(
    '/:id',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const input = updateActivitySchema.parse(req.body);
      if (Object.values(input).every((v) => v === undefined)) {
        throw new AppError(400, 'Nothing to update', 'empty_update');
      }
      const current = await get(workspaceId, id);
      if (!current) throw new AppError(404, 'Activity not found', 'not_found');
      if (current.type !== 'task' && (input.completed !== undefined || input.dueAt !== undefined)) {
        throw new AppError(400, 'Only tasks can be completed or have a due date', 'not_a_task');
      }

      await db
        .update(activities)
        .set({
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.dueAt !== undefined
            ? { dueAt: input.dueAt ? new Date(input.dueAt) : null }
            : {}),
          ...(input.completed !== undefined
            ? { completedAt: input.completed ? new Date() : null }
            : {}),
        })
        .where(and(eq(activities.workspaceId, workspaceId), eq(activities.id, id)));
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: input.completed === undefined ? 'activity.updated' : 'activity.completed',
        entityType: 'activity',
        entityId: id,
        metadata:
          input.completed === undefined
            ? { fields: Object.keys(input) }
            : { completed: input.completed },
      });
      res.json({ activity: await get(workspaceId, id) });
    }),
  );

  // admins can remove anything; everyone else can only remove what they wrote themselves
  r.delete(
    '/:id',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId, role } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const current = await get(workspaceId, id);
      if (!current) throw new AppError(404, 'Activity not found', 'not_found');
      if (!can(role, 'data:delete') && current.createdBy !== userId) {
        throw new AppError(403, 'You can only delete your own activities', 'forbidden');
      }
      await db
        .delete(activities)
        .where(and(eq(activities.workspaceId, workspaceId), eq(activities.id, id)));
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'activity.deleted',
        entityType: 'activity',
        entityId: id,
        metadata: { type: current.type },
      });
      res.status(204).end();
    }),
  );

  return r;
}
