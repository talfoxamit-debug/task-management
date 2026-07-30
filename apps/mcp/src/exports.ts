/**
 * What other apps in this repo may use.
 *
 * NOT named index.ts, and that is load-bearing. Vercel deploys apps/mcp as a
 * Node.js server app and picks its entrypoint by filename convention; index.ts
 * outranks server.ts, so a barrel file called index.ts silently becomes the
 * thing Vercel tries to boot. It has no default export, so every request dies
 * with "Invalid export found in module .../src/index.mjs. The default export
 * must be a function or server." The MCP server's real entrypoint is server.ts
 * and nothing else in this directory may be named to outrank it.
 *
 * The dashboard imports the loader and the pipeline from here rather than
 * writing its own queries, so the UI and Claude cannot drift apart: there is one
 * definition of "the portfolio as of today" and one call order through the
 * engine. A second implementation would be two answers to the one question this
 * system exists to answer.
 */
export { getSql, setSql, resolveWorkspaceId, loadSettings, today } from './db.js';
export type { Sql, Settings } from './db.js';
export { loadPortfolio } from './load.js';
export type { Portfolio } from './load.js';
export { runEngine, runCapacity } from './pipeline.js';
export type { PipelineResult } from './pipeline.js';
