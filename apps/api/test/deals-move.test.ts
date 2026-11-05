import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, closeDb, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const url = (w: Who, path = '') => `/api/workspaces/${w.workspaceId}/deals${path}`;

async function mk(w: Who, title: string, stage = 'lead') {
  return (await w.agent.post(url(w)).send({ title, stage })).body.deal as {
    id: string;
    title: string;
  };
}
async function column(w: Who, stage: string) {
  const items = (await w.agent.get(url(w) + `?stage=${stage}`)).body.items as {
    title: string;
    position: number;
  }[];
  return { titles: items.map((d) => d.title), positions: items.map((d) => d.position) };
}
const move = (w: Who, id: string, stage: string, position: number) =>
  w.agent.post(url(w, `/${id}/move`)).send({ stage, position });

describe('moving deals between and inside columns', () => {
  it('inserts at the right slot even when earlier moves left gaps', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const A = await mk(a, 'A');
    const B = await mk(a, 'B');
    await mk(a, 'C');
    await mk(a, 'D');
    const X = await mk(a, 'X', 'qualified');

    await move(a, B.id, 'qualified', 0); // leaves lead as A(0) C(2) D(3), a gap
    expect((await column(a, 'lead')).titles).toEqual(['A', 'C', 'D']);

    await move(a, X.id, 'lead', 2); // after A and C, before D
    const lead = await column(a, 'lead');
    expect(lead.titles).toEqual(['A', 'C', 'X', 'D']);
    expect(lead.positions).toEqual([0, 1, 2, 3]);
    expect(A.id).toBeTruthy();
  });

  it('appends when the position is past the end of the column', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const one = await mk(a, 'One');
    const two = await mk(a, 'Two');
    const three = await mk(a, 'Three');
    for (const d of [one, two, three]) expect((await move(a, d.id, 'won', 9999)).status).toBe(200);
    const won = await column(a, 'won');
    expect(won.titles).toEqual(['One', 'Two', 'Three']);
    expect(won.positions).toEqual([0, 1, 2]);
  });

  it('reorders within the same column', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const A = await mk(a, 'A');
    const B = await mk(a, 'B');
    await mk(a, 'C');

    await move(a, A.id, 'lead', 2);
    expect((await column(a, 'lead')).titles).toEqual(['B', 'C', 'A']);
    await move(a, A.id, 'lead', 0);
    expect((await column(a, 'lead')).titles).toEqual(['A', 'B', 'C']);
    await move(a, B.id, 'lead', 1); // already there
    const lead = await column(a, 'lead');
    expect(lead.titles).toEqual(['A', 'B', 'C']);
    expect(lead.positions).toEqual([0, 1, 2]);
  });

  it('keeps new deals at the bottom after deletes and moves', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const A = await mk(a, 'A');
    await mk(a, 'B');
    await a.agent.delete(url(a, `/${A.id}`));
    await mk(a, 'C');
    expect((await column(a, 'lead')).titles).toEqual(['B', 'C']);
  });
});
