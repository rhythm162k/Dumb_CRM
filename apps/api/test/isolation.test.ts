import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, buildApp, closeDb, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const base = (w: Who) => `/api/workspaces/${w.workspaceId}`;
const PAST = '2020-01-01T09:00:00.000Z';

interface Seed {
  company: { id: string };
  contact: { id: string };
  deal: { id: string };
  activity: { id: string };
}

/** One record of every kind, all named after `tag` so leaks are easy to spot. */
async function seed(w: Who, tag: string, dealValue: number): Promise<Seed> {
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await w.agent.post(`${base(w)}${path}`).send(body);
    expect(res.status, path).toBe(201);
    return res.body;
  };
  const { company } = await post('/companies', { name: `Company-${tag}` });
  const { contact } = await post('/contacts', {
    firstName: `Person-${tag}`,
    email: `person-${tag.toLowerCase()}@example.com`,
    companyId: company.id,
  });
  const { deal } = await post('/deals', {
    title: `Deal-${tag}`,
    value: dealValue,
    currency: 'USD',
    contactId: contact.id,
    companyId: company.id,
  });
  const { activity } = await post('/activities', {
    type: 'task',
    content: `Task-${tag}`,
    dueAt: PAST,
    contactId: contact.id,
    dealId: deal.id,
  });
  return { company, contact, deal, activity };
}

async function twoWorkspaces() {
  const { app } = buildApp();
  const a = await signUp(app);
  const b = await signUp(app);
  const sa = await seed(a, 'A', 1111);
  const sb = await seed(b, 'B', 222);
  return { app, a, b, sa, sb };
}

type Call = [method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: Record<string, unknown>];

/** Every route of every tenant router, addressed with one workspace's records. */
function allCalls(s: Seed): Call[] {
  return [
    ['get', '/companies'],
    ['get', '/companies/export.csv'],
    ['post', '/companies', { name: 'New co' }],
    ['get', `/companies/${s.company.id}`],
    ['patch', `/companies/${s.company.id}`, { name: 'Hacked' }],
    ['delete', `/companies/${s.company.id}`],
    ['get', '/contacts'],
    ['get', '/contacts/export.csv'],
    ['post', '/contacts', { firstName: 'New' }],
    ['post', '/contacts/import', { rows: [{ firstName: 'Imported' }], duplicates: 'skip', dryRun: false }],
    ['get', `/contacts/${s.contact.id}`],
    ['patch', `/contacts/${s.contact.id}`, { firstName: 'Hacked' }],
    ['delete', `/contacts/${s.contact.id}`],
    ['get', '/deals'],
    ['get', '/deals/export.csv'],
    ['post', '/deals', { title: 'New deal' }],
    ['get', `/deals/${s.deal.id}`],
    ['patch', `/deals/${s.deal.id}`, { title: 'Hacked' }],
    ['post', `/deals/${s.deal.id}/move`, { stage: 'won', position: 0 }],
    ['delete', `/deals/${s.deal.id}`],
    ['get', '/activities'],
    ['post', '/activities', { type: 'note', content: 'New', contactId: s.contact.id }],
    ['patch', `/activities/${s.activity.id}`, { content: 'Hacked' }],
    ['delete', `/activities/${s.activity.id}`],
    ['get', '/dashboard'],
    ['get', '/audit'],
  ];
}

/** Everything of workspace A still reads back exactly as seeded. */
async function expectUntouched(a: Who, sa: Seed) {
  const get = async (path: string) => {
    const res = await a.agent.get(`${base(a)}${path}`);
    expect(res.status, path).toBe(200);
    return res.body;
  };
  expect((await get(`/companies/${sa.company.id}`)).company.name).toBe('Company-A');
  expect((await get(`/contacts/${sa.contact.id}`)).contact.firstName).toBe('Person-A');
  expect((await get(`/deals/${sa.deal.id}`)).deal.title).toBe('Deal-A');
  expect((await get(`/deals/${sa.deal.id}`)).deal.stage).toBe('lead');
  const acts = (await get('/activities')).items as { id: string; content: string }[];
  expect(acts.find((x) => x.id === sa.activity.id)?.content).toBe('Task-A');
  expect((await get('/companies')).total).toBe(1);
  expect((await get('/contacts')).total).toBe(1);
  expect((await get('/deals')).items).toHaveLength(1);
}

describe('tenant isolation: every router', () => {
  it('needs a sign-in for every endpoint (401)', async () => {
    const { app, a, sa } = await twoWorkspaces();
    for (const [method, path, body] of allCalls(sa)) {
      const client = request(app);
      const res = await client[method](`${base(a)}${path}`).send(body);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("hides another workspace from a non-member on every endpoint (404)", async () => {
    const { b, a, sa } = await twoWorkspaces();
    for (const [method, path, body] of allCalls(sa)) {
      const res = await b.agent[method](`${base(a)}${path}`).send(body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    await expectUntouched(a, sa);
  });

  it("answers 404 for another workspace's ids inside your own workspace, and changes nothing", async () => {
    const { b, a, sa } = await twoWorkspaces();
    const attempts: Call[] = [
      ['get', `/companies/${sa.company.id}`],
      ['patch', `/companies/${sa.company.id}`, { name: 'Hacked' }],
      ['delete', `/companies/${sa.company.id}`],
      ['get', `/contacts/${sa.contact.id}`],
      ['patch', `/contacts/${sa.contact.id}`, { firstName: 'Hacked' }],
      ['delete', `/contacts/${sa.contact.id}`],
      ['get', `/deals/${sa.deal.id}`],
      ['patch', `/deals/${sa.deal.id}`, { title: 'Hacked' }],
      ['post', `/deals/${sa.deal.id}/move`, { stage: 'won', position: 0 }],
      ['delete', `/deals/${sa.deal.id}`],
      ['patch', `/activities/${sa.activity.id}`, { content: 'Hacked' }],
      ['patch', `/activities/${sa.activity.id}`, { completed: true }],
      ['delete', `/activities/${sa.activity.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await b.agent[method](`${base(b)}${path}`).send(body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    await expectUntouched(a, sa);
  });

  it("refuses to link records to another workspace's company, contact or deal (400)", async () => {
    const { b, sb, sa } = await twoWorkspaces();
    const refused = async (method: 'post' | 'patch', path: string, body: Record<string, unknown>, code: string) => {
      const res = await b.agent[method](`${base(b)}${path}`).send(body);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.body.error.code, `${method} ${path}`).toBe(code);
    };
    await refused('post', '/contacts', { firstName: 'X', companyId: sa.company.id }, 'invalid_company');
    await refused('patch', `/contacts/${sb.contact.id}`, { companyId: sa.company.id }, 'invalid_company');
    await refused('post', '/deals', { title: 'X', contactId: sa.contact.id }, 'invalid_contact');
    await refused('post', '/deals', { title: 'X', companyId: sa.company.id }, 'invalid_company');
    await refused('patch', `/deals/${sb.deal.id}`, { contactId: sa.contact.id }, 'invalid_contact');
    await refused('post', '/activities', { type: 'note', content: 'X', contactId: sa.contact.id }, 'invalid_contact');
    await refused('post', '/activities', { type: 'note', content: 'X', dealId: sa.deal.id }, 'invalid_deal');
  });

  it("never returns another workspace's data from lists, exports, dashboard or audit", async () => {
    const { b, a, sa } = await twoWorkspaces();
    const bodies: string[] = [];
    for (const path of ['/companies', '/contacts', '/deals', '/activities']) {
      const res = await b.agent.get(`${base(b)}${path}`);
      expect(res.status, path).toBe(200);
      bodies.push(JSON.stringify(res.body));
    }
    for (const path of ['/companies/export.csv', '/contacts/export.csv', '/deals/export.csv']) {
      const res = await b.agent.get(`${base(b)}${path}`);
      expect(res.status, path).toBe(200);
      bodies.push(res.text);
    }
    const dashboard = await b.agent.get(`${base(b)}/dashboard`);
    expect(dashboard.body.openDeals.totals).toEqual([{ currency: 'USD', value: 222 }]);
    expect(dashboard.body.overdueTasks.count).toBe(1);
    bodies.push(JSON.stringify(dashboard.body));
    const audit = await b.agent.get(`${base(b)}/audit`);
    expect(audit.status).toBe(200);
    bodies.push(JSON.stringify(audit.body));

    const everything = bodies.join('\n');
    expect(everything).not.toMatch(/-A\b|Company-A|Person-A|Deal-A|Task-A/);
    for (const id of [sa.company.id, sa.contact.id, sa.deal.id, sa.activity.id, a.workspaceId, a.userId]) {
      expect(everything).not.toContain(id);
    }
  });

  it("does not let an import touch another workspace's contacts or companies", async () => {
    const { b, a, sa } = await twoWorkspaces();
    const res = await b.agent.post(`${base(b)}/contacts/import`).send({
      duplicates: 'update',
      dryRun: false,
      // same email and company name as workspace A's records
      rows: [{ firstName: 'Overwritten', email: 'person-a@example.com', company: 'Company-A' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, updated: 0, skipped: 0, companiesCreated: 1 });
    await expectUntouched(a, sa);
    expect((await b.agent.get(`${base(b)}/companies`)).body.total).toBe(2);
  });

  it('keeps members from deleting on any router (403) and leaves the data alone', async () => {
    const { app, a, sa } = await twoWorkspaces();
    const member = await signUp(app);
    await addMember(a.workspaceId, member.userId, 'member');
    for (const path of [
      `/companies/${sa.company.id}`,
      `/contacts/${sa.contact.id}`,
      `/deals/${sa.deal.id}`,
    ]) {
      const res = await member.agent.delete(`${base(a)}${path}`);
      expect(res.status, path).toBe(403);
    }
    await expectUntouched(a, sa);
  });
});
