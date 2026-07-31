import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Vercel deploys apps/mcp as a Node.js server app, and it takes the entrypoint
 * from package.json "main". That is the whole rule, and it is easy to break
 * from a distance: Phase 2 added a barrel file so the dashboard could import
 * the loader and pipeline, pointed "main" at it so `import from '@taskos/mcp'`
 * would resolve, and thereby told Vercel to boot a module with no default
 * export. Every request to the live server then failed with
 *
 *   Invalid export found in module ".../src/exports.mjs".
 *   The default export must be a function or server.
 *
 * It built, typechecked and deployed clean. Nothing caught it but production.
 *
 * So "main" and exports["."] both point at server.ts, and the barrel lives at
 * the "./lib" subpath where it cannot be mistaken for the thing to run.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8'));

describe('the Vercel entrypoint', () => {
  it('is server.ts according to package.json main', () => {
    expect(
      pkg.main,
      'Vercel boots package.json "main". Anything but the server here takes ' +
        'the deployment down at runtime while every check still passes.',
    ).toBe('./src/server.ts');
  });

  it('is server.ts according to the default export condition', () => {
    expect(pkg.exports['.']).toBe('./src/server.ts');
  });

  it('keeps the shared barrel on a subpath, out of entrypoint range', () => {
    expect(pkg.exports['./lib']).toBe('./src/exports.ts');
  });

  it('default-exports a request handler', async () => {
    const mod = await import('../src/server.js');
    expect(typeof mod.default).toBe('function');
  });
});
