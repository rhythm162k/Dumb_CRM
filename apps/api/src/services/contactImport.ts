import { and, eq, isNotNull } from 'drizzle-orm';
import type { ZodError } from 'zod';
import { importContactRowSchema } from '@crm/shared';
import type { Db } from '../db/client';
import { companies, contacts } from '../db/schema';
import { one } from '../lib/db';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ImportRowError {
  /** 0-based position in the submitted rows */
  row: number;
  message: string;
}

export interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  companiesCreated: number;
  /** the first few problems; `failed` is the full count */
  errors: ImportRowError[];
}

const MAX_REPORTED_ERRORS = 100;

const FIELD_LABEL: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  jobTitle: 'Job title',
  company: 'Company',
  tags: 'Tags',
  notes: 'Notes',
};

function describe(error: ZodError): string {
  const issue = error.issues[0];
  const key = issue?.path[0];
  const label = typeof key === 'string' ? FIELD_LABEL[key] : undefined;
  const message = issue?.message ?? 'This row is not valid';
  return label ? `${label}: ${message}` : message;
}

// thrown after a dry run so the transaction rolls back and nothing is saved
class Rollback extends Error {
  constructor(readonly result: ImportResult) {
    super('dry run');
  }
}

export interface ImportOptions {
  workspaceId: string;
  rows: Record<string, unknown>[];
  duplicates: 'skip' | 'update';
  dryRun: boolean;
}

/**
 * Imports contacts in one transaction. A dry run executes exactly the same steps and then rolls
 * back, so the preview is always what the real import would do. Rows that fail validation are
 * reported and left out; they never stop the other rows.
 */
export async function importContacts(
  db: Db,
  userId: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  try {
    return await db.transaction(async (tx) => {
      const result = await run(tx, userId, opts);
      if (opts.dryRun) throw new Rollback(result);
      return result;
    });
  } catch (err) {
    if (err instanceof Rollback) return err.result;
    throw err;
  }
}

async function run(
  tx: Tx,
  userId: string,
  { workspaceId, rows, duplicates, dryRun }: ImportOptions,
) {
  const result: ImportResult = {
    dryRun,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    companiesCreated: 0,
    errors: [],
  };

  const existing = await tx
    .select({ id: contacts.id, email: contacts.email, tags: contacts.tags })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), isNotNull(contacts.email)));
  const byEmail = new Map<string, { id: string; tags: string[] }>();
  for (const c of existing)
    if (c.email) byEmail.set(c.email.toLowerCase(), { id: c.id, tags: c.tags });

  const companyRows = await tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.workspaceId, workspaceId));
  const companyByName = new Map(companyRows.map((c) => [c.name.toLowerCase(), c.id]));

  for (const [index, raw] of rows.entries()) {
    const parsed = importContactRowSchema.safeParse(raw);
    if (!parsed.success) {
      result.failed++;
      if (result.errors.length < MAX_REPORTED_ERRORS)
        result.errors.push({ row: index, message: describe(parsed.error) });
      continue;
    }
    const { company, email, tags, ...fields } = parsed.data;

    // the same email twice in one file counts as a duplicate too: byEmail grows as rows are created
    const duplicate = email ? byEmail.get(email) : undefined;
    if (duplicate && duplicates === 'skip') {
      result.skipped++;
      continue;
    }

    let companyId: string | null = null;
    if (company) {
      const key = company.toLowerCase();
      companyId = companyByName.get(key) ?? null;
      if (!companyId) {
        companyId = one(
          await tx
            .insert(companies)
            .values({ workspaceId, name: company })
            .returning({ id: companies.id }),
        ).id;
        companyByName.set(key, companyId);
        result.companiesCreated++;
      }
    }

    if (duplicate) {
      // update: the file only fills in or changes values; an empty cell never erases existing data
      const mergedTags = tags.length ? [...new Set([...duplicate.tags, ...tags])] : undefined;
      await tx
        .update(contacts)
        .set({
          firstName: fields.firstName,
          ...(fields.lastName ? { lastName: fields.lastName } : {}),
          ...(fields.phone ? { phone: fields.phone } : {}),
          ...(fields.jobTitle ? { jobTitle: fields.jobTitle } : {}),
          ...(fields.notes ? { notes: fields.notes } : {}),
          ...(companyId ? { companyId } : {}),
          ...(mergedTags ? { tags: mergedTags } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, duplicate.id)));
      if (mergedTags) duplicate.tags = mergedTags;
      result.updated++;
    } else {
      const created = one(
        await tx
          .insert(contacts)
          .values({ ...fields, email, tags, companyId, workspaceId, createdBy: userId })
          .returning({ id: contacts.id }),
      );
      if (email) byEmail.set(email, { id: created.id, tags });
      result.created++;
    }
  }
  return result;
}
