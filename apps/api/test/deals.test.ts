import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs } from '../src/db/schema';
import { addMember, buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const url = (w: Who, path = '') => `/api/workspaces/${w.workspaceId}/deals${path}`;

async function create(w: Who, body: Record<string, unknown> = {}) {
  return w.agent.post(url(w)).send({ title: 'Website redesign', ...body });
}

describe('creating deals', () => {
  it('creates a deal with defaults and returns the value as a number', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await create(a, { value: 1500.5 });
    expect(res.status).toBe(201);
    expect(res.body.deal).toMatchObject({
      title: 'Website redesign',
      value: 1500.5,
      currency: 'USD',
      stage: 'lead',
      position: 0,
      contactName: null,
      companyName: null,
      ownerId: a.userId,
    });
  });

  it('appends new deals to the bottom of their stage', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const first = await create(a, { title: 'One' });
    const second = await create(a, { title: 'Two' });
    const other = await create(a, { title: 'Three', stage: 'proposal' });
    expect(first.body.deal.position).toBe(0);
    expect(second.body.deal.position).toBe(1);
    expect(other.body.deal.position).toBe(0);
  });

  it('validates input', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await create(a, { title: '' })).status).toBe(400);
    expect((await create(a, { value: -1 })).status).toBe(400);
    expect((await create(a, { value: 'lots' })).status).toBe(400);
    expect((await create(a, { stage: 'maybe' })).status).toBe(400);
    expect((await create(a, { currency: 'DOLLARS' })).status).toBe(400);
    expect((await create(a, { expectedCloseDate: 'tomorrow' })).status).toBe(400);
    expect((await create(a, { contactId: 'nope' })).status).toBe(400);
    expect((await a.agent.post(url(a)).send({})).status).toBe(400);
  });

  it('links a contact and company and shows their names', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const company = (
      await a.agent.post(`/api/workspaces/${a.workspaceId}/companies`).send({ name: 'Acme' })
    ).body.company;
    const contact = (
      await a.agent
        .post(`/api/workspaces/${a.workspaceId}/contacts`)
        .send({ firstName: 'Ada', lastName: 'Lovelace' })
    ).body.contact;
    const res = await create(a, {
      companyId: company.id,
      contactId: contact.id,
      expectedCloseDate: '2026-12-31',
    });
    expect(res.status).toBe(201);
    expect(res.body.deal).toMatchObject({
      companyName: 'Acme',
      contactName: 'Ada Lovelace',
      expectedCloseDate: '2026-12-31',
    });
  });

  it("refuses to link another workspace's contact or company", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const company = (
      await a.agent.post(`/api/workspaces/${a.workspaceId}/companies`).send({ name: 'Acme' })
    ).body.company;
    const contact = (
      await a.agent.post(`/api/workspaces/${a.workspaceId}/contacts`).send({ firstName: 'Ada' })
    ).body.contact;
    const badCompany = await create(b, { companyId: company.id });
    expect(badCompany.status).toBe(400);
    expect(badCompany.body.error.code).toBe('invalid_company');
    const badContact = await create(b, { contactId: contact.id });
    expect(badContact.status).toBe(400);
    expect(badContact.body.error.code).toBe('invalid_contact');
  });

  it('writes an audit log entry', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const id = (await create(a)).body.deal.id;
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'deal.created'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entityId: id, workspaceId: a.workspaceId, actorId: a.userId });
  });

  it('requires authentication', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await request(app).get(url(a))).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it("never shows, changes, moves or deletes another workspace's deals", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const id = (await create(a)).body.deal.id;

    expect((await b.agent.get(url(b))).body.items).toHaveLength(0);
    expect((await b.agent.get(url(b, `/${id}`))).status).toBe(404);
    expect((await b.agent.patch(url(b, `/${id}`)).send({ title: 'Hacked' })).status).toBe(404);
    expect((await b.agent.post(url(b, `/${id}/move`)).send({ stage: 'won' })).status).toBe(404);
    expect((await b.agent.delete(url(b, `/${id}`))).status).toBe(404);
    // and a workspace you are not in is invisible
    expect((await b.agent.get(url(a))).status).toBe(404);

    const still = await a.agent.get(url(a, `/${id}`));
    expect(still.body.deal).toMatchObject({ title: 'Website redesign', stage: 'lead' });
  });
});

describe('listing', () => {
  it('returns the board ordered by stage then position, and supports search and stage filter', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await create(a, { title: 'Alpha', stage: 'proposal' });
    await create(a, { title: 'Beta', stage: 'lead' });
    await create(a, { title: 'Gamma', stage: 'lead' });

    const all = (await a.agent.get(url(a))).body.items.map((d: { title: string }) => d.title);
    expect(all).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect((await a.agent.get(url(a) + '?q=alp')).body.items).toHaveLength(1);
    expect((await a.agent.get(url(a) + '?stage=lead')).body.items).toHaveLength(2);
    expect((await a.agent.get(url(a) + '?stage=nope')).status).toBe(400);
  });
});

describe('updating, moving and deleting', () => {
  it('updates only the given fields and can clear links and dates', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const id = (await create(a, { value: 100, expectedCloseDate: '2026-01-01' })).body.deal.id;
    const res = await a.agent.patch(url(a, `/${id}`)).send({ value: 250, expectedCloseDate: null });
    expect(res.status).toBe(200);
    expect(res.body.deal).toMatchObject({
      value: 250,
      expectedCloseDate: null,
      title: 'Website redesign',
    });
    expect((await a.agent.patch(url(a, `/${id}`)).send({})).status).toBe(400);
  });

  it('moves a deal to another stage and slot, shifting the cards below it', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const one = (await create(a, { title: 'One', stage: 'qualified' })).body.deal;
    const two = (await create(a, { title: 'Two', stage: 'qualified' })).body.deal;
    const mover = (await create(a, { title: 'Mover', stage: 'lead' })).body.deal;

    const moved = await a.agent
      .post(url(a, `/${mover.id}/move`))
      .send({ stage: 'qualified', position: 1 });
    expect(moved.status).toBe(200);
    expect(moved.body.deal).toMatchObject({ stage: 'qualified', position: 1 });

    const board = (await a.agent.get(url(a) + '?stage=qualified')).body.items;
    expect(board.map((d: { title: string }) => d.title)).toEqual(['One', 'Mover', 'Two']);
    expect(board.map((d: { id: string }) => d.id)).toEqual([one.id, mover.id, two.id]);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, 'deal.moved')),
    ).toHaveLength(1);
  });

  it('validates moves and returns 404 for unknown ids', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const id = (await create(a)).body.deal.id;
    expect((await a.agent.post(url(a, `/${id}/move`)).send({ stage: 'nope' })).status).toBe(400);
    expect(
      (await a.agent.post(url(a, `/${id}/move`)).send({ stage: 'won', position: -1 })).status,
    ).toBe(400);
    expect(
      (
        await a.agent
          .post(url(a, '/00000000-0000-4000-8000-000000000000/move'))
          .send({ stage: 'won' })
      ).status,
    ).toBe(404);
    expect((await a.agent.get(url(a, '/nope'))).status).toBe(400);
  });

  it('deletes a deal and logs it', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const id = (await create(a)).body.deal.id;
    expect((await a.agent.delete(url(a, `/${id}`))).status).toBe(204);
    expect((await a.agent.get(url(a, `/${id}`))).status).toBe(404);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, 'deal.deleted')),
    ).toHaveLength(1);
  });
});

describe('permissions', () => {
  it('lets members create, edit and move but only admins delete', async () => {
    const { app } = buildApp();
    const owner = await signUp(app);
    const member = await signUp(app);
    const admin = await signUp(app);
    await addMember(owner.workspaceId, member.userId, 'member');
    await addMember(owner.workspaceId, admin.userId, 'admin');

    const created = await member.agent.post(url(owner)).send({ title: 'Big deal' });
    expect(created.status).toBe(201);
    const id = created.body.deal.id;
    expect(
      (await member.agent.patch(url(owner, `/${id}`)).send({ title: 'Bigger deal' })).status,
    ).toBe(200);
    expect((await member.agent.post(url(owner, `/${id}/move`)).send({ stage: 'won' })).status).toBe(
      200,
    );
    expect((await member.agent.delete(url(owner, `/${id}`))).status).toBe(403);
    expect((await admin.agent.delete(url(owner, `/${id}`))).status).toBe(204);
  });
});
