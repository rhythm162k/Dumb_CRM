import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { workspaceMembers, workspaces } from '../db/schema';

export async function listWorkspacesFor(db: Db, userId: string) {
  return db
    .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaces.createdAt);
}

export async function getMember(db: Db, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row;
}
