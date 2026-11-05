import { Router } from 'express';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import { CLOSED_DEAL_STAGES, DEAL_STAGES, type DealStage } from '@crm/shared';
import type { Db } from '../db/client';
import { activities, contacts, deals } from '../db/schema';
import { wrap } from '../lib/async';
import { ctx } from '../lib/ctx';
import { requirePermission } from '../middleware/auth';

const OVERDUE_LIMIT = 5;
const isClosed = (stage: DealStage) => (CLOSED_DEAL_STAGES as readonly string[]).includes(stage);

interface Money {
  currency: string;
  value: number;
}

/** Adds amounts per currency: deals in different currencies are never summed together. */
function addMoney(totals: Map<string, number>, currency: string, value: number) {
  totals.set(currency, Math.round(((totals.get(currency) ?? 0) + value) * 100) / 100);
}
const toList = (totals: Map<string, number>): Money[] =>
  [...totals].map(([currency, value]) => ({ currency, value })).sort((a, b) => a.currency.localeCompare(b.currency));

export function dashboardRouter(db: Db) {
  const r = Router();

  // everything the home page needs in one request: open pipeline, deals per stage, overdue tasks
  r.get(
    '/',
    requirePermission('data:read'),
    wrap(async (req, res) => {
      const { workspaceId } = ctx(req);

      const overdue = and(
        eq(activities.workspaceId, workspaceId),
        eq(activities.type, 'task'),
        isNull(activities.completedAt),
        lt(activities.dueAt, new Date()),
      );

      // One request = one transaction = one database connection, and a connection can only run one
      // query at a time (pg warns about concurrent queries), so these run one after another.
      const dealRows = await db
        .select({
          stage: deals.stage,
          currency: deals.currency,
          count: sql<number>`count(*)::int`,
          value: sql<string>`coalesce(sum(${deals.value}), 0)::text`,
        })
        .from(deals)
        .where(eq(deals.workspaceId, workspaceId))
        .groupBy(deals.stage, deals.currency);

      const [overdueCount] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(activities)
        .where(overdue);

      const overdueItems = await db
        .select({
          id: activities.id,
          content: activities.content,
          dueAt: activities.dueAt,
          contactId: activities.contactId,
          contactName: sql<string | null>`nullif(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}), '')`,
          dealId: activities.dealId,
          dealTitle: deals.title,
        })
        .from(activities)
        .leftJoin(
          contacts,
          and(eq(contacts.id, activities.contactId), eq(contacts.workspaceId, activities.workspaceId)),
        )
        .leftJoin(deals, and(eq(deals.id, activities.dealId), eq(deals.workspaceId, activities.workspaceId)))
        .where(overdue)
        .orderBy(asc(activities.dueAt), asc(activities.id))
        .limit(OVERDUE_LIMIT);

      const openTotals = new Map<string, number>();
      let openCount = 0;
      const stages = DEAL_STAGES.map((stage) => {
        const totals = new Map<string, number>();
        let count = 0;
        for (const row of dealRows) {
          if (row.stage !== stage) continue;
          count += row.count;
          addMoney(totals, row.currency, Number(row.value));
          if (!isClosed(stage)) addMoney(openTotals, row.currency, Number(row.value));
        }
        if (!isClosed(stage)) openCount += count;
        return { stage, count, totals: toList(totals) };
      });

      res.json({
        openDeals: { count: openCount, totals: toList(openTotals) },
        stages,
        overdueTasks: { count: overdueCount?.n ?? 0, items: overdueItems },
      });
    }),
  );

  return r;
}
