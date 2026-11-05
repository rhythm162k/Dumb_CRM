import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { listAuditQuery } from '@crm/shared';
import type { Db } from '../db/client';
import { auditLogs, users } from '../db/schema';
import { wrap } from '../lib/async';
import { ctx } from '../lib/ctx';
import { requirePermission } from '../middleware/auth';

/** Read-only view of the workspace audit trail. Admins and owners only. */
export function auditRouter(db: Db) {
  const r = Router();

  r.get(
    '/',
    requirePermission('audit:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);
      const { page, pageSize, entityType, actorId } = listAuditQuery.parse(req.query);
      const where = and(
        eq(auditLogs.workspaceId, workspaceId),
        entityType ? eq(auditLogs.entityType, entityType) : undefined,
        actorId ? eq(auditLogs.actorId, actorId) : undefined,
      );
      const items = await db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          actorId: auditLogs.actorId,
          actorName: users.name,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorId))
        .where(where)
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(where);
      res.json({ items, total, page, pageSize });
    }),
  );

  return r;
}
