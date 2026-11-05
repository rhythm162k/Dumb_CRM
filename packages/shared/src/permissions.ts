import type { WorkspaceRole } from './index';

export const PERMISSIONS = [
  'data:read',
  'data:write',
  'data:delete',
  'members:manage',
  'audit:read',
  'workspace:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<WorkspaceRole, readonly Permission[]> = {
  member: ['data:read', 'data:write'],
  admin: ['data:read', 'data:write', 'data:delete', 'members:manage', 'audit:read'],
  owner: PERMISSIONS,
};

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}
