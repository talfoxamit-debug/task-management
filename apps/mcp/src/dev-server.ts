import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { checkCredential } from './auth.js';
import { getSql } from './db.js';
import { buildServer } from './server.js';

/**
 * Local runner for the same handler Vercel serves, so the endpoint can be
 * exercised end to end before it is deployed anywhere.
 *
 *   TASKOS_TOKEN=... DATABASE_URL=... npm run dev -w @taskos/mcp
 */

const port = Number(process.env['PORT'] ?? 3939);

createServer(async (req, res) => {
  if (!(req.url ?? '').startsWith('/api/mcp')) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  const auth = checkCredential(req.headers['authorization'], req.url);
  if (!auth.ok) {
    res.statusCode = auth.status;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: auth.message }, id: null }),
    );
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('allow', 'POST');
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'use POST' }, id: null }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(getSql());
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}).listen(port, () => {
  console.log(`TaskOS MCP listening on http://127.0.0.1:${port}/api/mcp`);
});
