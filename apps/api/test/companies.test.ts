import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { contacts } from '../src/db/schema';
import { addMember, buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const url = (w: Who, path = '') => `/api/workspaces/${w.workspaceId}/companies${path}`;
const mk = (w: Who, body: Record<string, unknown> = {}) =>
  w.agent.post(url(w)).send({ name: 'Acme', ...body });

describe('companies', () => {
  it('creates a company and normalises the website', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await mk(a, { website: 'Acme.com/', industry: 'Anvils' });
    expect(res.status).toBe(201);
    expect(res.body.company).toMatchObject({
      name: 'Acme',
      website: 'https://acme.com',
      industry: 'Anvils',
      contactCount: 0,
    });
  });

  it('rejects unsafe or invalid websites', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await mk(a, { website: 'javascript:alert(1)' })).status).toBe(400);
    expect((await mk(a, { website: 'not a url' })).status).toBe(400);
    expect((await mk(a, { name: '' })).status).toBe(400);
  });

  it('rejects duplicate names case-insensitively, per workspace', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    await mk(a, { name: 'Acme' });
    const dup = await mk(a, { name: 'ACME' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_company');
    expect((await mk(b, { name: 'Acme' })).status).toBe(201);
  });

  it('lists with search and a contact count', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const acme = (await mk(a)).body.company;
    await mk(a, { name: 'Globex' });
    await a.agent
      .post(`/api/workspaces/${a.workspaceId}/contacts`)
      .send({ firstName: 'Ada', companyId: acme.id });

    const all = (await a.agent.get(url(a))).body;
    expect(all.total).toBe(2);
    expect(all.items.find((c: { name: string }) => c.name === 'Acme').contactCount).toBe(1);
    expect((await a.agent.get(url(a) + '?q=glob')).body.total).toBe(1);
  });

  it('updates a company and blocks renaming to an existing name', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const acme = (await mk(a)).body.company;
    await mk(a, { name: 'Globex' });
    expect(
      (await a.agent.patch(url(a, `/${acme.id}`)).send({ industry: 'Tools' })).body.company
        .industry,
    ).toBe('Tools');
    expect((await a.agent.patch(url(a, `/${acme.id}`)).send({ name: 'globex' })).status).toBe(409);
  });

  it("keeps a company's contacts when it is deleted, just unlinked", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const acme = (await mk(a)).body.company;
    const contact = (
      await a.agent
        .post(`/api/workspaces/${a.workspaceId}/contacts`)
        .send({ firstName: 'Ada', companyId: acme.id })
    ).body.contact;

    expect((await a.agent.delete(url(a, `/${acme.id}`))).status).toBe(204);
    const [row] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(row?.companyId).toBeNull();
  });

  it('isolates tenants and enforces permissions', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const member = await signUp(app);
    await addMember(a.workspaceId, member.userId, 'member');
    const acme = (await mk(a)).body.company;

    expect((await b.agent.get(url(a))).status).toBe(404);
    expect(
      (await b.agent.get(`/api/workspaces/${b.workspaceId}/companies/${acme.id}`)).status,
    ).toBe(404);
    expect((await member.agent.post(url(a)).send({ name: 'FromMember' })).status).toBe(201);
    expect((await member.agent.delete(url(a, `/${acme.id}`))).status).toBe(403);
  });
});
