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

  // Unauthenticated liveness check. Deliberately says nothing about the data,
  // the token, or the database — only that the deployment is running, which is
  // the one thing worth being able to check without a credential.
  if (path === '/health') {
    json(res, 200, { ok: true, service: 'taskos-mcp' });
    return;
  }

  json(res, 404, {
    error: 'not found',
    hint: `TaskOS speaks MCP over POST ${MCP_PATH}`,
  });
}
