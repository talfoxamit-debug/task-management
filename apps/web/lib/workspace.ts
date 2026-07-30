import type { Sql } from '@taskos/mcp';

/**
 * The workspace a signed-in user may see.
 *
 * Extracted from the page so it can be tested directly: this one query is what
 * stands between one person's ventures and another's, and it should not only be
 * exercised through a rendered React tree.
 *
 * Returns null for a user with no membership. Falling back to "the first
 * workspace" would show a stranger somebody else's portfolio, so there is no
 * fallback.
 */
export async function workspaceForUser(
  sql: Sql,
  userId: string,
): Promise<{ workspaceId: string; workspaceName: string } | null> {
  const rows = await sql<Array<{ workspace_id: string; name: string }>>`
    select m.workspace_id, w.name
      from workspace_members m
      join workspaces w on w.id = m.workspace_id
     where m.user_id = ${userId}
     order by m.created_at
     limit 1
  `;
  const row = rows[0];
  return row ? { workspaceId: row.workspace_id, workspaceName: row.name } : null;
}
