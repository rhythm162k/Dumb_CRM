import type { Db } from '../db/client';
import { auditLogs } from '../db/schema';

/** Records who did what. Keep metadata free of personal data (store field names, not values). */
export async function audit(
  db: Db,
  entry: {
    workspaceId: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(auditLogs).values({ ...entry, metadata: entry.metadata ?? null });
}
