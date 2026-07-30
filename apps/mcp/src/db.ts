import postgres from 'postgres';

/**
 * The one database handle. Everything I/O in TaskOS lives on this side of the
 * line; packages/engine never sees it.
 *
 * postgres.js rather than the Supabase JS client because commit_tasks has to
 * insert tasks and their dependency edges in ONE transaction — a half-written
 * dependency graph is exactly the incomplete-coverage failure the engine's
 * coverage guard exists to catch, and there is no reason to create it on purpose.
 */

export type Sql = postgres.Sql<{}>;

/**
 * Anything that can run a query: the pool handle or a transaction handle.
 * Helpers that must be callable from inside sql.begin() take this.
 */
export type Queryable = Sql | postgres.TransactionSql<{}>;

let handle: Sql | null = null;

export function getSql(): Sql {
  if (handle) return handle;

  const url = process.env['DATABASE_URL'] ?? process.env['POSTGRES_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set: the MCP server has no database to talk to. Set the Supabase pooler connection string.',
    );
  }

  // Supabase (and every other hosted Postgres) requires TLS, but postgres.js
  // only enables it when the connection string asks for it. A pasted Supabase
  // URL has no sslmode parameter, so without this the first query fails with a
  // bare "connection closed" that says nothing about certificates. Local
  // development databases are left alone.
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  const urlDeclaresSsl = /[?&]sslmode=/.test(url);

  handle = postgres(url, {
    // Serverless: one connection per invocation, released promptly. The Supabase
    // transaction pooler cannot use prepared statements.
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    ...(isLocal || urlDeclaresSsl ? {} : { ssl: 'require' as const }),
    // Return dates as `YYYY-MM-DD` strings rather than JS Date objects. The
    // engine's contract is calendar dates in active_tz, and a Date here would
    // silently re-introduce the timezone shift D2 exists to prevent.
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
    onnotice: () => {},
  });
  return handle;
}

/** For tests and for the dev server: point at a different database. */
export function setSql(sql: Sql | null): void {
  handle = sql;
}

export interface Settings {
  active_tz: string;
  buffer_ratio: number;
  started_at: string;
}

/**
 * Which workspace this caller acts in.
 *
 * Today a single shared token means a single workspace, so the one that exists
 * is used. This function is the seam where per-user identity plugs in later: it
 * is the ONLY place a workspace is chosen, so when tokens map to users the
 * change is here and nowhere else.
 *
 * It refuses to guess once a second workspace exists, rather than silently
 * picking one and writing somebody's tasks into it.
 */
export async function resolveWorkspaceId(sql: Sql): Promise<string> {
  const configured = process.env['TASKOS_WORKSPACE_ID'];
  if (configured) return configured;

  const rows = await sql<Array<{ id: string }>>`select id from workspaces order by created_at`;
  if (rows.length === 1) return rows[0]!.id;
  if (rows.length === 0) {
    throw new Error('no workspace exists: run migration 0005, which creates the first one');
  }
  throw new Error(
    `${rows.length} workspaces exist and this token maps to no particular one; set TASKOS_WORKSPACE_ID, or give the caller an identity`,
  );
}

export async function loadSettings(sql: Sql, workspaceId: string): Promise<Settings> {
  const rows = await sql<Array<{ active_tz: string; buffer_ratio: string; started_at: Date }>>`
    select active_tz, buffer_ratio, started_at from settings where workspace_id = ${workspaceId}
  `;
  const row = rows[0];
  if (!row) {
    // The schema seeds this row; if it is gone, say so rather than inventing a
    // timezone and silently computing every day boundary in the wrong place.
    throw new Error(
      `settings row is missing for workspace ${workspaceId}: active_tz and buffer_ratio are unknown`,
    );
  }
  return {
    active_tz: row.active_tz,
    buffer_ratio: Number(row.buffer_ratio),
    started_at: row.started_at.toISOString(),
  };
}

/** "Today" in this workspace's active_tz, resolved by the database (D2). */
export async function today(sql: Sql, workspaceId: string): Promise<string> {
  const rows = await sql<Array<{ d: string }>>`select taskos_today(${workspaceId})::text as d`;
  const d = rows[0]?.d;
  if (!d) throw new Error('taskos_today() returned nothing');
  return d;
}

/**
 * Run `work` with a hard deadline, turning a hang into a named error.
 *
 * A serverless function that hangs is the worst thing to debug: the platform
 * logs nothing on completion because the request never completes, so the only
 * evidence is a client timeout minutes later with no indication of which step
 * stalled. Every database stage in a tool goes through this, so a stall reports
 * itself as "stage X did not finish in Nms" instead of vanishing.
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Time a stage and log it, so the runtime logs show where the time went. */
export async function timed<T>(label: string, ms: number, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await withDeadline(label, ms, work);
    console.log(`[taskos] ${label} ok in ${Date.now() - started}ms`);
    return result;
  } catch (e) {
    console.log(
      `[taskos] ${label} FAILED after ${Date.now() - started}ms: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    throw e;
  }
}
