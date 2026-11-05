import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { activities, auditLogs, companies, contacts, deals } from '../src/db/schema';
import { openTenantScope, scopedDb, withTenantTx } from '../src/lib/tenant';
import { buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Who = Awaited<ReturnType<typeof signUp>>;

class Undo extends Error {}

/** Runs `fn` the way the API does (restricted role + workspace setting), then always rolls back. */
async function asTenant<T>(workspaceId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out!: T;
  await db
    .transaction(async (tx) => {
      await tx.execute(sql.raw('set local role kin_app'));
      if (workspaceId)
        await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
      out = await fn(tx);
      throw new Undo();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Undo)) throw err;
    });
  return out;
}

/** The Postgres error code, however the driver wraps it. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: unknown) => err,
  );

const base = (w: Who) => `/api/workspaces/${w.workspaceId}`;

async function seed(w: Who, tag: string) {
  const company = (await w.agent.post(`${base(w)}/companies`).send({ name: `Co ${tag}` })).body
    .company as { id: string };
  const contact = (
    await w.agent
      .post(`${base(w)}/contacts`)
      .send({ firstName: `Person ${tag}`, companyId: company.id })
  ).body.contact as { id: string };
  const deal = (
    await w.agent.post(`${base(w)}/deals`).send({ title: `Deal ${tag}`, contactId: contact.id })
  ).body.deal as { id: string };
  await w.agent
    .post(`${base(w)}/activities`)
    .send({ type: 'note', content: `Note ${tag}`, contactId: contact.id });
  return { company, contact, deal };
}

describe('row-level security', () => {
  it('shows a workspace only its own rows in every tenant table', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    await seed(a, 'A');
    await seed(b, 'B');

    const seen = await asTenant(a.workspaceId, async (tx) => ({
      companies: await tx.select({ w: companies.workspaceId }).from(companies),
      contacts: await tx.select({ w: contacts.workspaceId }).from(contacts),
      deals: await tx.select({ w: deals.workspaceId }).from(deals),
      activities: await tx.select({ w: activities.workspaceId }).from(activities),
      audit: await tx.select({ w: auditLogs.workspaceId }).from(auditLogs),
    }));
    for (const [table, rows] of Object.entries(seen)) {
      expect(rows.length, table).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.w === a.workspaceId),
        table,
      ).toBe(true);
    }
  });

  it('shows nothing when no workspace is set (fails closed)', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await seed(a, 'A');
    const seen = await asTenant(null, async (tx) => [
      await tx.select().from(companies),
      await tx.select().from(contacts),
      await tx.select().from(deals),
      await tx.select().from(activities),
      await tx.select().from(auditLogs),
    ]);
    expect(seen.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it('rejects writing a row into another workspace', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const err = await failure(
      asTenant(a.workspaceId, (tx) =>
        tx.insert(companies).values({ workspaceId: b.workspaceId, name: 'Smuggled' }),
      ),
    );
    expect(pgCode(err)).toBe('42501');
  });

  it("cannot update or delete another workspace's rows, even by id", async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    const theirs = await seed(b, 'B');
    const result = await asTenant(a.workspaceId, async (tx) => ({
      updated: await tx
        .update(companies)
        .set({ name: 'Hacked' })
        .where(eq(companies.id, theirs.company.id))
        .returning({ id: companies.id }),
      deleted: await tx
        .delete(deals)
        .where(eq(deals.id, theirs.deal.id))
        .returning({ id: deals.id }),
    }));
    expect(result.updated).toEqual([]);
    expect(result.deleted).toEqual([]);
    const [still] = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, theirs.company.id));
    expect(still?.name).toBe('Co B');
  });

  it('keeps the audit log append-only for the application role', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await seed(a, 'A');
    const del = await failure(asTenant(a.workspaceId, (tx) => tx.delete(auditLogs)));
    expect(pgCode(del)).toBe('42501');
    const upd = await failure(
      asTenant(a.workspaceId, (tx) => tx.update(auditLogs).set({ action: 'x' })),
    );
    expect(pgCode(upd)).toBe('42501');
  });

  it('only lets the role read user names, never emails or password hashes', async () => {
    const { app } = buildApp();
    const a = await signUp(app, { name: 'Olive Owner' });
    const names = await asTenant(a.workspaceId, (tx) =>
      tx.execute(sql`select id, name from users`),
    );
    expect(names.rows.length).toBeGreaterThan(0);
    for (const column of ['password_hash', 'email']) {
      const err = await failure(
        asTenant(a.workspaceId, (tx) => tx.execute(sql.raw(`select ${column} from users`))),
      );
      expect(pgCode(err), column).toBe('42501');
    }
  });

  it('refuses scopedDb calls outside a request scope, and uses the scope inside one', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);
    await seed(a, 'A');
    await seed(b, 'B');

    const tenantDb = scopedDb(db);
    expect(() => tenantDb.select()).toThrow(/outside a workspace scope/);

    const { tx, finish } = await openTenantScope(db, a.workspaceId);
    try {
      const rows = await withTenantTx(tx, () =>
        tenantDb.select({ w: contacts.workspaceId }).from(contacts),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.w === a.workspaceId)).toBe(true);
    } finally {
      await finish(false);
    }
  });

  it('commits before the response is sent and rolls back failed requests', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const ok = await a.agent.post(`${base(a)}/companies`).send({ name: 'Visible at once' });
    expect(ok.status).toBe(201);
    // read through a different connection, right after the response
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, ok.body.company.id));
    expect(rows).toHaveLength(1);

    const before = (await db.select({ id: auditLogs.id }).from(auditLogs)).length;
    const dup = await a.agent.post(`${base(a)}/companies`).send({ name: 'Visible at once' });
    expect(dup.status).toBe(409);
    const after = (await db.select({ id: auditLogs.id }).from(auditLogs)).length;
    expect(after).toBe(before);
  });
});
