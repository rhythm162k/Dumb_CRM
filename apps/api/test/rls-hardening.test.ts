import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, closeDb, db, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

const TABLES = ['users', 'workspaces', 'workspace_members', 'refresh_tokens', 'email_tokens'];
const quoted = TABLES.map((t) => `"${t}"`).join(', ');
class Rollback extends Error {}

describe('tables that are not tenant data', () => {
  it('have row-level security switched on', async () => {
    const result = await db.execute(
      sql.raw(
        `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in (${TABLES.map((t) => `'${t}'`).join(', ')})`,
      ),
    );
    const rows = result.rows as { relname: string; relrowsecurity: boolean }[];
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('show nothing to a role that only has table grants (what Supabase anon/authenticated are)', async () => {
    const { app } = buildApp();
    await signUp(app);
    const seen: Record<string, number> = {};

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`create role rls_probe nologin`);
        await tx.execute(sql`grant usage on schema public to rls_probe`);
        await tx.execute(sql.raw(`grant select on ${quoted} to rls_probe`));
        await tx.execute(sql`set local role rls_probe`);
        for (const table of TABLES) {
          const r = await tx.execute(sql.raw(`select count(*)::int as n from "${table}"`));
          seen[table] = (r.rows[0] as { n: number }).n;
        }
        throw new Rollback(); // roles are rolled back with the transaction
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen).toEqual({
      users: 0,
      workspaces: 0,
      workspace_members: 0,
      refresh_tokens: 0,
      email_tokens: 0,
    });
  });

  it('still let the tenant role read display names (id and name only)', async () => {
    const { app } = buildApp();
    const a = await signUp(app, { name: 'Sam Seller' });
    let names: { id: string; name: string }[] = [];

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role kin_app`);
        await tx.execute(sql`select set_config('app.workspace_id', ${a.workspaceId}, true)`);
        names = (await tx.execute(sql`select id, name from users`)).rows as typeof names;
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(names.map((n) => n.name)).toContain('Sam Seller');
  });

  it('the app still works as before (sign in, list workspaces, create a contact)', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    expect((await a.agent.get('/api/auth/me')).status).toBe(200);
    expect((await a.agent.get('/api/workspaces')).body.workspaces).toHaveLength(1);
    const created = await a.agent
      .post(`/api/workspaces/${a.workspaceId}/contacts`)
      .send({ firstName: 'Ada' });
    expect(created.status).toBe(201);
    expect(
      (await a.agent.get(`/api/workspaces/${a.workspaceId}/audit`)).body.items[0].actorName,
    ).toBe('Test User');
  });
});
