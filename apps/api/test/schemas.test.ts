import { describe, expect, it } from 'vitest';
import {
  IMPORT_MAX_ROWS,
  createActivitySchema,
  createCompanySchema,
  createContactSchema,
  createDealSchema,
  importContactRowSchema,
  importContactsSchema,
  listAuditQuery,
  listContactsQuery,
  updateActivitySchema,
  updateCompanySchema,
  updateContactSchema,
  updateDealSchema,
} from '@crm/shared';

// These are pure schema tests (no database). The most important ones are the "update" tests:
// zod 4 runs defaults and `nullish().transform()` inside `.partial()` fields even when the key is
// missing, so a careless schema would reset or null stored data on every PATCH. `toStrictEqual`
// is used on purpose: it fails if a key is present with null, [] or undefined.

const uuid = '4f0d7c2e-3b1a-4c55-9a77-0e6f2d8b1c10';
const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.error?.issues.map((i) => i.message) ?? [];

describe('update schemas leave missing fields alone', () => {
  it('an empty body stays empty', () => {
    expect(updateContactSchema.parse({})).toStrictEqual({});
    expect(updateCompanySchema.parse({})).toStrictEqual({});
    expect(updateDealSchema.parse({})).toStrictEqual({});
    expect(updateActivitySchema.parse({})).toStrictEqual({});
  });

  it.each([
    ['firstName', { firstName: ' Grace ' }, { firstName: 'Grace' }],
    ['lastName', { lastName: 'Hopper' }, { lastName: 'Hopper' }],
    ['email', { email: ' G@Navy.MIL ' }, { email: 'g@navy.mil' }],
    ['phone', { phone: '+880 1711-000000' }, { phone: '+880 1711-000000' }],
    ['jobTitle', { jobTitle: 'Admiral' }, { jobTitle: 'Admiral' }],
    ['companyId', { companyId: uuid }, { companyId: uuid }],
    ['tags', { tags: ['Navy', 'navy', ' Code '] }, { tags: ['navy', 'code'] }],
    ['notes', { notes: 'Compiler pioneer' }, { notes: 'Compiler pioneer' }],
  ])('contact: sending only %s returns only that field', (_name, input, expected) => {
    expect(updateContactSchema.parse(input)).toStrictEqual(expected);
  });

  it('contact: empty values clear a field, they are not ignored', () => {
    expect(updateContactSchema.parse({ lastName: '  ' })).toStrictEqual({ lastName: null });
    expect(updateContactSchema.parse({ email: '' })).toStrictEqual({ email: null });
    expect(updateContactSchema.parse({ phone: null })).toStrictEqual({ phone: null });
    expect(updateContactSchema.parse({ companyId: null })).toStrictEqual({ companyId: null });
    expect(updateContactSchema.parse({ tags: [] })).toStrictEqual({ tags: [] });
  });

  it('contact: bad values are still rejected', () => {
    expect(updateContactSchema.safeParse({ firstName: '' }).success).toBe(false);
    expect(updateContactSchema.safeParse({ firstName: null }).success).toBe(false);
    expect(updateContactSchema.safeParse({ email: 'nope' }).success).toBe(false);
    expect(updateContactSchema.safeParse({ phone: 'abc' }).success).toBe(false);
    expect(updateContactSchema.safeParse({ companyId: 'not-a-uuid' }).success).toBe(false);
    expect(updateContactSchema.safeParse({ tags: 'vip' }).success).toBe(false);
  });

  it('unknown keys are dropped', () => {
    expect(updateContactSchema.parse({ id: 'x', firstName: 'A' })).toStrictEqual({
      firstName: 'A',
    });
  });

  it('company: only the sent fields come back', () => {
    expect(updateCompanySchema.parse({ industry: 'Tools' })).toStrictEqual({ industry: 'Tools' });
    expect(updateCompanySchema.parse({ website: '' })).toStrictEqual({ website: null });
    expect(updateCompanySchema.parse({ website: 'acme.org' })).toStrictEqual({
      website: 'https://acme.org',
    });
    expect(updateCompanySchema.parse({ notes: ' ' })).toStrictEqual({ notes: null });
    expect(updateCompanySchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ website: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('deal: only the sent fields come back; stage is not editable here', () => {
    expect(updateDealSchema.parse({ title: 'T' })).toStrictEqual({ title: 'T' });
    expect(updateDealSchema.parse({ value: 5 })).toStrictEqual({ value: 5 });
    expect(updateDealSchema.parse({ currency: ' gbp ' })).toStrictEqual({ currency: 'GBP' });
    expect(updateDealSchema.parse({ contactId: null })).toStrictEqual({ contactId: null });
    expect(updateDealSchema.parse({ companyId: uuid })).toStrictEqual({ companyId: uuid });
    expect(updateDealSchema.parse({ expectedCloseDate: null })).toStrictEqual({
      expectedCloseDate: null,
    });
    expect(updateDealSchema.parse({ expectedCloseDate: '2026-06-30' })).toStrictEqual({
      expectedCloseDate: '2026-06-30',
    });
    expect(updateDealSchema.parse({ stage: 'won' })).toStrictEqual({});
    expect(updateDealSchema.safeParse({ value: -1 }).success).toBe(false);
    expect(updateDealSchema.safeParse({ value: 'abc' }).success).toBe(false);
    expect(updateDealSchema.safeParse({ currency: 'EURO' }).success).toBe(false);
    expect(updateDealSchema.safeParse({ expectedCloseDate: 'tomorrow' }).success).toBe(false);
  });

  it('activity: only the sent fields come back', () => {
    expect(updateActivitySchema.parse({ completed: false })).toStrictEqual({ completed: false });
    expect(updateActivitySchema.parse({ dueAt: null })).toStrictEqual({ dueAt: null });
    expect(updateActivitySchema.parse({ content: ' hi ' })).toStrictEqual({ content: 'hi' });
    expect(updateActivitySchema.safeParse({ dueAt: 'yesterday' }).success).toBe(false);
  });
});

describe('create schemas fill in the defaults', () => {
  it('contact', () => {
    expect(createContactSchema.parse({ firstName: ' Ada ' })).toStrictEqual({
      firstName: 'Ada',
      lastName: null,
      email: null,
      phone: null,
      jobTitle: null,
      companyId: null,
      tags: [],
      notes: null,
    });
  });

  it('contact: normalises what is sent', () => {
    expect(
      createContactSchema.parse({
        firstName: 'Ada',
        email: '  Ada@Example.COM ',
        phone: '',
        jobTitle: '  ',
        tags: ['VIP', 'vip', ' Lead '],
        companyId: null,
      }),
    ).toMatchObject({
      email: 'ada@example.com',
      phone: null,
      jobTitle: null,
      tags: ['vip', 'lead'],
      companyId: null,
    });
  });

  it('contact: validation', () => {
    expect(issues(createContactSchema.safeParse({}))).not.toHaveLength(0);
    expect(issues(createContactSchema.safeParse({ firstName: '' }))).toContain(
      'Enter a first name',
    );
    expect(issues(createContactSchema.safeParse({ firstName: 'A', phone: 'abc' }))).toContain(
      'Enter a valid phone number',
    );
    expect(
      createContactSchema.safeParse({
        firstName: 'A',
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });

  it('company', () => {
    expect(createCompanySchema.parse({ name: 'Acme' })).toStrictEqual({
      name: 'Acme',
      website: null,
      industry: null,
      notes: null,
    });
    expect(createCompanySchema.parse({ name: 'Acme', website: 'Acme.com/' }).website).toBe(
      'https://acme.com',
    );
  });

  it('company: only safe websites are accepted', () => {
    for (const website of ['javascript:alert(1)', 'not a url', 'localhost']) {
      expect(issues(createCompanySchema.safeParse({ name: 'Acme', website }))).toContain(
        'Enter a valid website',
      );
    }
  });

  it('deal', () => {
    expect(createDealSchema.parse({ title: 'T' })).toStrictEqual({
      title: 'T',
      value: 0,
      currency: 'USD',
      stage: 'lead',
      contactId: null,
      companyId: null,
      expectedCloseDate: null,
    });
    expect(
      createDealSchema.parse({ title: 'T', value: 10.456, currency: ' eur ', stage: 'won' }),
    ).toMatchObject({
      value: 10.46,
      currency: 'EUR',
      stage: 'won',
    });
  });

  it('activity', () => {
    expect(
      createActivitySchema.parse({ type: 'note', content: ' hi ', contactId: uuid }),
    ).toStrictEqual({
      type: 'note',
      content: 'hi',
      dueAt: null,
      contactId: uuid,
      dealId: null,
    });
    expect(issues(createActivitySchema.safeParse({ type: 'note', content: 'hi' }))).toContain(
      'Link the activity to a contact or a deal',
    );
    expect(
      issues(
        createActivitySchema.safeParse({
          type: 'note',
          content: 'hi',
          contactId: uuid,
          dueAt: '2026-11-05T10:00:00Z',
        }),
      ),
    ).toContain('Only tasks have a due date');
    expect(
      createActivitySchema.safeParse({
        type: 'task',
        content: 'call',
        dealId: uuid,
        dueAt: '2026-11-05T10:00:00+06:00',
      }).success,
    ).toBe(true);
    expect(
      issues(
        createActivitySchema.safeParse({
          type: 'task',
          content: 'call',
          dealId: uuid,
          dueAt: 'yesterday',
        }),
      ),
    ).toContain('Enter a valid date');
  });
});

describe('contact import rows', () => {
  it('fills in defaults for columns that were not mapped', () => {
    expect(importContactRowSchema.parse({ firstName: 'Ada' })).toStrictEqual({
      firstName: 'Ada',
      lastName: null,
      email: null,
      phone: null,
      jobTitle: null,
      notes: null,
      company: null,
      tags: [],
    });
  });

  it('splits tag cells, lowercases and de-duplicates them', () => {
    expect(
      importContactRowSchema.parse({ firstName: 'Ada', tags: 'VIP; lead, vip', company: ' Acme ' }),
    ).toMatchObject({
      tags: ['vip', 'lead'],
      company: 'Acme',
    });
    expect(importContactRowSchema.parse({ firstName: 'Ada', tags: '' }).tags).toStrictEqual([]);
  });

  it('reports the problem field first', () => {
    expect(
      importContactRowSchema.safeParse({ firstName: 'Ada', email: 'nope' }).error?.issues[0]
        ?.path[0],
    ).toBe('email');
    expect(importContactRowSchema.safeParse({ firstName: '' }).error?.issues[0]?.path[0]).toBe(
      'firstName',
    );
    expect(
      importContactRowSchema.safeParse({ firstName: 'Ada', phone: 'abc' }).error?.issues[0]
        ?.path[0],
    ).toBe('phone');
  });

  it('the import body has defaults and a row limit', () => {
    expect(importContactsSchema.parse({ rows: [{ a: 1 }] })).toStrictEqual({
      rows: [{ a: 1 }],
      duplicates: 'skip',
      dryRun: false,
    });
    expect(importContactsSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(importContactsSchema.safeParse({ rows: [1] }).success).toBe(false);
    expect(importContactsSchema.safeParse({ rows: [{}], duplicates: 'merge' }).success).toBe(false);
    const tooMany = importContactsSchema.safeParse({
      rows: Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => ({})),
    });
    expect(issues(tooMany).join(' ')).toContain(String(IMPORT_MAX_ROWS));
  });
});

describe('query schemas', () => {
  it('coerce strings and apply defaults', () => {
    expect(listContactsQuery.parse({})).toMatchObject({ page: 1, pageSize: 25 });
    expect(listContactsQuery.parse({ page: '2', pageSize: '10', tag: ' VIP ' })).toMatchObject({
      page: 2,
      pageSize: 10,
      tag: 'vip',
    });
    expect(listAuditQuery.parse({})).toMatchObject({ page: 1, pageSize: 50 });
  });

  it('reject bad values', () => {
    expect(listContactsQuery.safeParse({ pageSize: '1000' }).success).toBe(false);
    expect(listContactsQuery.safeParse({ page: '0' }).success).toBe(false);
    expect(listContactsQuery.safeParse({ page: 'abc' }).success).toBe(false);
    expect(listContactsQuery.safeParse({ companyId: 'not-a-uuid' }).success).toBe(false);
    expect(listAuditQuery.safeParse({ entityType: 'nope' }).success).toBe(false);
    expect(listAuditQuery.safeParse({ entityType: 'contact', actorId: uuid }).success).toBe(true);
  });

  it('ids: any 8-4-4-4-12 hex string is accepted, as before the upgrade', () => {
    expect(
      listContactsQuery.safeParse({ companyId: '00000000-0000-4000-8000-000000000000' }).success,
    ).toBe(true);
    expect(listContactsQuery.safeParse({ companyId: uuid.toUpperCase() }).success).toBe(true);
  });
});
