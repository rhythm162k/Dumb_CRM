import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, buildApp, closeDb, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const base = (w: Who) => `/api/workspaces/${w.workspaceId}`;
const PAST = '2020-01-01T09:00:00.000Z';
const FUTURE = '2090-01-01T09:00:00.000Z';

async function deal(w: Who, body: Record<string, unknown>) {
  const res = await w.agent.post(`${base(w)}/deals`).send(body);
  expect(res.status).toBe(201);
  return res.body.deal as { id: string };
}
async function contact(w: Who, firstName: string, lastName?: string) {
  const res = await w.agent.post(`${base(w)}/contacts`).send({ firstName, lastName });
  expect(res.status).toBe(201);
  return res.body.contact as { id: string };
}
async function activity(w: Who, body: Record<string, unknown>) {
  const res = await w.agent.post(`${base(w)}/activities`).send(body);
  expect(res.status).toBe(201);
  return res.body.activity as { id: string };
}
const dashboard = async (w: Who) => {
  const res = await w.agent.get(`${base(w)}/dashboard`);
  expect(res.status).toBe(200);
  return res.body as {
    openDeals: { count: number; totals: { currency: string; value: number }[] };
    stages: { stage: string; count: number; totals: { currency: string; value: number }[] }[];
    overdueTasks: {
      count: number;
      items: {
        id: string;
        content: string;
        contactName: string | null;
        dealTitle: string | null;
      }[];
    };
  };
};

describe('dashboard', () => {
  it('is all zeros for an empty workspace, with every stage present in order', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const d = await dashboard(a);
    expect(d.openDeals).toEqual({ count: 0, totals: [] });
    expect(d.stages.map((s) => s.stage)).toEqual([
      'lead',
      'qualified',
      'proposal',
      'negotiation',
      'won',
      'lost',
    ]);
    expect(d.stages.every((s) => s.count === 0 && s.totals.length === 0)).toBe(true);
    expect(d.overdueTasks).toEqual({ count: 0, items: [] });
  });

  it('counts deals per stage and only sums open deals into the pipeline', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await deal(a, { title: 'A', value: 1000.5, stage: 'lead' });
    await deal(a, { title: 'B', value: 2000, stage: 'lead' });
    await deal(a, { title: 'C', value: 500, stage: 'negotiation' });
    await deal(a, { title: 'D', value: 9999, stage: 'won' });
    await deal(a, { title: 'E', value: 7777, stage: 'lost' });

    const d = await dashboard(a);
    expect(d.openDeals).toEqual({ count: 3, totals: [{ currency: 'USD', value: 3500.5 }] });
    const by = Object.fromEntries(d.stages.map((s) => [s.stage, s]));
    expect(by['lead']).toMatchObject({ count: 2, totals: [{ currency: 'USD', value: 3000.5 }] });
    expect(by['negotiation']).toMatchObject({
      count: 1,
      totals: [{ currency: 'USD', value: 500 }],
    });
    expect(by['won']).toMatchObject({ count: 1, totals: [{ currency: 'USD', value: 9999 }] });
    expect(by['lost']).toMatchObject({ count: 1 });
    expect(by['qualified']).toMatchObject({ count: 0, totals: [] });
  });

  it('keeps currencies apart instead of adding them together', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await deal(a, { title: 'US', value: 100, currency: 'USD' });
    await deal(a, { title: 'EU', value: 200, currency: 'eur' });
    await deal(a, { title: 'EU2', value: 50, currency: 'EUR', stage: 'proposal' });

    const d = await dashboard(a);
    expect(d.openDeals.count).toBe(3);
    expect(d.openDeals.totals).toEqual([
      { currency: 'EUR', value: 250 },
      { currency: 'USD', value: 100 },
    ]);
  });

  it('lists only open, past-due tasks, oldest first, with who or what they belong to', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const ada = await contact(a, 'Ada', 'Lovelace');
    const big = await deal(a, { title: 'Big deal' });

    await activity(a, {
      type: 'task',
      content: 'newer overdue',
      dealId: big.id,
      dueAt: '2021-01-01T09:00:00.000Z',
    });
    await activity(a, { type: 'task', content: 'oldest overdue', contactId: ada.id, dueAt: PAST });
    await activity(a, { type: 'task', content: 'not due yet', contactId: ada.id, dueAt: FUTURE });
    await activity(a, { type: 'task', content: 'no due date', contactId: ada.id });
    await activity(a, { type: 'note', content: 'a note', contactId: ada.id });
    const done = await activity(a, {
      type: 'task',
      content: 'already done',
      contactId: ada.id,
      dueAt: PAST,
    });
    expect(
      (await a.agent.patch(`${base(a)}/activities/${done.id}`).send({ completed: true })).status,
    ).toBe(200);

    const { overdueTasks } = await dashboard(a);
    expect(overdueTasks.count).toBe(2);
    expect(overdueTasks.items.map((t) => t.content)).toEqual(['oldest overdue', 'newer overdue']);
    expect(overdueTasks.items[0]).toMatchObject({ contactName: 'Ada Lovelace', dealTitle: null });
    expect(overdueTasks.items[1]).toMatchObject({ contactName: null, dealTitle: 'Big deal' });
  });

  it('reports the full overdue count but returns at most five tasks', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const ada = await contact(a, 'Ada');
    for (let i = 1; i <= 7; i++) {
      await activity(a, { type: 'task', content: `late ${i}`, contactId: ada.id, dueAt: PAST });
    }
    const { overdueTasks } = await dashboard(a);
    expect(overdueTasks.count).toBe(7);
    expect(overdueTasks.items).toHaveLength(5);
  });

  it('never shows data from another workspace', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const ada = await contact(b, 'Secret');
    await deal(b, { title: 'B deal', value: 123 });
    await activity(b, { type: 'task', content: 'B task', contactId: ada.id, dueAt: PAST });

    const d = await dashboard(a);
    expect(d.openDeals.count).toBe(0);
    expect(d.overdueTasks.count).toBe(0);
    // and a cannot read b's dashboard by guessing its id
    expect((await a.agent.get(`${base(b)}/dashboard`)).status).toBe(404);
  });

  it('is readable by a plain member but not by an outsider', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const outsider = await signUp(app);
    expect((await outsider.agent.get(`${base(a)}/dashboard`)).status).toBe(404);

    const member = await signUp(app);
    await addMember(a.workspaceId, member.userId, 'member');
    expect((await member.agent.get(`${base(a)}/dashboard`)).status).toBe(200);
  });

  it('rejects requests without a session', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await request(app).get(`${base(a)}/dashboard`);
    expect(res.status).toBe(401);
  });
});
