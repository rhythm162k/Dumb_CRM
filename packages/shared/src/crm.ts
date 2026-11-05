import { z } from 'zod';
import { emailSchema } from './schemas';

/*
 * Zod 4 note (HANDOFF 3f). The field schemas below describe a value that IS present. A missing
 * field is dealt with by whoever builds the object schema:
 *   - create schemas add `.default(...)`  -> a missing optional field becomes null / []
 *   - update schemas use `.partial()`     -> a missing field stays missing, so a PATCH never
 *                                            touches anything it did not send
 * Do NOT put `.default()` or `.nullish().transform(...)` inside a field that `.partial()` will
 * wrap: zod 4 still runs those on a missing key, which would reset or null stored data on every
 * PATCH. test/schemas.test.ts and test/update-preserves-fields.test.ts guard this.
 */

// same shape check zod 3's `.uuid()` did: the database column is a Postgres uuid, which takes
// any 8-4-4-4-12 hex string (zod 4's strict `.uuid()` would also demand version/variant bits)
const uuid = z.guid();

// '' and null both mean "empty" and are stored as null
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

const email = z
  .string()
  .trim()
  .toLowerCase()
  .nullable()
  .transform((v) => (v ? v : null))
  .pipe(emailSchema.nullable());

const phone = z
  .string()
  .trim()
  .nullable()
  .transform((v) => (v ? v : null))
  .pipe(
    z
      .string()
      .regex(/^[+()\-.\s\d]{5,40}$/, 'Enter a valid phone number')
      .nullable(),
  );

// only http(s) URLs are ever stored, so a saved website is always safe to link to
const website = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    const withProtocol = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    try {
      const url = new URL(withProtocol);
      if (!url.hostname.includes('.')) throw new Error('no dot');
      return url.toString().replace(/\/$/, '');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid website' });
      return z.NEVER;
    }
  });

const tags = z
  .array(z.string().trim().toLowerCase().min(1).max(30))
  .max(20, 'Use at most 20 tags')
  .transform((list) => [...new Set(list)]);

const contactFields = {
  firstName: z.string().trim().min(1, 'Enter a first name').max(100),
  lastName: text(100),
  email,
  phone,
  jobTitle: text(150),
  companyId: uuid.nullable(),
  tags,
  notes: text(5000),
};

export const createContactSchema = z.object({
  firstName: contactFields.firstName,
  lastName: contactFields.lastName.default(null),
  email: contactFields.email.default(null),
  phone: contactFields.phone.default(null),
  jobTitle: contactFields.jobTitle.default(null),
  companyId: contactFields.companyId.default(null),
  tags: contactFields.tags.default([]),
  notes: contactFields.notes.default(null),
});
export const updateContactSchema = z.object(contactFields).partial();

const companyFields = {
  name: z.string().trim().min(1, 'Enter a company name').max(150),
  website,
  industry: text(100),
  notes: text(5000),
};

export const createCompanySchema = z.object({
  name: companyFields.name,
  website: companyFields.website.default(null),
  industry: companyFields.industry.default(null),
  notes: companyFields.notes.default(null),
});
export const updateCompanySchema = z.object(companyFields).partial();

const page = {
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
export const listContactsQuery = z.object({
  ...page,
  companyId: uuid.optional(),
  tag: z.string().trim().toLowerCase().max(30).optional(),
});
export const listCompaniesQuery = z.object(page);

// ---------- CSV import ----------
export const IMPORT_MAX_ROWS = 1000;

// a tag cell like "vip; lead" or "vip, lead" becomes ['vip', 'lead']; a missing cell becomes []
const tagCell = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(/[;,]/)
          .map((t) => t.trim())
          .filter(Boolean)
      : v,
  tags.default([]),
);

// like a contact, but the company is given by name: it is matched (ignoring case) or created
export const importContactRowSchema = createContactSchema
  .omit({ companyId: true, tags: true })
  .extend({ company: text(150).default(null), tags: tagCell });

export const importContactsSchema = z.object({
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, 'The file has no rows to import')
    .max(IMPORT_MAX_ROWS, `Import at most ${IMPORT_MAX_ROWS} rows at a time`),
  // what to do when a row's email already belongs to a contact (or an earlier row of the same file)
  duplicates: z.enum(['skip', 'update']).default('skip'),
  // true = report what would happen and change nothing
  dryRun: z.boolean().default(false),
});
