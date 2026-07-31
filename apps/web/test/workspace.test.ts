import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '@taskos/mcp/lib';
import { freshDb, type TestDb } from '../../mcp/test/harness.js';
import { workspaceForUser } from '../lib/workspace.js';

/**
 * The dashboard's isolation boundary.
 *
 * The page resolves its workspace from the signed-in user and never from a URL
 * or a cookie, so this query is the whole boundary. It gets its own test rather
 * than being exercised only through a rendered page.
 */

let db: TestDb;
let sql: Sql;
const ALICE = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STRANGER = '33333333-cccc-4ccc-8ccc-cccccccccccc';
let A: string;
let B: string;

beforeAll(async () => {
  db = await freshDb('webws');
  sql = db.sql as unknown as Sql;
  A = (await sql<Array<{ id: string }>>`select id from workspaces limit 1`)[0]!.id;
  B = (await sql<Array<{ ws: string }>>`
    select taskos_provision_workspace('Bob Ltd') as ws`)[0]!.ws as unknown as string;
  await sql`insert into workspace_members (workspace_id, user_id) values (${A}, ${ALICE})`;
  await sql`insert into workspace_members (workspace_id, user_id) values (${B}, ${BOB})`;
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe('workspaceForUser', () => {
  it('gives each member their own workspace', async () => {
    expect((await workspaceForUser(sql, ALICE))?.workspaceId).toBe(A);
    expect((await workspaceForUser(sql, BOB))?.workspaceId).toBe(B);
  });

  it('gives a user with no membership nothing at all', async () => {
    // Not "the first workspace": a fallback here would show a stranger
    // somebody else's ventures.
    expect(await workspaceForUser(sql, STRANGER)).toBeNull();
  });

  it('never returns a workspace for an unknown or empty user id', async () => {
    expect(await workspaceForUser(sql, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
