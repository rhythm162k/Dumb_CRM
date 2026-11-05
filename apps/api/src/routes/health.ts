import { Router } from 'express';
import type { HealthResponse } from '@crm/shared';

export function healthRouter(checkDb: () => Promise<boolean>) {
  const router = Router();
  router.get('/', async (_req, res) => {
    let dbUp = false;
    try {
      dbUp = await checkDb();
    } catch {
      dbUp = false;
    }
    const body: HealthResponse = { status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down' };
    res.status(dbUp ? 200 : 503).json(body);
  });
  return router;
}
