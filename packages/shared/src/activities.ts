import { z } from 'zod';
import { ACTIVITY_TYPES } from './constants';

// any 8-4-4-4-12 hex string, as with zod 3's `.uuid()` (the column is a Postgres uuid)
const uuid = z.guid();

const uuidOrNull = uuid.nullish().transform((v) => v ?? null);

const isoDate = z.iso.datetime({ offset: true, error: 'Enter a valid date' });

export const createActivitySchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    content: z
      .string()
      .trim()
      .min(1, 'Write something first')
      .max(2000, 'That is too long (2000 characters max)'),
    dueAt: isoDate.nullish().transform((v) => v ?? null),
    contactId: uuidOrNull,
    dealId: uuidOrNull,
  })
  .refine((v) => v.contactId || v.dealId, {
    message: 'Link the activity to a contact or a deal',
    path: ['contactId'],
  })
  .refine((v) => v.type === 'task' || !v.dueAt, {
    message: 'Only tasks have a due date',
    path: ['dueAt'],
  });

// type and links never change after creation; only the text, due date and completion do
export const updateActivitySchema = z.object({
  content: z.string().trim().min(1, 'Write something first').max(2000).optional(),
  dueAt: isoDate.nullable().optional(),
  completed: z.boolean().optional(),
});

export const listActivitiesQuery = z.object({
  contactId: uuid.optional(),
  dealId: uuid.optional(),
  type: z.enum(ACTIVITY_TYPES).optional(),
  // tasks only: "open" = not completed yet, "done" = completed
  status: z.enum(['open', 'done']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
