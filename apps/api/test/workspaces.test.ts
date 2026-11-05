import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, buildApp, closeDb, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

describe('workspace access', () => {
  it('requires authentication', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/api/workspaces')).status).toBe(401);
  });

  it('lists only my workspaces and can create a new one', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    await signUp(app);

    const created = await a.agent.post('/api/workspaces').send({ name: 'Second' });
    expect(created.status).toBe(201);
    expect(created.body.workspace.role).toBe('owner');

    const list = await a.agent.get('/api/workspaces');
    expect(list.body.workspaces).toHaveLength(2);
  });

  it('isolates tenants: another workspace looks like it does not exist', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const b = await signUp(app);

    expect((await b.agent.get(`/api/workspaces/${a.workspaceId}`)).status).toBe(404);
    expect((await b.agent.get(`/api/workspaces/${a.workspaceId}/members`)).status).toBe(404);
    expect(
      (
        await b.agent
          .patch(`/api/workspaces/${a.workspaceId}/members/${a.userId}`)
          .send({ role: 'member' })
      ).status,
    ).toBe(404);
    expect((await b.agent.get('/api/workspaces/not-a-uuid')).status).toBe(404);
    // and the owner still sees it
    expect((await a.agent.get(`/api/workspaces/${a.workspaceId}`)).status).toBe(200);
  });
});

describe('roles', () => {
  async function setup() {
    const { app } = buildApp();
    const owner = await signUp(app);
    const admin = await signUp(app);
    const member = await signUp(app);
    const other = await signUp(app);
    await addMember(owner.workspaceId, admin.userId, 'admin');
    await addMember(owner.workspaceId, member.userId, 'member');
    return { app, owner, admin, member, other, ws: owner.workspaceId };
  }

  it('lets any member list members', async () => {
    const { member, ws } = await setup();
    const res = await member.agent.get(`/api/workspaces/${ws}/members`);
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(3);
  });

  it('forbids members from managing roles or removing people', async () => {
    const { member, admin, ws } = await setup();
    expect(
      (
        await member.agent
          .patch(`/api/workspaces/${ws}/members/${admin.userId}`)
          .send({ role: 'member' })
      ).status,
    ).toBe(403);
    expect(
      (await member.agent.delete(`/api/workspaces/${ws}/members/${admin.userId}`)).status,
    ).toBe(403);
  });

  it('lets an admin switch a member to admin, but not grant or touch owner', async () => {
    const { admin, member, owner, ws } = await setup();
    expect(
      (
        await admin.agent
          .patch(`/api/workspaces/${ws}/members/${member.userId}`)
          .send({ role: 'admin' })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.agent
          .patch(`/api/workspaces/${ws}/members/${member.userId}`)
          .send({ role: 'owner' })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.agent
          .patch(`/api/workspaces/${ws}/members/${owner.userId}`)
          .send({ role: 'member' })
      ).status,
    ).toBe(403);
    expect((await admin.agent.delete(`/api/workspaces/${ws}/members/${owner.userId}`)).status).toBe(
      403,
    );
  });

  it('lets an owner promote to owner, and validates the role', async () => {
    const { owner, member, ws } = await setup();
    expect(
      (
        await owner.agent
          .patch(`/api/workspaces/${ws}/members/${member.userId}`)
          .send({ role: 'owner' })
      ).status,
    ).toBe(200);
    expect(
      (
        await owner.agent
          .patch(`/api/workspaces/${ws}/members/${member.userId}`)
          .send({ role: 'superuser' })
      ).status,
    ).toBe(400);
  });

  it('stops users changing or removing themselves', async () => {
    const { owner, ws } = await setup();
    expect(
      (
        await owner.agent
          .patch(`/api/workspaces/${ws}/members/${owner.userId}`)
          .send({ role: 'member' })
      ).status,
    ).toBe(400);
    expect((await owner.agent.delete(`/api/workspaces/${ws}/members/${owner.userId}`)).status).toBe(
      400,
    );
  });

  it('lets an admin remove a member, who then loses access', async () => {
    const { admin, member, ws } = await setup();
    expect(
      (await admin.agent.delete(`/api/workspaces/${ws}/members/${member.userId}`)).status,
    ).toBe(204);
    expect((await member.agent.get(`/api/workspaces/${ws}`)).status).toBe(404);
  });
});
