import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs } from '../src/db/schema';
import { buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Who = Awaited<ReturnType<typeof signUp>>;
const url = (w: Who, path: string) => `/api/workspaces/${w.workspaceId}/${path}`;
const pick = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, o[k]]));

// A PATCH must change exactly the fields it sends. Each step sends one change, then checks that
// EVERY editable field still has the value it should have (this is what a zod 4 upgrade with
// defaults/transforms inside `.partial()` would break: tags reset to [], text fields set to null).
type Step = { send: Record<string, unknown>; change: Record<string, unknown> };

async function runSteps(
  w: Who,
  endpoint: 'contacts' | 'companies' | 'deals',
  key: 'contact' | 'company' | 'deal',
  id: string,
  initial: Record<string, unknown>,
  fields: readonly string[],
  steps: Step[],
) {
  let expected = pick(initial, fields);
  for (const { send, change } of steps) {
    const res = await w.agent.patch(url(w, `${endpoint}/${id}`)).send(send);
    expect(res.status, JSON.stringify(send)).toBe(200);
    expected = { ...expected, ...change };
    expect(pick(res.body[key], fields), JSON.stringify(send)).toEqual(expected);
  }
  // and what is stored is what was returned
  const stored = await w.agent.get(url(w, `${endpoint}/${id}`));
  expect(pick(stored.body[key], fields)).toEqual(expected);
}

describe('PATCH only changes the fields it sends', () => {
  it('contacts', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const company = (await a.agent.post(url(a, 'companies')).send({ name: 'Acme' })).body.company;
    const created = await a.agent.post(url(a, 'contacts')).send({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+44 20 7946 0000',
      jobTitle: 'Analyst',
      companyId: company.id,
      tags: ['vip', 'lead'],
      notes: 'First programmer',
    });
    expect(created.status).toBe(201);
    const fields = [
      'firstName',
      'lastName',
      'email',
      'phone',
      'jobTitle',
      'companyId',
      'tags',
      'notes',
    ];
    expect(pick(created.body.contact, fields)).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+44 20 7946 0000',
      jobTitle: 'Analyst',
      companyId: company.id,
      tags: ['vip', 'lead'],
      notes: 'First programmer',
    });

    await runSteps(
      a,
      'contacts',
      'contact',
      created.body.contact.id,
      created.body.contact,
      fields,
      [
        { send: { firstName: 'Augusta' }, change: { firstName: 'Augusta' } },
        { send: { lastName: 'King' }, change: { lastName: 'King' } },
        { send: { email: ' Augusta@Example.com ' }, change: { email: 'augusta@example.com' } },
        { send: { phone: '+44 20 7946 0001' }, change: { phone: '+44 20 7946 0001' } },
        { send: { jobTitle: 'Countess' }, change: { jobTitle: 'Countess' } },
        { send: { tags: ['Math', 'math'] }, change: { tags: ['math'] } },
        { send: { notes: 'Notes' }, change: { notes: 'Notes' } },
        // clearing is explicit: '' and null empty a field, a missing key never does
        { send: { lastName: '' }, change: { lastName: null } },
        { send: { phone: null }, change: { phone: null } },
        { send: { tags: [] }, change: { tags: [] } },
        { send: { companyId: null }, change: { companyId: null } },
        { send: { firstName: 'Ada' }, change: { firstName: 'Ada' } },
      ],
    );
  });

  it('companies', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const created = await a.agent
      .post(url(a, 'companies'))
      .send({ name: 'Acme', website: 'acme.com', industry: 'Anvils', notes: 'Notes' });
    expect(created.status).toBe(201);
    const fields = ['name', 'website', 'industry', 'notes'];
    expect(pick(created.body.company, fields)).toEqual({
      name: 'Acme',
      website: 'https://acme.com',
      industry: 'Anvils',
      notes: 'Notes',
    });

    await runSteps(
      a,
      'companies',
      'company',
      created.body.company.id,
      created.body.company,
      fields,
      [
        { send: { industry: 'Tools' }, change: { industry: 'Tools' } },
        { send: { notes: '' }, change: { notes: null } },
        { send: { website: 'https://acme.org' }, change: { website: 'https://acme.org' } },
        { send: { name: 'Acme Inc' }, change: { name: 'Acme Inc' } },
        { send: { website: null }, change: { website: null } },
        { send: { industry: 'Anvils' }, change: { industry: 'Anvils' } },
      ],
    );
  });

  it('deals', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const company = (await a.agent.post(url(a, 'companies')).send({ name: 'Acme' })).body.company;
    const contact = (await a.agent.post(url(a, 'contacts')).send({ firstName: 'Ada' })).body
      .contact;
    // a card above, so the deal under test sits at position 1 (a reset to 0 would show)
    await a.agent.post(url(a, 'deals')).send({ title: 'Filler', stage: 'proposal' });
    const created = await a.agent.post(url(a, 'deals')).send({
      title: 'Big deal',
      value: 1200.5,
      currency: 'EUR',
      stage: 'proposal',
      contactId: contact.id,
      companyId: company.id,
      expectedCloseDate: '2026-06-30',
    });
    expect(created.status).toBe(201);
    const fields = [
      'title',
      'value',
      'currency',
      'stage',
      'position',
      'contactId',
      'companyId',
      'expectedCloseDate',
    ];
    expect(pick(created.body.deal, fields)).toEqual({
      title: 'Big deal',
      value: 1200.5,
      currency: 'EUR',
      stage: 'proposal',
      position: 1,
      contactId: contact.id,
      companyId: company.id,
      expectedCloseDate: '2026-06-30',
    });

    await runSteps(a, 'deals', 'deal', created.body.deal.id, created.body.deal, fields, [
      { send: { title: 'Bigger deal' }, change: { title: 'Bigger deal' } },
      { send: { value: 99 }, change: { value: 99 } },
      { send: { currency: 'gbp' }, change: { currency: 'GBP' } },
      { send: { expectedCloseDate: '2026-12-31' }, change: { expectedCloseDate: '2026-12-31' } },
      { send: { contactId: null }, change: { contactId: null } },
      { send: { companyId: null }, change: { companyId: null } },
      { send: { expectedCloseDate: null }, change: { expectedCloseDate: null } },
      { send: { value: 0 }, change: { value: 0 } },
    ]);
  });

  it('nothing sent (or only unknown fields) is "nothing to update", not a silent reset', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = (
      await a.agent.post(url(a, 'contacts')).send({ firstName: 'Ada', tags: ['x'], notes: 'keep' })
    ).body.contact;
    const company = (
      await a.agent.post(url(a, 'companies')).send({ name: 'Acme', industry: 'Anvils' })
    ).body.company;
    const deal = (
      await a.agent.post(url(a, 'deals')).send({ title: 'D', value: 5, currency: 'EUR' })
    ).body.deal;

    for (const [path, body] of [
      [`contacts/${contact.id}`, {}],
      [`contacts/${contact.id}`, { unknown: 1 }],
      [`companies/${company.id}`, { unknown: 1 }],
      [`deals/${deal.id}`, { unknown: 1 }],
      [`deals/${deal.id}`, { stage: 'won' }], // stage only moves through POST /:id/move
    ] as const) {
      const res = await a.agent.patch(url(a, path)).send(body);
      expect(res.status, path).toBe(400);
      expect(res.body.error.code).toBe('empty_update');
    }

    expect((await a.agent.get(url(a, `contacts/${contact.id}`))).body.contact).toMatchObject({
      tags: ['x'],
      notes: 'keep',
    });
    expect((await a.agent.get(url(a, `companies/${company.id}`))).body.company).toMatchObject({
      industry: 'Anvils',
    });
    expect((await a.agent.get(url(a, `deals/${deal.id}`))).body.deal).toMatchObject({
      value: 5,
      currency: 'EUR',
      stage: 'lead',
    });
  });

  it('the audit entry lists only the fields that were sent', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const contact = (await a.agent.post(url(a, 'contacts')).send({ firstName: 'Ada', tags: ['x'] }))
      .body.contact;
    await a.agent.patch(url(a, `contacts/${contact.id}`)).send({ jobTitle: 'Engineer' });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'contact.updated'));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.metadata).toEqual({ fields: ['jobTitle'] });
  });
});
