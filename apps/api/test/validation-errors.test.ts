import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, closeDb, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

// The API turns a ZodError into { error: { code, message, details } }. The web app shows `message`,
// and `details` is the flattened form ({ formErrors, fieldErrors }). These tests pin that shape
// so a zod upgrade cannot change it silently.
describe('validation error responses', () => {
  it('a body error: 400, first message, flattened details', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await a.agent
      .post(`/api/workspaces/${a.workspaceId}/contacts`)
      .send({ firstName: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.message).toBe('Enter a first name');
    expect(res.body.error.details.formErrors).toEqual([]);
    expect(res.body.error.details.fieldErrors.firstName).toEqual(['Enter a first name']);
  });

  it('a query error names the field', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await a.agent.get(`/api/workspaces/${a.workspaceId}/contacts?pageSize=1000`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.fieldErrors.pageSize).toHaveLength(1);
  });

  it('a malformed id in the path is a 400', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const res = await a.agent.get(`/api/workspaces/${a.workspaceId}/contacts/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('an update with a bad value names the field and changes nothing', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const base = `/api/workspaces/${a.workspaceId}/contacts`;
    const id = (await a.agent.post(base).send({ firstName: 'Ada', lastName: 'Lovelace' })).body
      .contact.id;
    const res = await a.agent.patch(`${base}/${id}`).send({ phone: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fieldErrors.phone).toEqual(['Enter a valid phone number']);
    expect((await a.agent.get(`${base}/${id}`)).body.contact).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: null,
    });
  });
});
