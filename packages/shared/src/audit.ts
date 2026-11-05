import { z } from 'zod';
import { AUDIT_ENTITY_TYPES } from './constants';

export const listAuditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  // any 8-4-4-4-12 hex string, as with zod 3's `.uuid()` (the column is a Postgres uuid)
  actorId: z.guid().optional(),
});
