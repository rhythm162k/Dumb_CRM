import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '@crm/shared';
import { auditLogs } from '../src/db/schema';
import { buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const base = (w: Who) => `/api/workspaces/${w.workspaceId}`;
const rowsOf = (text: string) => parseCsv(text).records.map((r) => r.cells);

async function post(w: Who, path: string, body: Record<string, unknown>) {
  const res = await w.agent.post(`${base(w)}${path}`).send(body);
  expect(res.status).toBe(201);
  return res.body;
}

describe('contacts export', () => {
  it('returns a CSV download with every contact, its company and tags', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const { company } = await post(a, '/companies', { name: 'Acme' });
    await post(a, '/contacts', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      companyId: company.id,
      tags: ['vip', 'lead'],
      notes: 'Likes "maths", and cats',
    });
    await post(a, '/contacts', { firstName: 'Bob' });

    const res = await a.agent.get(`${base(a)}/contacts/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="dumb-contacts-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const rows = rowsOf(res.text);
    expect(rows[0]).toEqual([
      'First name',
      'Last name',
      'Email',
      'Phone',
      'Job title',
      'Company',
      'Tags',
      'Notes',
      'Created',
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.slice(0, 8)).toEqual([
      'Ada',
      'Lovelace',
      'ada@example.com',
      '',
      '',
      'Acme',
      'vip; lead',
      'Likes "maths", and cats',
    ]);
    expect(rows[2]?.slice(0, 2)).toEqual(['Bob', '']);
  });

  it('defuses spreadsheet formulas in exported text', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await post(a, '/contacts', {
      firstName: '=HYPERLINK("http://evil.example")',
      phone: '+8801700000000',
    });

    const res = await a.agent.get(`${base(a)}/contacts/export.csv`);
    const row = rowsOf(res.text)[1];
    expect(row?.[0]).toBe(`'=HYPERLINK("http://evil.example")`);
    expect(row?.[3]).toBe("'+8801700000000");
  });

  it("only contains the caller's workspace", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    await post(a, '/contacts', { firstName: 'Mine' });
    await post(b, '/contacts', { firstName: 'Theirs' });

    const res = await a.agent.get(`${base(a)}/contacts/export.csv`);
    expect(res.text).toContain('Mine');
    expect(res.text).not.toContain('Theirs');
    expect((await a.agent.get(`${base(b)}/contacts/export.csv`)).status).toBe(404);
  });

  it('needs a session and records an audit entry with the row count only', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await post(a, '/contacts', { firstName: 'Ada', email: 'ada@example.com' });
    expect((await request(app).get(`${base(a)}/contacts/export.csv`)).status).toBe(401);

    await a.agent.get(`${base(a)}/contacts/export.csv`);
    const logs = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.workspaceId, a.workspaceId), eq(auditLogs.action, 'contact.exported')),
      );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.metadata).toEqual({ rows: 1 });
  });
});

describe('companies and deals export', () => {
  it('exports companies with their contact count', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const { company } = await post(a, '/companies', {
      name: 'Acme',
      website: 'acme.com',
      industry: 'Tools',
    });
    await post(a, '/contacts', { firstName: 'Ada', companyId: company.id });
    await post(a, '/companies', { name: '=1+1' });

    const res = await a.agent.get(`${base(a)}/companies/export.csv`);
    expect(res.status).toBe(200);
    const rows = rowsOf(res.text);
    expect(rows[0]).toEqual(['Name', 'Website', 'Industry', 'Notes', 'Contacts', 'Created']);
    expect(rows.map((r) => r[0])).toEqual(['Name', "'=1+1", 'Acme']);
    expect(rows[2]?.slice(0, 5)).toEqual(['Acme', 'https://acme.com', 'Tools', '', '1']);
  });

  it('exports deals with plain numbers, stage and linked names', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const { company } = await post(a, '/companies', { name: 'Acme' });
    const { contact } = await post(a, '/contacts', { firstName: 'Ada', lastName: 'Lovelace' });
    await post(a, '/deals', {
      title: 'Big deal',
      value: 1234.5,
      currency: 'eur',
      stage: 'proposal',
      companyId: company.id,
      contactId: contact.id,
      expectedCloseDate: '2026-12-31',
    });

    const res = await a.agent.get(`${base(a)}/deals/export.csv`);
    expect(res.status).toBe(200);
    const rows = rowsOf(res.text);
    expect(rows[0]).toEqual([
      'Title',
      'Value',
      'Currency',
      'Stage',
      'Company',
      'Contact',
      'Expected close',
      'Created',
    ]);
    expect(rows[1]?.slice(0, 7)).toEqual([
      'Big deal',
      '1234.5',
      'EUR',
      'proposal',
      'Acme',
      'Ada Lovelace',
      '2026-12-31',
    ]);
  });

  it('keeps other workspaces out and requires a session', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    await post(b, '/deals', { title: 'Secret deal' });
    await post(b, '/companies', { name: 'Secret Co' });

    expect((await a.agent.get(`${base(a)}/deals/export.csv`)).text).not.toContain('Secret');
    expect((await a.agent.get(`${base(a)}/companies/export.csv`)).text).not.toContain('Secret');
    expect((await request(app).get(`${base(a)}/deals/export.csv`)).status).toBe(401);
    expect((await request(app).get(`${base(a)}/companies/export.csv`)).status).toBe(401);
  });
});
