import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs, companies, contacts } from '../src/db/schema';
import { buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
type Row = Record<string, unknown>;
const url = (w: Who) => `/api/workspaces/${w.workspaceId}/contacts/import`;

const importRows = (w: Who, rows: Row[], extra: Row = {}) =>
  w.agent.post(url(w)).send({ rows, ...extra });
const allContacts = (w: Who) =>
  db.select().from(contacts).where(eq(contacts.workspaceId, w.workspaceId));
const allCompanies = (w: Who) =>
  db.select().from(companies).where(eq(companies.workspaceId, w.workspaceId));

describe('importing contacts', () => {
  it('creates contacts, splits tags and creates each company once (ignoring case)', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await importRows(a, [
      {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'Ada@Example.com',
        company: 'Acme',
        tags: 'vip; lead, new',
      },
      { firstName: 'Bob', company: 'ACME' },
      {
        firstName: 'Cy',
        company: 'Globex',
        phone: '+880 1700 000000',
        jobTitle: 'CTO',
        notes: 'Hi',
      },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: false,
      created: 3,
      updated: 0,
      skipped: 0,
      failed: 0,
      companiesCreated: 2,
      errors: [],
    });

    const rows = await allContacts(a);
    const ada = rows.find((c) => c.firstName === 'Ada');
    expect(ada).toMatchObject({
      email: 'ada@example.com',
      tags: ['vip', 'lead', 'new'],
      createdBy: a.userId,
    });
    expect((await allCompanies(a)).map((c) => c.name).sort()).toEqual(['Acme', 'Globex']);
    const acme = (await allCompanies(a)).find((c) => c.name === 'Acme');
    expect(
      rows
        .filter((c) => c.companyId === acme?.id)
        .map((c) => c.firstName)
        .sort(),
    ).toEqual(['Ada', 'Bob']);
    expect(rows.find((c) => c.firstName === 'Cy')).toMatchObject({
      phone: '+880 1700 000000',
      jobTitle: 'CTO',
      notes: 'Hi',
    });
  });

  it('reuses a company that already exists', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await a.agent.post(`/api/workspaces/${a.workspaceId}/companies`).send({ name: 'Acme' });
    const res = await importRows(a, [{ firstName: 'Ada', company: 'acme' }]);
    expect(res.body).toMatchObject({ created: 1, companiesCreated: 0 });
    expect(await allCompanies(a)).toHaveLength(1);
  });

  it('a dry run reports the same numbers but saves nothing', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const rows = [
      { firstName: 'Ada', email: 'ada@example.com', company: 'Acme' },
      { firstName: 'Bob', email: 'not-an-email' },
    ];
    const dry = await importRows(a, rows, { dryRun: true });
    expect(dry.body).toMatchObject({ dryRun: true, created: 1, failed: 1, companiesCreated: 1 });
    expect(await allContacts(a)).toHaveLength(0);
    expect(await allCompanies(a)).toHaveLength(0);

    const real = await importRows(a, rows);
    expect(real.body).toMatchObject({ dryRun: false, created: 1, failed: 1, companiesCreated: 1 });
    expect(await allContacts(a)).toHaveLength(1);
  });

  it('reports bad rows by position and still imports the good ones', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await importRows(a, [
      { firstName: 'Good' },
      { firstName: 'Bad email', email: 'nope' },
      { lastName: 'No first name' },
      { firstName: 'Bad phone', phone: 'abc' },
      { firstName: 'Fine', email: 'fine@example.com' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, failed: 3 });
    expect(res.body.errors.map((e: { row: number }) => e.row)).toEqual([1, 2, 3]);
    expect(res.body.errors[0].message).toContain('Email');
    expect(res.body.errors[1].message).toContain('First name');
    expect(res.body.errors[2].message).toContain('Phone');
    expect((await allContacts(a)).map((c) => c.firstName).sort()).toEqual(['Fine', 'Good']);
  });
});

describe('duplicates', () => {
  async function seed(a: Who) {
    await a.agent.post(`/api/workspaces/${a.workspaceId}/contacts`).send({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '12345',
      tags: ['vip'],
      notes: 'Keep me',
    });
  }

  it('skips rows whose email already exists, and repeats inside the file', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await seed(a);
    const res = await importRows(a, [
      { firstName: 'Ada again', email: 'ADA@example.com' },
      { firstName: 'Bob', email: 'bob@example.com' },
      { firstName: 'Bob again', email: 'bob@example.com' },
    ]);
    expect(res.body).toMatchObject({ created: 1, updated: 0, skipped: 2 });
    const rows = await allContacts(a);
    expect(rows).toHaveLength(2);
    expect(rows.find((c) => c.email === 'ada@example.com')?.firstName).toBe('Ada');
  });

  it('updates in "update" mode without blanking existing data, and merges tags', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await seed(a);
    const res = await importRows(
      a,
      [
        {
          firstName: 'Augusta',
          email: 'ada@example.com',
          jobTitle: 'Countess',
          company: 'Analytical Co',
          tags: 'math; vip',
        },
      ],
      { duplicates: 'update' },
    );
    expect(res.body).toMatchObject({ created: 0, updated: 1, skipped: 0, companiesCreated: 1 });
    const [ada] = await allContacts(a);
    expect(ada).toMatchObject({
      firstName: 'Augusta',
      lastName: 'Lovelace', // empty cell in the file: kept
      phone: '12345', // kept
      notes: 'Keep me', // kept
      jobTitle: 'Countess',
      tags: ['vip', 'math'],
    });
    expect(ada?.companyId).toBeTruthy();
  });

  it('treats the same email in two rows of one file as one contact in "update" mode', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await importRows(
      a,
      [
        { firstName: 'Bob', email: 'bob@example.com', phone: '555 0101' },
        { firstName: 'Bob', email: 'bob@example.com', jobTitle: 'CEO' },
      ],
      { duplicates: 'update' },
    );
    expect(res.body).toMatchObject({ created: 1, updated: 1 });
    expect(await allContacts(a)).toMatchObject([{ phone: '555 0101', jobTitle: 'CEO' }]);
  });
});

describe('import safety', () => {
  it('rejects an empty file, too many rows and an unknown duplicate mode', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await importRows(a, [])).status).toBe(400);
    const many = Array.from({ length: 1001 }, (_, i) => ({ firstName: `P${i}` }));
    expect((await importRows(a, many)).status).toBe(400);
    expect((await importRows(a, [{ firstName: 'Ada' }], { duplicates: 'overwrite' })).status).toBe(
      400,
    );
    expect(await allContacts(a)).toHaveLength(0);
  });

  it('accepts a full 1000-row file in one request', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      firstName: `Person${i}`,
      email: `p${i}@example.com`,
      notes: 'x'.repeat(300),
    }));
    const res = await importRows(a, rows);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1000);
  }, 30_000);

  it("does not treat another workspace's contacts or companies as matches", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    await b.agent
      .post(`/api/workspaces/${b.workspaceId}/contacts`)
      .send({ firstName: 'Ada', email: 'ada@example.com' });
    await b.agent.post(`/api/workspaces/${b.workspaceId}/companies`).send({ name: 'Acme' });

    const res = await importRows(a, [
      { firstName: 'Ada', email: 'ada@example.com', company: 'Acme' },
    ]);
    expect(res.body).toMatchObject({ created: 1, skipped: 0, companiesCreated: 1 });
    expect(await allContacts(b)).toHaveLength(1);
    expect(await allCompanies(b)).toHaveLength(1);
  });

  it('needs a session and workspace membership', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const outsider = await signUp(app);
    const body = { rows: [{ firstName: 'Ada' }] };
    expect((await request(app).post(url(a)).send(body)).status).toBe(401);
    expect((await outsider.agent.post(url(a)).send(body)).status).toBe(404);
    expect(await allContacts(a)).toHaveLength(0);
  });

  it('audits a real import with counts only, and a dry run not at all', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const rows = [{ firstName: 'Ada', email: 'secret-person@example.com' }];
    await importRows(a, rows, { dryRun: true });
    const action = (name: string) =>
      db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.workspaceId, a.workspaceId), eq(auditLogs.action, name)));
    expect(await action('contact.imported')).toHaveLength(0);

    await importRows(a, rows);
    const logs = await action('contact.imported');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.metadata).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      companiesCreated: 0,
    });
    expect(JSON.stringify(logs[0])).not.toContain('secret-person');
  });
});
