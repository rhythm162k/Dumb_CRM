export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
// a deal in one of these stages is finished; everything else is still "open"
export const CLOSED_DEAL_STAGES = ['won', 'lost'] as const satisfies readonly DealStage[];

export const ACTIVITY_TYPES = ['note', 'call', 'meeting', 'task'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

// what an audit entry can point at ("workspace" is used for exports and imports)
export const AUDIT_ENTITY_TYPES = ['contact', 'company', 'deal', 'activity', 'workspace'] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
