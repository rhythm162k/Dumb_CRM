import { AsyncLocalStorage } from 'node:async_hooks';
import type { Response, RequestHandler } from 'express';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { AppError } from '../middleware/errors';

/**
 * Row-level security plumbing.
 *
 * Every request to /api/workspaces/:workspaceId/<tenant data> runs inside ONE database
 * transaction that first switches to the restricted role `kin_app` and sets `app.workspace_id`.
 * Postgres policies (migration 0001) then only show and accept rows of that workspace, even if a
 * query forgets its own `workspace_id` filter. The app-level filters stay as the first layer.
 *
 * Routers get `scopedDb(db)`: a stand-in that forwards every call to the current request's
 * transaction and refuses to work outside one (fail closed).
 */
export const TENANT_ROLE = 'kin_app';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const current = new AsyncLocalStorage<Tx>();

/** Runs `fn` so that `scopedDb` calls inside it use `tx`. */
export const withTenantTx = <T>(tx: Tx, fn: () => T): T => current.run(tx, fn);

export function scopedDb(db: Db): Db {
  return new Proxy(db, {
    get(_target, prop) {
      const tx = current.getStore();
      if (!tx) throw new Error('Tenant data was used outside a workspace scope');
      const value: unknown = Reflect.get(tx, prop);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(tx) : value;
    },
  });
}

class Abort extends Error {}

/**
 * Opens a transaction scoped to one workspace and keeps it open until `finish` is called.
 * `finish(true)` commits, `finish(false)` rolls back; calling it again returns the same result.
 */
export async function openTenantScope(db: Db, workspaceId: string) {
  let decide!: (commit: boolean) => void;
  const decision = new Promise<boolean>((resolve) => {
    decide = resolve;
  });
  let ready!: (tx: Tx) => void;
  let failed!: (err: unknown) => void;
  const started = new Promise<Tx>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });

  const done = db
    .transaction(async (tx) => {
      try {
        await tx.execute(sql.raw(`set local role ${TENANT_ROLE}`));
        await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
      } catch (err) {
        failed(err);
        throw err;
      }
      ready(tx);
      if (!(await decision)) throw new Abort();
    })
    .then(
      () => undefined,
      (err: unknown) => {
        if (!(err instanceof Abort)) throw err;
      },
    );
  done.catch(failed); // a failure before the scope was ready must not hang the request

  const tx = await started;
  let finishing: Promise<void> | undefined;
  const finish = (commit: boolean) => {
    if (!finishing) {
      decide(commit);
      finishing = done;
    }
    return finishing;
  };
  return { tx, finish };
}

const internalError = JSON.stringify({
  error: { code: 'internal_error', message: 'Something went wrong' },
});

/**
 * Place after requireMember. Opens the scoped transaction, then holds the response back until the
 * transaction is finished: committed for status < 400, rolled back for errors. That way a client
 * never sees a success before its data is committed, and a failed request leaves nothing behind.
 */
export const tenantScope =
  (db: Db): RequestHandler =>
  (req, res, next) => {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) {
      next(new AppError(401, 'Sign in required', 'unauthorized'));
      return;
    }
    openTenantScope(db, workspaceId).then(({ tx, finish }) => {
      const end = res.end.bind(res) as (...args: unknown[]) => Response;
      res.end = ((...args: unknown[]) => {
        finish(res.statusCode < 400).then(
          () => end(...args),
          (err: unknown) => {
            console.error(err);
            res.removeHeader('Content-Length');
            res.status(500).setHeader('Content-Type', 'application/json; charset=utf-8');
            end(internalError);
          },
        );
        return res;
      }) as typeof res.end;
      // client went away before the handler answered: never leave the transaction open
      res.once('close', () => {
        finish(false).catch(() => undefined);
      });
      withTenantTx(tx, () => next());
    }, next);
  };
