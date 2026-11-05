import { can, type Permission } from '@crm/shared';
import { useAuth } from './auth';

/** The active workspace (the first one for now; a switcher can come later). */
export function useWorkspace() {
  const { workspaces } = useAuth();
  const workspace = workspaces[0];
  if (!workspace) throw new Error('No workspace');
  return {
    ...workspace,
    base: `/workspaces/${workspace.id}`,
    can: (permission: Permission) => can(workspace.role, permission),
  };
}
