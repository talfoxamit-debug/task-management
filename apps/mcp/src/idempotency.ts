import type { Queryable, Sql } from './db.js';

/**
 * D3. Every mutating tool accepts an optional idempotency_key. A repeat call
 * returns the original result and mutates nothing.
 *
 * The record of what a key returned lives in events.payload, keyed by the unique
 * index on events.idempotency_key. That makes the guarantee atomic with the write
 * itself: there is no window in which the work has happened but the receipt has
 * not, so a retry can never double-apply.
 */

export interface Replay {
  replayed: true;
  at: string;
  result: unknown;
}

/** Returns the stored result when this key has been used before. */
export async function findReplay(
  sql: Sql,
  key: string | undefined,
  workspaceId?: string,
): Promise<Replay | null> {
  if (!key) return null;
  // Scoped by workspace where one is known: keys are globally unique, so an
  // unscoped lookup would let one tenant learn that another had used a key.
  const rows = workspaceId
    ? await sql<Array<{ payload: { result?: unknown }; at: Date }>>`
        select payload, at from events
         where idempotency_key = ${key} and workspace_id = ${workspaceId} limit 1`
    : await sql<Array<{ payload: { result?: unknown }; at: Date }>>`
        select payload, at from events where idempotency_key = ${key} limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    replayed: true,
    at: row.at.toISOString(),
    result: row.payload?.result ?? null,
  };
}

/**
 * Record the receipt for an idempotency key. Must run inside the same
 * transaction as the work it describes.
 *
 * A unique-violation here means a concurrent caller won the race with the same
 * key; the caller aborts and replays theirs, which is the correct outcome.
 */
export async function recordReceipt(
  sql: Queryable,
  opts: {
    key: string | undefined;
    actor: string;
    verb: string;
    task_id?: string | null;
    venture_id?: string | null;
    workspace_id?: string | null;
    result: unknown;
  },
): Promise<void> {
  await sql`
    insert into events (actor, verb, task_id, venture_id, workspace_id, payload, idempotency_key)
    values (
      ${opts.actor}, ${opts.verb}, ${opts.task_id ?? null}, ${opts.venture_id ?? null},
      ${opts.workspace_id ?? null},
      ${sql.json({ result: opts.result } as never)}, ${opts.key ?? null}
    )
  `;
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

export function isCycleRejection(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: string; message?: string };
  return err.code === '23514' && (err.message ?? '').includes('dependency cycle');
}
