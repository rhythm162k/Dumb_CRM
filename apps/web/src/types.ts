import type { ActivityType, DealStage } from '@crm/shared';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Company {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  notes: string | null;
  contactCount: number;
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  tags: string[];
  notes: string | null;
  companyId: string | null;
  companyName: string | null;
}

export interface Deal {
  id: string;
  title: string;
  value: number;
  currency: string;
  stage: DealStage;
  position: number;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
  ownerId: string;
  expectedCloseDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  type: ActivityType;
  content: string;
  dueAt: string | null;
  completedAt: string | null;
  contactId: string | null;
  dealId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface Money {
  currency: string;
  value: number;
}

export interface Dashboard {
  openDeals: { count: number; totals: Money[] };
  stages: { stage: DealStage; count: number; totals: Money[] }[];
  overdueTasks: {
    count: number;
    items: {
      id: string;
      content: string;
      dueAt: string;
      contactId: string | null;
      contactName: string | null;
      dealId: string | null;
      dealTitle: string | null;
    }[];
  };
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
}
