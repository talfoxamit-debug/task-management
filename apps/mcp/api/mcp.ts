import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkBearer } from '../src/auth.js';
import { getSql } from '../src/db.js';
import { buildServer } from '../src/server.js';

/**
 * Vercel route: POST /api/mcp, streamable HTTP.
 *
 * Stateless: a fresh server and transport per request, because a serverless
 * invocation cannot be relied on to survive between calls and a session id that
 * points at a dead lambda is worse than no session at all.
 */

export const config = { runtime: 'nodejs' };

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const auth = checkBearer(req.headers['authorization']);
  if (!auth.ok) {
    res.statusCode = auth.status;
    res.setHeader('content-type', 'application/json');
    // 401 must advertise the scheme, or clients cannot tell how to authenticate.
    if (auth.status === 401) res.setHeader('www-authenticate', 'Bearer');
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

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(getSql());

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
