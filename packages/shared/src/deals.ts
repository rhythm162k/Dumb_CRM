import { z } from 'zod';
import { DEAL_STAGES } from './constants';

// Zod 4: the field schemas describe a value that is present; create adds `.default(...)`, update
// uses `.partial()` (see the note at the top of crm.ts for why defaults must stay out of the fields).

// any 8-4-4-4-12 hex string, as with zod 3's `.uuid()` (the column is a Postgres uuid)
const uuid = z.guid();

// 'YYYY-MM-DD' or empty; stored in a Postgres `date` column
const closeDate = z
  .string()
  .trim()
  .nullable()
  .transform((v) => (v ? v : null))
  .pipe(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date')
      .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date')
      .nullable(),
  );

const dealFields = {
  title: z.string().trim().min(1, 'Enter a deal title').max(150),
  value: z
    .number()
    .min(0, 'Value cannot be negative')
    .max(9_999_999_999, 'Value is too large')
    .transform((n) => Math.round(n * 100) / 100),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  stage: z.enum(DEAL_STAGES),
  contactId: uuid.nullable(),
  companyId: uuid.nullable(),
  expectedCloseDate: closeDate,
};

export const createDealSchema = z.object({
  title: dealFields.title,
  value: dealFields.value.default(0),
  currency: dealFields.currency.default('USD'),
  stage: dealFields.stage.default('lead'),
  contactId: dealFields.contactId.default(null),
  companyId: dealFields.companyId.default(null),
  expectedCloseDate: dealFields.expectedCloseDate.default(null),
});
// stage changes go through POST /:id/move so column positions stay consistent
export const updateDealSchema = z
  .object({
    title: dealFields.title,
    value: dealFields.value,
    currency: dealFields.currency,
    contactId: dealFields.contactId,
    companyId: dealFields.companyId,
    expectedCloseDate: dealFields.expectedCloseDate,
  })
  .partial();

// drag-and-drop on the kanban board: new stage and the 0-based slot inside it
export const moveDealSchema = z.object({
  stage: z.enum(DEAL_STAGES),
  position: z.number().int().min(0).max(10_000).default(0),
});

export const listDealsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  stage: z.enum(DEAL_STAGES).optional(),
});
