import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getSql } from '@taskos/mcp';
import { workspaceForUser } from './workspace';

/**
 * Who is asking, and which workspace they may see.
 *
 * TWO LAYERS, deliberately:
 *
 * 1. Supabase Auth establishes WHO. The session cookie is verified by
 *    getUser(), which checks the JWT against the auth server rather than
 *    trusting whatever the browser sent. getSession() does not do that, which is
 *    why it is not used here.
 *
 * 2. workspace_members establishes WHAT THEY MAY SEE. Every page resolves the
 *    workspace from the signed-in user, never from a URL parameter or a cookie,
 *    so there is no id for anyone to tamper with.
 *
 * The page then reads through the same postgres.js connection the MCP server
 * uses, which owns the tables and is therefore NOT subject to RLS. RLS remains
 * the backstop for anything reaching the database through PostgREST with a user
 * JWT. Being plain about that asymmetry: on this path isolation is enforced by
 * the query below, and the tests in apps/mcp/test/tenancy.test.ts are what keep
 * it honest.
 */

export interface Viewer {
  userId: string;
  email: string | null;
  workspaceId: string;
  workspaceName: string;
}

export async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  const store = await cookies();
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set for sign-in to work',
    );
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      // Server components cannot set cookies; the auth route handler does that.
      setAll: () => {},
    },
  });

  // getUser, not getSession: this one verifies the token with the auth server.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * The viewer's workspace, or null when they are signed in but belong to none.
 *
 * A user with no membership sees nothing rather than a default workspace: the
 * failure mode of "helpfully" falling back to the first one is showing somebody
 * else's ventures to a stranger.
 */
export async function currentViewer(): Promise<Viewer | null> {
  const user = await currentUser();
  if (!user) return null;

  const found = await workspaceForUser(getSql(), user.id);
  if (!found) return null;

  return {
    userId: user.id,
    email: user.email,
    workspaceId: found.workspaceId,
    workspaceName: found.workspaceName,
  };
}
