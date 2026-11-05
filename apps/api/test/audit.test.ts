import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, buildApp, closeDb, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const base = (w: Who) => `/api/workspaces/${w.workspaceId}`;

interface Entry {
  id: string;
  action: string;
  entityType: string;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
interface AuditPage {
  items: Entry[];
  total: number;
  page: number;
  pageSize: number;
}

async function contact(w: Who, firstName: string) {
  const res = await w.agent.post(`${base(w)}/contacts`).send({ firstName });
  expect(res.status).toBe(201);
  return res.body.contact as { id: string };
}
async function audit(w: Who, query = '') {
  const res = await w.agent.get(`${base(w)}/audit${query}`);
  expect(res.status).toBe(200);
  return res.body as AuditPage;
}

describe('audit log viewer', () => {
  it('lets the owner read entries, newest first, with the actor name', async () => {
    const { app } = buildApp();
    const a = await signUp(app, { name: 'Olive Owner' });
    await contact(a, 'First');
    await contact(a, 'Second');
    const res = await audit(a, '?entityType=contact');
    expect(res.total).toBe(2);
    expect(res.items.map((e) => e.action)).toEqual(['contact.created', 'contact.created']);
    expect(res.items[0]?.actorName).toBe('Olive Owner');
    expect(res.items[0]?.actorId).toBe(a.userId);
    expect(new Date(res.items[0]?.createdAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(res.items[1]?.createdAt ?? 0).getTime(),
    );
  });

  it('lets admins read but refuses members with 403', async () => {
    const { app } = buildApp();
    const owner = await signUp(app);
    const admin = await signUp(app);
    const member = await signUp(app);
    await addMember(owner.workspaceId, admin.userId, 'admin');
    await addMember(owner.workspaceId, member.userId, 'member');
    await contact(owner, 'Ada');

    const asAdmin = await admin.agent.get(`${base(owner)}/audit`);
    expect(asAdmin.status).toBe(200);
    const asMember = await member.agent.get(`${base(owner)}/audit`);
    expect(asMember.status).toBe(403);
    expect(asMember.body.error.code).toBe('forbidden');
  });

  it('needs a sign-in, and hides the workspace from non-members with 404', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const stranger = await signUp(app);
    const anon = await request(app).get(`${base(a)}/audit`);
    expect(anon.status).toBe(401);
    const res = await stranger.agent.get(`${base(a)}/audit`);
    expect(res.status).toBe(404);
  });

  it("never shows another workspace's entries", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    await contact(a, 'Only in A');
    await contact(b, 'Only in B');
    await contact(b, 'Also in B');
    const forA = await audit(a, '?entityType=contact');
    const forB = await audit(b, '?entityType=contact');
    expect(forA.total).toBe(1);
    expect(forB.total).toBe(2);
    const ids = new Set(forA.items.map((e) => e.id));
    expect(forB.items.some((e) => ids.has(e.id))).toBe(false);
  });

  it('filters by entity type and by actor', async () => {
    const { app } = buildApp();
    const owner = await signUp(app, { name: 'Olive Owner' });
    const other = await signUp(app, { name: 'Max Member' });
    await addMember(owner.workspaceId, other.userId, 'member');
    await contact(owner, 'By owner');
    const res = await other.agent.post(`${base(owner)}/companies`).send({ name: 'Acme' });
    expect(res.status).toBe(201);

    const companies = await audit(owner, '?entityType=company');
    expect(companies.items.map((e) => e.action)).toEqual(['company.created']);
    expect(companies.items[0]?.actorName).toBe('Max Member');

    const byOwner = await audit(owner, `?actorId=${owner.userId}`);
    expect(byOwner.items.length).toBeGreaterThan(0);
    expect(byOwner.items.every((e) => e.actorId === owner.userId)).toBe(true);
  });

  it('pages through the results without overlaps', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    for (const n of ['a', 'b', 'c', 'd', 'e']) await contact(a, n);
    const p1 = await audit(a, '?entityType=contact&pageSize=2&page=1');
    const p2 = await audit(a, '?entityType=contact&pageSize=2&page=2');
    const p3 = await audit(a, '?entityType=contact&pageSize=2&page=3');
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([2, 2, 1]);
    expect(p1.total).toBe(5);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('rejects bad query values with 400', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    for (const q of ['?entityType=nope', '?actorId=not-a-uuid', '?page=0', '?pageSize=1000']) {
      const res = await a.agent.get(`${base(a)}/audit${q}`);
      expect(res.status, q).toBe(400);
    }
  });

  it('keeps note text and personal data out of the entries', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const c = await contact(a, 'Secretive');
    const note = await a.agent
      .post(`${base(a)}/activities`)
      .send({ type: 'note', content: 'TOP-SECRET-NOTE-TEXT', contactId: c.id });
    expect(note.status).toBe(201);
    const res = await a.agent.get(`${base(a)}/audit`);
    expect(JSON.stringify(res.body)).not.toContain('TOP-SECRET-NOTE-TEXT');
    expect(JSON.stringify(res.body)).not.toContain('Secretive');
  });
});
