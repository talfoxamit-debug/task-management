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

  handle = postgres(url, {
    // Serverless: one connection per invocation, released promptly. The Supabase
    // transaction pooler cannot use prepared statements.
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
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

export async function loadSettings(sql: Sql): Promise<Settings> {
  const rows = await sql<Array<{ active_tz: string; buffer_ratio: string; started_at: Date }>>`
    select active_tz, buffer_ratio, started_at from settings where id = 1
  `;
  const row = rows[0];
  if (!row) {
    // The schema seeds this row; if it is gone, say so rather than inventing a
    // timezone and silently computing every day boundary in the wrong place.
    throw new Error('settings row is missing: active_tz and buffer_ratio are unknown');
  }
  return {
    active_tz: row.active_tz,
    buffer_ratio: Number(row.buffer_ratio),
    started_at: row.started_at.toISOString(),
  };
}

/** "Today" in active_tz, resolved by the database (D2). */
export async function today(sql: Sql): Promise<string> {
  const rows = await sql<Array<{ d: string }>>`select taskos_today()::text as d`;
  const d = rows[0]?.d;
  if (!d) throw new Error('taskos_today() returned nothing');
  return d;
}
