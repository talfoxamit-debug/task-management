import type { IncomingMessage, ServerResponse } from 'node:http';
import mcp from './handler.js';

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

/**
 * Which of the two failure modes is in play, and nothing more.
 *
 *   not_configured — DATABASE_URL is absent or unparseable
 *   unreachable    — it is set, but the database did not answer
 *   connected      — a trivial query succeeded
 *
 * The underlying error is deliberately NOT returned: postgres.js messages can
 * carry the host, and sometimes the user, from the connection string.
 */
async function databaseStatus(): Promise<'connected' | 'unreachable' | 'not_configured'> {
  if (!process.env['DATABASE_URL'] && !process.env['POSTGRES_URL']) return 'not_configured';
  try {
    const { getSql } = await import('./db.js');
    await getSql()`select 1`;
    return 'connected';
  } catch {
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
      database: await databaseStatus(),
    });
    return;
  }

  json(res, 404, {
    error: 'not found',
    hint: `TaskOS speaks MCP over POST ${MCP_PATH}`,
  });
}
