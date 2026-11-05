import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { Config } from './config';
import type { Db } from './db/client';
import { authenticate, requireMember } from './middleware/auth';
import { originCheck } from './middleware/csrf';
import { errorHandler, notFound } from './middleware/errors';
import { authRouter } from './routes/auth';
import { companiesRouter } from './routes/companies';
import { activitiesRouter } from './routes/activities';
import { auditRouter } from './routes/audit';
import { contactsRouter } from './routes/contacts';
import { dashboardRouter } from './routes/dashboard';
import { healthRouter } from './routes/health';
import { workspacesRouter } from './routes/workspaces';
import { dealsRouter } from './routes/deals';
import { createAuthService } from './services/auth';
import type { EmailService } from './services/email';
import type { GoogleClient } from './services/google';
import { scopedDb, tenantScope } from './lib/tenant';

export interface AppDeps {
  config: Config;
  db: Db;
  email: EmailService;
  google?: GoogleClient;
  checkDb: () => Promise<boolean>;
}

export function createApp({ config, db, email, google, checkDb }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY); // number of reverse proxies in front of the API

  app.use(helmet());
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));

  // health first: polled by the splash screen, must not be rate limited
  app.use(['/health', '/api/health'], healthRouter(checkDb));

  if (config.DEBUG_CLIENT_IP) {
    app.use('/api', (req, _res, next) => {
      console.log(
        'client-ip',
        JSON.stringify({
          ip: req.ip,
          ips: req.ips,
          forwardedFor: req.headers['x-forwarded-for'] ?? null,
        }),
      );
      next();
    });
  }

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );
  // the contact import posts up to 1000 rows; this parser runs first and the default one then skips it
  app.use('/api/workspaces/:workspaceId/contacts/import', express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', originCheck(config));

  const auth = createAuthService({ db, config, email });
  app.use('/api/auth', authRouter({ config, db, auth, google }));

  // tenant-scoped CRM data: sign in, be a member of :workspaceId, then run in a transaction that
  // Postgres row-level security restricts to that workspace (see lib/tenant.ts)
  const scoped = [authenticate(config), requireMember(db), tenantScope(db)];
  const tenantDb = scopedDb(db);
  app.use('/api/workspaces/:workspaceId/companies', ...scoped, companiesRouter(tenantDb));
  app.use('/api/workspaces/:workspaceId/contacts', ...scoped, contactsRouter(tenantDb));
  app.use('/api/workspaces/:workspaceId/deals', ...scoped, dealsRouter(tenantDb));
  app.use('/api/workspaces/:workspaceId/activities', ...scoped, activitiesRouter(tenantDb));
  app.use('/api/workspaces/:workspaceId/dashboard', ...scoped, dashboardRouter(tenantDb));
  app.use('/api/workspaces/:workspaceId/audit', ...scoped, auditRouter(tenantDb));
  app.use('/api/workspaces', workspacesRouter({ config, db }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
