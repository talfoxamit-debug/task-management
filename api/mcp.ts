import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkCredential } from '../apps/mcp/src/auth.js';
import { getSql } from '../apps/mcp/src/db.js';
import { buildServer } from '../apps/mcp/src/server.js';

/**
 * Vercel route: POST /api/mcp, streamable HTTP.
 *
 * This file lives at the REPOSITORY ROOT, not under apps/mcp, and that is
 * deliberate. Vercel resolves functions relative to the project's Root
 * Directory, and it only reads the vercel.json found there. With the Root
 * Directory left at the repo root, a function nested at apps/mcp/api was never
 * found; Vercel instead chose its own entrypoints from the TypeScript it could
 * see and tried to invoke apps/mcp/src/server.ts, which exports buildServer
 * rather than a request handler:
 *
 *   Invalid export found in module ".../apps/mcp/src/server.mjs".
 *   The default export must be a function or server.
 *
 * Keeping the single entrypoint where Vercel looks by default removes the
 * guesswork. Everything it imports is bundled at build time, so the engine and
 * the tools stay in their workspaces.
 *
 * Stateless: a fresh server and transport per request, because a serverless
 * invocation cannot be relied on to survive between calls and a session id that
 * points at a dead lambda is worse than no session at all.
 */

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const auth = checkCredential(req.headers['authorization'], req.url);
  if (!auth.ok) {
    res.statusCode = auth.status;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: auth.message },
        id: null,
      }),
    );
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    // No sessions to resume or delete in stateless mode.
    res.statusCode = 405;
    res.setHeader('allow', 'POST');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'this endpoint is stateless: use POST' },
        id: null,
      }),
    );
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer(getSql());

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    // Without this, an unreachable database or a malformed DATABASE_URL throws
    // out of the handler and Vercel answers with a generic crash page that says
    // nothing about the cause. Say what actually went wrong instead.
    const message = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32003, message: `TaskOS server error: ${message}` },
          id: null,
        }),
      );
    }
  }
}
