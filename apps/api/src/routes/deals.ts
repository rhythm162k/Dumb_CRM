import { Router } from 'express';
import { and, asc, eq, ilike, ne, or, sql } from 'drizzle-orm';
import { createDealSchema, listDealsQuery, moveDealSchema, updateDealSchema } from '@crm/shared';
import { z } from 'zod';
import type { Db } from '../db/client';
import { companies, contacts, deals } from '../db/schema';
import { audit } from '../lib/audit';
import { wrap } from '../lib/async';
import { EXPORT_LIMIT, isoOrNull, sendCsv } from '../lib/csv';
import { ctx, likePattern } from '../lib/ctx';
import { one } from '../lib/db';
import { requirePermission } from '../middleware/auth';
import { AppError } from '../middleware/errors';

const uuid = z.guid(); // any 8-4-4-4-12 hex id, like zod 3's .uuid()

export function dealsRouter(db: Db) {
  const r = Router();

  const columns = {
    id: deals.id,
    title: deals.title,
    value: deals.value,
    currency: deals.currency,
    stage: deals.stage,
    position: deals.position,
    contactId: deals.contactId,
    contactName: sql<
      string | null
    >`nullif(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}), '')`,
    companyId: deals.companyId,
    companyName: companies.name,
    ownerId: deals.ownerId,
    expectedCloseDate: deals.expectedCloseDate,
    createdAt: deals.createdAt,
    updatedAt: deals.updatedAt,
  };

  // numeric columns come back from Postgres as strings; the API always returns a number
  const shape = <T extends { value: string }>(row: T) => ({ ...row, value: Number(row.value) });

  const base = () =>
    db
      .select(columns)
      .from(deals)
      .leftJoin(contacts, eq(contacts.id, deals.contactId))
      .leftJoin(companies, eq(companies.id, deals.companyId));

  async function get(workspaceId: string, id: string) {
    const [row] = await base()
      .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, id)))
      .limit(1);
    return row ? shape(row) : undefined;
  }

  // a deal may only point at a contact / company from its own workspace
  async function assertLinks(
    workspaceId: string,
    contactId?: string | null,
    companyId?: string | null,
  ) {
    if (contactId) {
      const [c] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
        .limit(1);
      if (!c) throw new AppError(400, 'Contact not found in this workspace', 'invalid_contact');
    }
    if (companyId) {
      const [c] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId)))
        .limit(1);
      if (!c) throw new AppError(400, 'Company not found in this workspace', 'invalid_company');
    }
  }

  async function nextPosition(workspaceId: string, stage: (typeof deals.$inferSelect)['stage']) {
    const [row] = await db
      .select({ next: sql<number>`coalesce(max(${deals.position}), -1)::int + 1` })
      .from(deals)
      .where(and(eq(deals.workspaceId, workspaceId), eq(deals.stage, stage)));
    return row?.next ?? 0;
  }

  // whole board in one request (a small-team CRM never has thousands of open deals)
  r.get(
    '/',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);
      const { q, stage } = listDealsQuery.parse(req.query);
      const like = q ? likePattern(q) : undefined;
      const rows = await base()
        .where(
          and(
            eq(deals.workspaceId, workspaceId),
            stage ? eq(deals.stage, stage) : undefined,
            like ? or(ilike(deals.title, like), ilike(companies.name, like)) : undefined,
          ),
        )
        .orderBy(asc(deals.stage), asc(deals.position), asc(deals.createdAt))
        .limit(500);
      res.json({ items: rows.map(shape) });
    }),
  );

  // registered before '/:id' so "export.csv" is never read as an id
  r.get(
    '/export.csv',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const rows = (
        await base()
          .where(eq(deals.workspaceId, workspaceId))
          .orderBy(asc(deals.stage), asc(deals.position), asc(deals.createdAt))
          .limit(EXPORT_LIMIT)
      ).map(shape);
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'deal.exported',
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { rows: rows.length },
      });
      sendCsv(
        res,
        'deals',
        ['Title', 'Value', 'Currency', 'Stage', 'Company', 'Contact', 'Expected close', 'Created'],
        rows.map((d) => [
          d.title,
          d.value,
          d.currency,
          d.stage,
          d.companyName,
          d.contactName,
          d.expectedCloseDate,
          isoOrNull(d.createdAt),
        ]),
      );
    }),
  );

  r.post(
    '/',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const input = createDealSchema.parse(req.body);
      await assertLinks(workspaceId, input.contactId, input.companyId);
      const created = one(
        await db
          .insert(deals)
          .values({
            ...input,
            value: String(input.value),
            position: await nextPosition(workspaceId, input.stage),
            workspaceId,
            ownerId: userId,
          })
          .returning({ id: deals.id }),
      );
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'deal.created',
        entityType: 'deal',
        entityId: created.id,
      });
      res.status(201).json({ deal: await get(workspaceId, created.id) });
    }),
  );

  r.get(
    '/:id',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);
      const deal = await get(workspaceId, uuid.parse(req.params['id']));
      if (!deal) throw new AppError(404, 'Deal not found', 'not_found');
      res.json({ deal });
    }),
  );

  r.patch(
    '/:id',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const input = updateDealSchema.parse(req.body);
      if (Object.values(input).every((v) => v === undefined)) {
        throw new AppError(400, 'Nothing to update', 'empty_update');
      }
      await assertLinks(workspaceId, input.contactId, input.companyId);
      const { value, ...rest } = input;
      const updated = await db
        .update(deals)
        .set({
          ...rest,
          ...(value !== undefined ? { value: String(value) } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, id)))
        .returning({ id: deals.id });
      if (updated.length === 0) throw new AppError(404, 'Deal not found', 'not_found');
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'deal.updated',
        entityType: 'deal',
        entityId: id,
        metadata: { fields: Object.keys(input) },
      });
      res.json({ deal: await get(workspaceId, id) });
    }),
  );

  // kanban drag-and-drop: change stage and/or slot; the target column is renumbered 0..n-1
  r.post(
    '/:id/move',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const { stage, position } = moveDealSchema.parse(req.body);

      const from = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ stage: deals.stage })
          .from(deals)
          .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, id)))
          .limit(1)
          .for('update');
        if (!current) throw new AppError(404, 'Deal not found', 'not_found');

        // `position` is the slot among the OTHER cards of the target column. Rebuild that
        // column's order and rewrite positions as 0..n-1, so gaps left by earlier moves or
        // deletes can never put a card in the wrong place.
        const others = await tx
          .select({ id: deals.id, position: deals.position })
          .from(deals)
          .where(and(eq(deals.workspaceId, workspaceId), eq(deals.stage, stage), ne(deals.id, id)))
          .orderBy(asc(deals.position), asc(deals.createdAt), asc(deals.id));
        const order = others.map((o) => o.id);
        order.splice(Math.min(position, order.length), 0, id);
        const oldPosition = new Map(others.map((o) => [o.id, o.position]));

        for (const [slot, cardId] of order.entries()) {
          if (cardId === id) {
            await tx
              .update(deals)
              .set({ stage, position: slot, updatedAt: new Date() })
              .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, id)));
          } else if (oldPosition.get(cardId) !== slot) {
            await tx
              .update(deals)
              .set({ position: slot })
              .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, cardId)));
          }
        }
        return current.stage;
      });

      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'deal.moved',
        entityType: 'deal',
        entityId: id,
        metadata: { from, to: stage },
      });
      res.json({ deal: await get(workspaceId, id) });
    }),
  );

  r.delete(
    '/:id',
    requirePermission('data:delete'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const deleted = await db
        .delete(deals)
        .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, id)))
        .returning({ id: deals.id });
      if (deleted.length === 0) throw new AppError(404, 'Deal not found', 'not_found');
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'deal.deleted',
        entityType: 'deal',
        entityId: id,
      });
      res.status(204).end();
    }),
  );

  return r;
}
