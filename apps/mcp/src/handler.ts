import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkCredential } from './auth.js';
import { getSql } from './db.js';
import { buildServer } from './mcp-server.js';

/**
 * THE request handler for POST /api/mcp. Streamable HTTP, stateless.
 *
 * The handler lives here rather than in an api/ directory because Vercel
 * resolves functions relative to the project's Root Directory, and that setting
 * is not visible from the code. Both api/mcp.ts at the repository root and
 * apps/mcp/api/mcp.ts re-export this one function, so the endpoint resolves to
 * /api/mcp whether the Root Directory is the repo root or apps/mcp. Two
 * three-line files are a cheap price for not having the deployment depend on a
 * dashboard setting nobody can see from here.
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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Reply with a plain JSON body instead of an SSE stream.
      //
      // In stateless mode the SDK otherwise answers over text/event-stream and
      // holds the stream open after writing the result. Behind a serverless
      // platform that response can be buffered until the stream closes, so the
      // client waits for an event that never arrives: initialize and tools/list
      // completed, while the first tools/call hung until the client gave up at
      // 60s, leaving no log line at all because the request never finished.
      //
      // Nothing here needs streaming - every tool returns one JSON document -
      // so the stream buys nothing and costs a failure mode.
      enableJsonResponse: true,
    });
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
