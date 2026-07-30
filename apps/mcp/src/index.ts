/**
 * What other apps in this repo may use.
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
