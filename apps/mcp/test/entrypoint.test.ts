import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Vercel deploys apps/mcp as a Node.js server app and chooses its entrypoint by
 * filename convention, not by package.json. The order it searches puts app.ts
 * and index.ts ahead of server.ts, so adding a file with either name quietly
 * takes over the deployment. It builds and it deploys; every request then fails
 * at runtime with
 *
 *   Invalid export found in module ".../src/index.mjs".
 *   The default export must be a function or server.
 *
 * That happened once, to a barrel file added for the dashboard, and it took the
 * live connector down without a single failing test. These two assertions are
 * what make the next attempt fail here instead.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

// Anything Vercel would boot ahead of server.ts.
const OUTRANKS_SERVER = ['app.ts', 'index.ts', 'app.mts', 'index.mts'];

describe('the Vercel entrypoint', () => {
  it('is not shadowed by a higher-priority filename', () => {
    const present = readdirSync(SRC).filter((f) => OUTRANKS_SERVER.includes(f));
    expect(
      present,
      `apps/mcp/src/${present.join(', ')} outranks server.ts in Vercel's entrypoint ` +
        'search and will be booted instead of it. Rename it (exports.ts is the ' +
        'existing precedent) or the deployment 500s on every request.',
    ).toEqual([]);
  });

  it('default-exports a request handler from server.ts', async () => {
    const mod = await import('../src/server.js');
    expect(typeof mod.default).toBe('function');
  });
});
