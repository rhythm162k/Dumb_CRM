import { Router } from 'express';
import { and, asc, desc, eq, ilike, ne, or, sql } from 'drizzle-orm';
import {
  createContactSchema,
  IMPORT_MAX_ROWS,
  importContactsSchema,
  listContactsQuery,
  updateContactSchema,
} from '@crm/shared';
import { z } from 'zod';
import type { Db } from '../db/client';
import { companies, contacts } from '../db/schema';
import { audit } from '../lib/audit';
import { wrap } from '../lib/async';
import { EXPORT_LIMIT, isoOrNull, sendCsv } from '../lib/csv';
import { ctx, likePattern } from '../lib/ctx';
import { isUniqueViolation, one } from '../lib/db';
import { requirePermission } from '../middleware/auth';
import { AppError } from '../middleware/errors';
import { importContacts } from '../services/contactImport';

const uuid = z.guid(); // any 8-4-4-4-12 hex id, like zod 3's .uuid()
const duplicate = (existing?: { id: string; name: string }) =>
  new AppError(
    409,
    existing
      ? `A contact with this email already exists (${existing.name})`
      : 'A contact with this email already exists',
    'duplicate_contact',
    { existingId: existing?.id },
  );

export function contactsRouter(db: Db) {
  const r = Router();

  const columns = {
    id: contacts.id,
    firstName: contacts.firstName,
    lastName: contacts.lastName,
    email: contacts.email,
    phone: contacts.phone,
    jobTitle: contacts.jobTitle,
    tags: contacts.tags,
    notes: contacts.notes,
    companyId: contacts.companyId,
    companyName: companies.name,
    createdAt: contacts.createdAt,
    updatedAt: contacts.updatedAt,
  };

  async function get(workspaceId: string, id: string) {
    const [row] = await db
      .select(columns)
      .from(contacts)
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, id)))
      .limit(1);
    return row;
  }

  // a contact may only point at a company from its own workspace
  async function assertCompany(workspaceId: string, companyId: string | null | undefined) {
    if (!companyId) return;
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId)))
      .limit(1);
    if (!company) throw new AppError(400, 'Company not found in this workspace', 'invalid_company');
  }

  async function assertEmailFree(workspaceId: string, email: string, exceptId?: string) {
    const [existing] = await db
      .select({ id: contacts.id, first: contacts.firstName, last: contacts.lastName })
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, workspaceId),
          sql`lower(${contacts.email}) = ${email.toLowerCase()}`,
          exceptId ? ne(contacts.id, exceptId) : undefined,
        ),
      )
      .limit(1);
    if (existing) {
      throw duplicate({
        id: existing.id,
        name: [existing.first, existing.last].filter(Boolean).join(' '),
      });
    }
  }

  r.get(
    '/',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);
      const { q, page, pageSize, companyId, tag } = listContactsQuery.parse(req.query);
      const like = q ? likePattern(q) : undefined;
      const where = and(
        eq(contacts.workspaceId, workspaceId),
        companyId ? eq(contacts.companyId, companyId) : undefined,
        tag ? sql`${contacts.tags} @> ARRAY[${tag}]::text[]` : undefined,
        like
          ? or(
              ilike(sql`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`, like),
              ilike(contacts.email, like),
              ilike(contacts.phone, like),
              ilike(companies.name, like),
            )
          : undefined,
      );
      const items = await db
        .select(columns)
        .from(contacts)
        .leftJoin(companies, eq(companies.id, contacts.companyId))
        .where(where)
        .orderBy(desc(contacts.createdAt), contacts.id)
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(contacts)
        .leftJoin(companies, eq(companies.id, contacts.companyId))
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
        .from(contacts)
        .leftJoin(companies, eq(companies.id, contacts.companyId))
        .where(eq(contacts.workspaceId, workspaceId))
        .orderBy(asc(contacts.createdAt), contacts.id)
        .limit(EXPORT_LIMIT);
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'contact.exported',
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { rows: rows.length },
      });
      sendCsv(
        res,
        'contacts',
        [
          'First name',
          'Last name',
          'Email',
          'Phone',
          'Job title',
          'Company',
          'Tags',
          'Notes',
          'Created',
        ],
        rows.map((c) => [
          c.firstName,
          c.lastName,
          c.email,
          c.phone,
          c.jobTitle,
          c.companyName,
          c.tags.join('; '),
          c.notes,
          isoOrNull(c.createdAt),
        ]),
      );
    }),
  );

  // CSV import: the browser parses the file and maps its columns, this endpoint validates and saves.
  // With dryRun it answers "what would happen?" and changes nothing.
  r.post(
    '/import',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      // cheap length check BEFORE validation: zod collects an issue per bad element, so a huge
      // array of junk would otherwise cost a lot of memory (GHSA-mrhx-c7xc-m3w5)
      const incoming: unknown = (req.body as { rows?: unknown } | undefined)?.rows;
      if (Array.isArray(incoming) && incoming.length > IMPORT_MAX_ROWS) {
        throw new AppError(
          400,
          `Import at most ${IMPORT_MAX_ROWS} rows at a time`,
          'validation_error',
        );
      }
      const { rows, duplicates, dryRun } = importContactsSchema.parse(req.body);
      const result = await importContacts(db, userId, { workspaceId, rows, duplicates, dryRun });
      if (!dryRun) {
        // counts only: never row contents
        await audit(db, {
          workspaceId,
          actorId: userId,
          action: 'contact.imported',
          entityType: 'workspace',
          entityId: workspaceId,
          metadata: {
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            failed: result.failed,
            companiesCreated: result.companiesCreated,
          },
        });
      }
      res.json(result);
    }),
  );

  r.post(
    '/',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const input = createContactSchema.parse(req.body);
      await assertCompany(workspaceId, input.companyId);
      if (input.email) await assertEmailFree(workspaceId, input.email);
      let created;
      try {
        created = one(
          await db
            .insert(contacts)
            .values({ ...input, workspaceId, createdBy: userId })
            .returning({ id: contacts.id }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate();
        throw err;
      }
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'contact.created',
        entityType: 'contact',
        entityId: created.id,
      });
      res.status(201).json({ contact: await get(workspaceId, created.id) });
    }),
  );

  r.get(
    '/:id',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);
      const contact = await get(workspaceId, uuid.parse(req.params['id']));
      if (!contact) throw new AppError(404, 'Contact not found', 'not_found');
      res.json({ contact });
    }),
  );

  r.patch(
    '/:id',
    requirePermission('data:write'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const input = updateContactSchema.parse(req.body);
      if (Object.values(input).every((v) => v === undefined)) {
        throw new AppError(400, 'Nothing to update', 'empty_update');
      }
      await assertCompany(workspaceId, input.companyId);
      if (input.email) await assertEmailFree(workspaceId, input.email, id);
      let updated;
      try {
        updated = await db
          .update(contacts)
          .set({ ...input, updatedAt: new Date() })
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, id)))
          .returning({ id: contacts.id });
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate();
        throw err;
      }
      if (updated.length === 0) throw new AppError(404, 'Contact not found', 'not_found');
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'contact.updated',
        entityType: 'contact',
        entityId: id,
        metadata: { fields: Object.keys(input) },
      });
      res.json({ contact: await get(workspaceId, id) });
    }),
  );

  r.delete(
    '/:id',
    requirePermission('data:delete'),
    wrap(async (req, res) => {
      const { workspaceId, userId } = ctx(req);
      const id = uuid.parse(req.params['id']);
      const deleted = await db
        .delete(contacts)
        .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, id)))
        .returning({ id: contacts.id });
      if (deleted.length === 0) throw new AppError(404, 'Contact not found', 'not_found');
      await audit(db, {
        workspaceId,
        actorId: userId,
        action: 'contact.deleted',
        entityType: 'contact',
        entityId: id,
      });
      res.status(204).end();
    }),
  );

  return r;
}
