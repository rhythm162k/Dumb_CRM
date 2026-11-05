import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createEmailService } from './services/email';
import { createGoogleClient } from './services/google';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL, {
  ssl: config.DATABASE_SSL,
  max: config.DB_POOL_MAX,
});

const app = createApp({
  config,
  db,
  email: createEmailService(config),
  google: createGoogleClient(config),
  checkDb: async () => {
    await pool.query('select 1');
    return true;
  },
});

const server = app.listen(config.PORT, () => {
  console.log(`API listening on :${config.PORT}`);
  if (!config.RESEND_API_KEY)
    console.log('Email: RESEND_API_KEY not set, emails print to this console');
  if (!config.GOOGLE_CLIENT_ID) console.log('Google sign-in: not configured');
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
