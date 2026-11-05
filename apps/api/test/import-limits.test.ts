import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_MAX_ROWS } from '@crm/shared';
import { buildApp, closeDb, resetDb, signUp } from './helpers';

beforeEach(resetDb);
afterAll(closeDb);

describe('import size limit', () => {
  it('rejects too many rows with 400 before validating them one by one', async () => {
    const { app } = buildApp();
    const a = await signUp(app);
    const url = `/api/workspaces/${a.workspaceId}/contacts/import`;

    // junk elements: without the early check, every one would add a validation issue
    const junk = await a.agent
      .post(url)
      .send({ rows: Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => 1) });
    expect(junk.status).toBe(400);
    expect(junk.body.error.message).toContain(String(IMPORT_MAX_ROWS));

    const valid = await a.agent
      .post(url)
      .send({
        rows: Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => ({ firstName: `P${i}` })),
      });
    expect(valid.status).toBe(400);

    const atLimit = await a.agent
      .post(url)
      .send({
        rows: Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => ({ firstName: `P${i}` })),
        dryRun: true,
      });
    expect(atLimit.status).toBe(200);
    expect(atLimit.body.created).toBe(IMPORT_MAX_ROWS);
  });
});
