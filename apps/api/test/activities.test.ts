import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs } from '../src/db/schema';
import { addMember, buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const url = (w: Who, path = '') => `/api/workspaces/${w.workspaceId}/activities${path}`;
const DUE = '2030-01-01T09:00:00.000Z';

async function makeContact(w: Who, firstName = 'Ada') {
  return (await w.agent.post(`/api/workspaces/${w.workspaceId}/contacts`).send({ firstName })).body
    .contact as {
    id: string;
  };
}
async function makeDeal(w: Who, title = 'Big deal') {
  return (await w.agent.post(`/api/workspaces/${w.workspaceId}/deals`).send({ title })).body
    .deal as { id: string };
}
async function note(w: Who, body: Record<string, unknown>) {
  return w.agent.post(url(w)).send({ type: 'note', content: 'Spoke on the phone', ...body });
}

describe('creating activities', () => {
  it('logs a note on a contact', async () => {
    const { app } = buildApp();
    const a = await signUp(app, { name: 'Alice' });
    const contact = await makeContact(a);
    const res = await note(a, { contactId: contact.id });
    expect(res.status).toBe(201);
    expect(res.body.activity).toMatchObject({
      type: 'note',
      content: 'Spoke on the phone',
      contactId: contact.id,
      dealId: null,
      dueAt: null,
      completedAt: null,
      createdBy: a.userId,
      createdByName: 'Alice',
    });
  });

  it('creates a task with a due date on a deal', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const deal = await makeDeal(a);
    const res = await note(a, {
      type: 'task',
      content: 'Send proposal',
      dealId: deal.id,
      dueAt: DUE,
    });
    expect(res.status).toBe(201);
    expect(res.body.activity).toMatchObject({ type: 'task', dealId: deal.id, dueAt: DUE });
  });

  it('can link both a contact and a deal', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = await makeContact(a);
    const deal = await makeDeal(a);
    const res = await note(a, { type: 'call', contactId: contact.id, dealId: deal.id });
    expect(res.status).toBe(201);
    expect(res.body.activity).toMatchObject({ contactId: contact.id, dealId: deal.id });
  });

  it('validates input', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = await makeContact(a);
    expect((await note(a, {})).status).toBe(400); // no contact or deal
    expect((await note(a, { contactId: contact.id, content: '   ' })).status).toBe(400);
    expect((await note(a, { contactId: contact.id, content: 'x'.repeat(2001) })).status).toBe(400);
    expect((await note(a, { contactId: contact.id, type: 'email' })).status).toBe(400);
    expect((await note(a, { contactId: contact.id, type: 'task', dueAt: 'tomorrow' })).status).toBe(
      400,
    );
    expect((await note(a, { contactId: 'nope' })).status).toBe(400);
    // only tasks have due dates
    expect((await note(a, { contactId: contact.id, type: 'note', dueAt: DUE })).status).toBe(400);
  });

  it("refuses another workspace's contact or deal", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const contact = await makeContact(a);
    const deal = await makeDeal(a);
    const badContact = await note(b, { contactId: contact.id });
    expect(badContact.status).toBe(400);
    expect(badContact.body.error.code).toBe('invalid_contact');
    const badDeal = await note(b, { dealId: deal.id });
    expect(badDeal.status).toBe(400);
    expect(badDeal.body.error.code).toBe('invalid_deal');
  });

  it('writes an audit log entry without the note text', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = await makeContact(a);
    const id = (await note(a, { contactId: contact.id })).body.activity.id;
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'activity.created'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entityId: id, workspaceId: a.workspaceId, actorId: a.userId });
    expect(JSON.stringify(logs[0]?.metadata)).not.toContain('Spoke on the phone');
  });

  it('requires authentication', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await request(app).get(url(a))).status).toBe(401);
  });
});

describe('listing', () => {
  it('filters by contact, deal, type and task status, newest first', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = await makeContact(a);
    const deal = await makeDeal(a);
    await note(a, { contactId: contact.id, content: 'first' });
    const task = (
      await note(a, { contactId: contact.id, type: 'task', content: 'call back', dueAt: DUE })
    ).body.activity;
    await note(a, { dealId: deal.id, content: 'on the deal' });
    await a.agent.patch(url(a, `/${task.id}`)).send({ completed: true });
    await note(a, { contactId: contact.id, type: 'task', content: 'still open', dueAt: DUE });

    const byContact = (await a.agent.get(url(a) + `?contactId=${contact.id}`)).body.items;
    expect(byContact.map((x: { content: string }) => x.content)).toEqual([
      'still open',
      'call back',
      'first',
    ]);
    expect((await a.agent.get(url(a) + `?dealId=${deal.id}`)).body.items).toHaveLength(1);
    expect((await a.agent.get(url(a) + '?type=task')).body.items).toHaveLength(2);
    expect(
      (await a.agent.get(url(a) + '?status=open')).body.items.map(
        (x: { content: string }) => x.content,
      ),
    ).toEqual(['still open']);
    expect(
      (await a.agent.get(url(a) + '?status=done')).body.items.map(
        (x: { content: string }) => x.content,
      ),
    ).toEqual(['call back']);
    expect((await a.agent.get(url(a) + '?type=nope')).status).toBe(400);
    expect((await a.agent.get(url(a) + '?limit=2')).body.items).toHaveLength(2);
  });
});

describe('tenant isolation', () => {
  it("never shows, changes or deletes another workspace's activities", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const contact = await makeContact(a);
    const id = (await note(a, { contactId: contact.id })).body.activity.id;

    expect((await b.agent.get(url(b))).body.items).toHaveLength(0);
    expect((await b.agent.get(url(b) + `?contactId=${contact.id}`)).body.items).toHaveLength(0);
    expect((await b.agent.patch(url(b, `/${id}`)).send({ content: 'Hacked' })).status).toBe(404);
    expect((await b.agent.delete(url(b, `/${id}`))).status).toBe(404);
    expect((await b.agent.get(url(a))).status).toBe(404); // not a member of A

    const mine = (await a.agent.get(url(a))).body.items;
    expect(mine).toHaveLength(1);
    expect(mine[0].content).toBe('Spoke on the phone');
  });
});

describe('updating', () => {
  it('edits text and due date, completes and reopens a task', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = await makeContact(a);
    const id = (
      await note(a, { contactId: contact.id, type: 'task', content: 'Send quote', dueAt: DUE })
    ).body.activity.id;

    const edited = await a.agent
      .patch(url(a, `/${id}`))
      .send({ content: 'Send revised quote', dueAt: null });
    expect(edited.status).toBe(200);
    expect(edited.body.activity).toMatchObject({ content: 'Send revised quote', dueAt: null });

    const done = await a.agent.patch(url(a, `/${id}`)).send({ completed: true });
    expect(done.body.activity.completedAt).not.toBeNull();
    const reopened = await a.agent.patch(url(a, `/${id}`)).send({ completed: false });
    expect(reopened.body.activity.completedAt).toBeNull();

    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, 'activity.completed')),
    ).toHaveLength(2);
  });

  it('refuses to complete notes and rejects empty or invalid updates', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = await makeContact(a);
    const id = (await note(a, { contactId: contact.id })).body.activity.id;
    const res = await a.agent.patch(url(a, `/${id}`)).send({ completed: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_a_task');
    expect((await a.agent.patch(url(a, `/${id}`)).send({})).status).toBe(400);
    expect((await a.agent.patch(url(a, `/${id}`)).send({ content: '' })).status).toBe(400);
    expect(
      (await a.agent.patch(url(a, '/00000000-0000-4000-8000-000000000000')).send({ content: 'x' }))
        .status,
    ).toBe(404);
  });
});

describe('deleting and permissions', () => {
  it('lets members delete only their own activities; admins delete any', async () => {
    const { app } = buildApp();
    const owner = await signUp(app);
    const member = await signUp(app);
    const admin = await signUp(app);
    await addMember(owner.workspaceId, member.userId, 'member');
    await addMember(owner.workspaceId, admin.userId, 'admin');
    const contact = await makeContact(owner);

    const ownersNote = (await note(owner, { contactId: contact.id })).body.activity.id;
    const membersNote = (
      await member.agent
        .post(url(owner))
        .send({ type: 'note', content: 'mine', contactId: contact.id })
    ).body.activity.id;

    expect((await member.agent.delete(url(owner, `/${ownersNote}`))).status).toBe(403);
    expect((await member.agent.delete(url(owner, `/${membersNote}`))).status).toBe(204);
    expect((await admin.agent.delete(url(owner, `/${ownersNote}`))).status).toBe(204);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, 'activity.deleted')),
    ).toHaveLength(2);
  });

  it('removes activities when their contact is deleted', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = await makeContact(a);
    await note(a, { contactId: contact.id });
    expect(
      (await a.agent.delete(`/api/workspaces/${a.workspaceId}/contacts/${contact.id}`)).status,
    ).toBe(204);
    expect((await a.agent.get(url(a))).body.items).toHaveLength(0);
  });
});
