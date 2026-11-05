import { Router } from 'express';
import { and, asc, eq, ilike, ne, sql } from 'drizzle-orm';
import { createCompanySchema, listCompaniesQuery, updateCompanySchema } from '@crm/shared';
import { z } from 'zod';
import type { Db } from '../db/client';
import { companies } from '../db/schema';
import { audit } from '../lib/audit';
import { wrap } from '../lib/async';
import { EXPORT_LIMIT, isoOrNull, sendCsv } from '../lib/csv';
import { ctx, likePattern } from '../lib/ctx';
import { isUniqueViolation, one } from '../lib/db';
import { requirePermission } from '../middleware/auth';
import { AppError } from '../middleware/errors';

const uuid = z.guid(); // any 8-4-4-4-12 hex id, like zod 3's .uuid()
const duplicate = (existingId?: string) =>
  new AppError(409, 'A company with this name already exists', 'duplicate_company', { existingId });

export function companiesRouter(db: Db) {
  const r = Router();

  const columns = {
    id: companies.id,
    name: companies.name,
    website: companies.website,
    industry: companies.industry,
    notes: companies.notes,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
    contactCount: sql<number>`(select count(*)::int from contacts where contacts.company_id = "companies"."id")`,
  };

  async function get(workspaceId: string, id: string) {
    const [row] = await db
      .select(columns)
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.id, id)))
      .limit(1);
    return row;
  }

  async function assertNameFree(workspaceId: string, name: string, exceptId?: string) {
    const [existing] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.workspaceId, workspaceId),
          sql`lower(${companies.name}) = ${name.toLowerCase()}`,
          exceptId ? ne(companies.id, exceptId) : undefined,
        ),
      )
      .limit(1);
    if (existing) throw duplicate(existing.id);
  }

  r.get(
    '/',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);
      const { q, page, pageSize } = listCompaniesQuery.parse(req.query);
      const where = and(
        eq(companies.workspaceId, workspaceId),
        q ? ilike(companies.name, likePattern(q)) : undefined,
      );
      const items = await db
        .select(columns)
        .from(companies)
        .where(where)
        .orderBy(sql`lower(${companies.name})`, companies.id)
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(companies)
        .where(where);
      res.json({ items, total, page, pageSize });
    }),
  );

  // registered before '/:id' so "export.csv" is never read as an id
  r.get(
    '/export.csv',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const rows = await db
        .select(columns)
        .from(companies)
        .where(eq(companies.workspaceId, workspaceId))
        .orderBy(asc(companies.name), companies.id)
        .limit(EXPORT_LIMIT);
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'company.exported',
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { rows: rows.length },
      });
      sendCsv(
        res,
        'companies',
        ['Name', 'Website', 'Industry', 'Notes', 'Contacts', 'Created'],
        rows.map((c) => [
          c.name,
          c.website,
          c.industry,
          c.notes,
          c.contactCount,
          isoOrNull(c.createdAt),
        ]),
      );
    }),
  );

  r.post(
    '/',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const input = createCompanySchema.parse(req.body);
      await assertNameFree(workspaceId, input.name);
      let created;
      try {
        created = one(
          await db
            .insert(companies)
            .values({ ...input, workspaceId })
            .returning({ id: companies.id }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate();
        throw err;
      }
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'company.created',
        entityType: 'company',
        entityId: created.id,
      });
      res.status(201).json({ company: await get(workspaceId, created.id) });
    }),
  );

  r.get(
    '/:id',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);
      const company = await get(workspaceId, uuid.parse(req.params['id']));
      if (!company) throw new AppError(404, 'Company not found', 'not_found');
      res.json({ company });
    }),
  );

  r.patch(
    '/:id',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const input = updateCompanySchema.parse(req.body);
      if (Object.values(input).every((v) => v === undefined)) {
        throw new AppError(400, 'Nothing to update', 'empty_update');
      }
      if (input.name) await assertNameFree(workspaceId, input.name, id);
      let updated;
      try {
        updated = await db
          .update(companies)
          .set({ ...input, updatedAt: new Date() })
          .where(and(eq(companies.workspaceId, workspaceId), eq(companies.id, id)))
          .returning({ id: companies.id });
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate();
        throw err;
      }
      if (updated.length === 0) throw new AppError(404, 'Company not found', 'not_found');
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'company.updated',
        entityType: 'company',
        entityId: id,
        metadata: { fields: Object.keys(input) },
      });
      res.json({ company: await get(workspaceId, id) });
    }),
  );

  r.delete(
    '/:id',
    requirePermission('data:delete'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const deleted = await db
        .delete(companies)
        .where(and(eq(companies.workspaceId, workspaceId), eq(companies.id, id)))
        .returning({ id: companies.id });
      if (deleted.length === 0) throw new AppError(404, 'Company not found', 'not_found');
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'company.deleted',
        entityType: 'company',
        entityId: id,
      });
      res.status(204).end();
    }),
  );

  return r;
}
