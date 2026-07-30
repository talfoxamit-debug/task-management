import { createServer } from 'node:http';
import server from './server.js';

/**
 * Local runner for the exact entrypoint Vercel serves, so the endpoint can be
 * exercised end to end before it is deployed anywhere.
 *
 *   TASKOS_TOKEN=... DATABASE_URL=... npm run dev -w @taskos/mcp
 */

const port = Number(process.env['PORT'] ?? 3939);

createServer((req, res) => {
  void server(req, res);
}).listen(port, () => {
  console.log(`TaskOS MCP listening on http://127.0.0.1:${port}/api/mcp`);
});
