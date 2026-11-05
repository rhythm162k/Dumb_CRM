import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs, contacts } from '../src/db/schema';
import { addMember, buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const url = (w: Who, path = '') => `/api/workspaces/${w.workspaceId}/contacts${path}`;
const companyUrl = (w: Who, path = '') => `/api/workspaces/${w.workspaceId}/companies${path}`;

async function create(w: Who, body: Record<string, unknown> = {}) {
  return w.agent.post(url(w)).send({ firstName: 'Ada', ...body });
}

describe('creating contacts', () => {
  it('creates a contact with just a first name', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await create(a);
    expect(res.status).toBe(201);
    expect(res.body.contact).toMatchObject({
      firstName: 'Ada',
      lastName: null,
      email: null,
      tags: [],
      companyName: null,
    });
  });

  it('normalises input: lowercase email, deduplicated lowercase tags, empty strings become null', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await create(a, {
      email: '  Ada@Example.COM ',
      tags: ['VIP', 'vip', ' Lead '],
      phone: '',
      jobTitle: '  ',
    });
    expect(res.status).toBe(201);
    expect(res.body.contact).toMatchObject({
      email: 'ada@example.com',
      tags: ['vip', 'lead'],
      phone: null,
      jobTitle: null,
    });
  });

  it('validates input', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await create(a, { firstName: '' })).status).toBe(400);
    expect((await create(a, { email: 'nope' })).status).toBe(400);
    expect((await create(a, { phone: 'abc' })).status).toBe(400);
    expect(
      (
        await create(a, {
          tags: Array(21)
            .fill('x')
            .map((t, i) => t + i),
        })
      ).status,
    ).toBe(400);
    expect((await create(a, { companyId: 'not-a-uuid' })).status).toBe(400);
    expect((await a.agent.post(url(a)).send({})).status).toBe(400);
  });

  it('rejects duplicate emails (any case) and says who already has it', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await create(a, { firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com' });
    const dup = await create(a, { email: 'GRACE@example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_contact');
    expect(dup.body.error.message).toContain('Grace Hopper');
  });

  it('allows the same email in different workspaces', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    expect((await create(a, { email: 'shared@example.com' })).status).toBe(201);
    expect((await create(b, { email: 'shared@example.com' })).status).toBe(201);
  });

  it('writes an audit log entry without personal data', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await create(a, { email: 'ada@example.com' });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'contact.created'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspaceId: a.workspaceId,
      actorId: a.userId,
      entityId: res.body.contact.id,
    });
    expect(JSON.stringify(logs[0])).not.toContain('ada@example.com');
  });
});

describe('tenant isolation', () => {
  it('hides another workspace entirely', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const contact = (await create(a)).body.contact;

    expect((await b.agent.get(`/api/workspaces/${a.workspaceId}/contacts`)).status).toBe(404);
    expect((await b.agent.post(url(a)).send({ firstName: 'Mallory' })).status).toBe(404);
    expect((await b.agent.delete(url(a, `/${contact.id}`))).status).toBe(404);
  });

  it("cannot reach another workspace's contact by id through your own workspace", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const contact = (await create(a)).body.contact;

    expect((await b.agent.get(url(b, `/${contact.id}`))).status).toBe(404);
    expect(
      (await b.agent.patch(url(b, `/${contact.id}`)).send({ firstName: 'Hacked' })).status,
    ).toBe(404);
    expect((await b.agent.delete(url(b, `/${contact.id}`))).status).toBe(404);

    const [row] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(row?.firstName).toBe('Ada');
  });

  it("refuses to link a contact to another workspace's company", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const company = (await a.agent.post(companyUrl(a)).send({ name: 'Acme' })).body.company;
    const res = await create(b, { companyId: company.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_company');
    const patch = await create(b).then((r) =>
      b.agent.patch(url(b, `/${r.body.contact.id}`)).send({ companyId: company.id }),
    );
    expect(patch.status).toBe(400);
  });

  it('requires authentication', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await request(app).get(url(a))).status).toBe(401);
  });
});

describe('permissions', () => {
  it('lets members create and edit but only admins delete', async () => {
    const { app } = buildApp();
    const owner = await signUp(app);
    const member = await signUp(app);
    const admin = await signUp(app);
    await addMember(owner.workspaceId, member.userId, 'member');
    await addMember(owner.workspaceId, admin.userId, 'admin');

    const created = await member.agent.post(url(owner)).send({ firstName: 'Ada' });
    expect(created.status).toBe(201);
    const id = created.body.contact.id;
    expect(
      (await member.agent.patch(url(owner, `/${id}`)).send({ lastName: 'Lovelace' })).status,
    ).toBe(200);
    expect((await member.agent.delete(url(owner, `/${id}`))).status).toBe(403);
    expect((await admin.agent.delete(url(owner, `/${id}`))).status).toBe(204);
  });
});

describe('listing and search', () => {
  it('searches name, email, phone and company, and filters by tag and company', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const acme = (await a.agent.post(companyUrl(a)).send({ name: 'Acme Corp' })).body.company;
    await create(a, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@math.org',
      companyId: acme.id,
      tags: ['vip'],
    });
    await create(a, { firstName: 'Bob', phone: '+1 555 0100' });

    const search = async (qs: string) => (await a.agent.get(url(a) + qs)).body;
    expect((await search('?q=lovelace')).total).toBe(1);
    expect((await search('?q=ada love')).total).toBe(1);
    expect((await search('?q=math.org')).total).toBe(1);
    expect((await search('?q=555')).items[0].firstName).toBe('Bob');
    expect((await search('?q=acme')).items[0].firstName).toBe('Ada');
    expect((await search('?tag=VIP')).total).toBe(1);
    expect((await search(`?companyId=${acme.id}`)).total).toBe(1);
    expect((await search('?q=zzz')).total).toBe(0);
  });

  it('treats % and _ in the search as plain characters', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await create(a, { firstName: 'Ann' });
    await create(a, { firstName: '100% Real' });
    const res = await a.agent.get(url(a) + '?q=%25');
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].firstName).toBe('100% Real');
  });

  it('paginates and only counts this workspace', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    for (let i = 0; i < 5; i++) await create(a, { firstName: `P${i}` });
    await create(b, { firstName: 'Other' });

    const page3 = (await a.agent.get(url(a) + '?pageSize=2&page=3')).body;
    expect(page3).toMatchObject({ total: 5, page: 3, pageSize: 2 });
    expect(page3.items).toHaveLength(1);
    expect((await a.agent.get(url(a) + '?pageSize=1000')).status).toBe(400);
  });
});

describe('updating and deleting', () => {
  it('updates only the given fields and can clear others', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const id = (await create(a, { lastName: 'Lovelace', email: 'ada@math.org', tags: ['x'] })).body
      .contact.id;

    const res = await a.agent.patch(url(a, `/${id}`)).send({ jobTitle: 'Engineer', email: null });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      jobTitle: 'Engineer',
      email: null,
      lastName: 'Lovelace',
      tags: ['x'],
    });
    expect((await a.agent.patch(url(a, `/${id}`)).send({})).status).toBe(400);
  });

  it('blocks changing an email to one that exists', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await create(a, { email: 'one@example.com' });
    const two = (await create(a, { firstName: 'Two', email: 'two@example.com' })).body.contact;
    expect(
      (await a.agent.patch(url(a, `/${two.id}`)).send({ email: 'ONE@example.com' })).status,
    ).toBe(409);
    expect(
      (await a.agent.patch(url(a, `/${two.id}`)).send({ email: 'two@example.com' })).status,
    ).toBe(200);
  });

  it('returns 404 for unknown ids and 400 for malformed ones', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await a.agent.get(url(a, '/00000000-0000-4000-8000-000000000000'))).status).toBe(404);
    expect((await a.agent.get(url(a, '/nope'))).status).toBe(400);
  });

  it('deletes a contact and logs it', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const id = (await create(a)).body.contact.id;
    expect((await a.agent.delete(url(a, `/${id}`))).status).toBe(204);
    expect((await a.agent.get(url(a, `/${id}`))).status).toBe(404);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, 'contact.deleted')),
    ).toHaveLength(1);
  });
});
