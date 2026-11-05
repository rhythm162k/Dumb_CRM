import type { WorkspaceRole } from '@crm/shared';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      workspace?: { id: string; role: WorkspaceRole };
    }
  }
}

export {};
