import type { IncomingMessage, ServerResponse } from 'node:http';
import mcp from './handler.js';
import daily, { DAILY_PATH } from './daily-route.js';
import delegate, { isDelegatePath } from './delegate-route.js';
import telegram, { TELEGRAM_PATH } from './telegram-route.js';

/**
 * THE Vercel entrypoint.
 *
 * This project deploys as a Node.js SERVER app, not as a set of api/ functions.
 * Vercel's build says so in as many words when the file is missing:
 *
 *   No entrypoint found in "/vercel/path0/apps/mcp". Set package.json "main" to
 *   a server file, or add one of: app.ts, index.ts, server.ts, src/server.ts, ...
 *
 * So a default-exported request handler at src/server.ts is exactly what is
 * wanted, and every path in the deployment arrives here — which is why routing
 * is done explicitly below rather than left to a directory layout.
 *
 * Keep the default export a function. The MCP server builder lives in
 * mcp-server.ts precisely so that this file's default export stays the handler:
 * exporting a builder from here is what produced
 * "The default export must be a function or server" on every request.
 */

const MCP_PATH = '/api/mcp';

export type DatabaseStatus =
  | 'connected'
  | 'not_configured'
  | 'authentication_failed'
  | 'host_not_found'
  | 'connection_refused'
  | 'timed_out'
  | 'database_missing'
  | 'unreachable';

/**
 * Which failure mode is in play, and nothing more.
 *
 * The classification is deliberately coarse and derived from error CODES, never
 * from error text: postgres.js messages can carry the host and the username from
 * the connection string, so no message is ever returned or logged from here.
 * Knowing "the password is wrong" versus "that hostname does not resolve" is the
 * difference between a two-minute fix and an afternoon, and neither answer tells
 * a stranger anything they could not learn by trying to connect themselves.
 */
async function databaseStatus(): Promise<{ status: DatabaseStatus; code?: string }> {
  if (!process.env['DATABASE_URL'] && !process.env['POSTGRES_URL'])
    return { status: 'not_configured' };
  try {
    const { getSql } = await import('./db.js');
    await getSql()`select 1`;
    return { status: 'connected' };
  } catch (e) {
    const code = String((e as { code?: string })?.code ?? '');
    return { status: classify(code), ...(code ? { code } : {}) };
  }
}

/**
 * The SQLSTATE is returned alongside the classification because two codes that
 * both mean "rejected at login" have different fixes, and without the code the
 * operator cannot tell them apart: 28P01 is a wrong password, while 28000 from
 * Supabase's pooler almost always means the USERNAME is wrong -- plain
 * `postgres` where the pooler requires `postgres.<project-ref>`. The code alone
 * says nothing a stranger could not learn by attempting a connection.
 */
function classify(code: string): DatabaseStatus {
  switch (code) {
      case '28P01': // invalid_password
      case '28000': // invalid_authorization_specification
        return 'authentication_failed';
      case '3D000': // invalid_catalog_name
        return 'database_missing';
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return 'host_not_found';
      case 'ECONNREFUSED':
        return 'connection_refused';
      case 'ETIMEDOUT':
      case 'CONNECT_TIMEOUT':
        return 'timed_out';
      default:
        return 'unreachable';
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function server(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0]!.replace(/\/+$/, '') || '/';

  if (path === MCP_PATH) {
    await mcp(req, res);
    return;
  }

  if (path === TELEGRAM_PATH) {
    await telegram(req, res);
    return;
  }

  // The 08:00 brief, fired by Vercel Cron. Authenticated inside the route,
  // because an unauthenticated version of this is a free way for anyone to push
  // messages to Tal's phone.
  if (path === DAILY_PATH) {
    await daily(req, res);
    return;
  }

  // The delegate pages: /p/<token>, /d/<token>, /c/<token>.ics and the POSTs
  // under them. These are the ONLY unauthenticated routes that touch data, and
  // they are matched by a strict pattern rather than a prefix so a path that
  // merely starts with /p/ cannot reach them. Everything about the trade is
  // documented in delegate-route.ts.
  if (isDelegatePath(path)) {
    await delegate(req, res, path);
    return;
  }

  // Unauthenticated liveness check.
  //
  // It reports whether configuration is PRESENT and whether the database
  // answers, never what any of it is: no hostnames, no connection strings, no
  // error text, and nothing at all about the token's value. That is enough to
  // tell a missing DATABASE_URL apart from an unreachable one — the difference
  // between the two 500s this endpoint exists to diagnose — without a
  // credential, and without handing a stranger anything they can use.
  if (path === '/health') {
    json(res, 200, {
      ok: true,
      service: 'taskos-mcp',
      tokenConfigured: Boolean(process.env['TASKOS_TOKEN']),
      ...(await (async () => {
        const db = await databaseStatus();
        return { database: db.status, ...(db.code ? { databaseCode: db.code } : {}) };
      })()),
    });
    return;
  }

  json(res, 404, {
    error: 'not found',
    hint: `TaskOS speaks MCP over POST ${MCP_PATH}`,
  });
}
