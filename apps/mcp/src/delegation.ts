import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveWorkspaceId, type Queryable, type Sql } from './db.js';
import { envelope, narrow, plainConfidence, type ToolEnvelope } from './narrow.js';

/**
 * Delegation links: minting, resolving, revoking.
 *
 * The whole security model is in this file, so it is worth stating plainly.
 *
 * A link IS the credential. There is no account, no password and no second
 * factor, because requiring any of those is what stops a collaborator ever
 * using the thing. That trade is only acceptable because of what a link can
 * reach: exactly one person's own assigned work, and nothing else. Not the
 * portfolio, not another person's tasks, not capacity(), not the slip ranking.
 *
 * ONLY THE HASH IS STORED. The plaintext exists once, in the response to
 * delegate_link, and is never written down again. A database dump, a backup or
 * a screenshot of a query yields nothing that works. The cost of that choice is
 * that "resend me that link" is impossible — so rotation with a grace window is
 * a first-class operation rather than an afterthought.
 */

export type Scope = 'person' | 'task' | 'calendar' | 'owner';

const PREFIX: Record<Scope, string> = {
  person: 'tdp_',
  task: 'tdt_',
  calendar: 'tdc_',
  // Tal's own. A distinct prefix so a token in a log or a screenshot is
  // identifiable as the wide one without resolving it.
  owner: 'tdo_',
};

/** Recognise a token before touching the database, and reject anything else. */
const TOKEN_RE = /^td[ptco]_[A-Za-z0-9_-]{43}$/;

export function looksLikeToken(raw: string): boolean {
  return TOKEN_RE.test(raw);
}

function hash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function mint(scope: Scope): { raw: string; hash: string; prefix: string } {
  const raw = `${PREFIX[scope]}${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hash(raw), prefix: raw.slice(0, 12) };
}

/** The public origin these links live on. */
export function publicUrl(): string | null {
  const raw =
    process.env['TASKOS_PUBLIC_URL'] ??
    (process.env['VERCEL_PROJECT_PRODUCTION_URL']
      ? `https://${process.env['VERCEL_PROJECT_PRODUCTION_URL']}`
      : null);
  return raw ? raw.replace(/\/+$/, '') : null;
}

function pathFor(scope: Scope, raw: string): string {
  if (scope === 'person') return `/p/${raw}`;
  if (scope === 'task') return `/d/${raw}`;
  if (scope === 'owner') return `/me/${raw}`;
  return `/c/${raw}.ics`;
}

export function linkFor(scope: Scope, raw: string): string {
  const base = publicUrl();
  return base ? `${base}${pathFor(scope, raw)}` : pathFor(scope, raw);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedToken {
  token_id: string;
  /** NULL only for an owner token: Tal is not a row in `people`. */
  person_id: string;
  workspace_id: string;
  person_name: string;
  scope: Scope;
  task_id: string | null;
  superseded_link: string | null;
}

export type Resolution =
  | { ok: true; token: ResolvedToken }
  | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' | 'expired' | 'completed' };

/**
 * How long a task link outlives the task.
 *
 * Tal's rule: one link per task, and the link disappears ninety minutes after
 * the task is approved. Ninety minutes rather than immediately because the
 * moment after "done" is exactly when the fifteen-minute undo gets used, when
 * the receipt gets read, and when somebody adds the note they meant to add
 * first. A link that dies on the tap turns every mis-tap into a message to Tal,
 * which is the interruption the whole feature exists to remove.
 */
export const APPROVAL_GRACE_MINUTES = 90;

/**
 * Turn a presented token into a person, or refuse.
 *
 * Expiry is enforced HERE rather than by a sweeper, and that turns "this
 * platform has no cron" from a constraint into a property: there is no window
 * in which an expired link still works because a job has not run yet. An
 * expired row is revoked lazily on the way past, so the partial-unique index
 * stays honest and a dormant person can be re-onboarded.
 *
 * The ninety-minute rule is computed from the TASK rather than written onto the
 * token, and that is the reason undo works. Stamping expires_at at close time
 * would need the previous value stored somewhere to put back when the close is
 * undone; deriving it from tasks.closed_at means undoing the close revives the
 * link with no bookkeeping at all, because there is no longer a closed_at to
 * measure from.
 */
export async function resolveToken(sql: Sql, raw: string): Promise<Resolution> {
  if (!looksLikeToken(raw)) return { ok: false, reason: 'malformed' };

  const rows = await sql<
    Array<{
      id: string;
      workspace_id: string;
      person_id: string;
      person_name: string | null;
      scope: Scope;
      task_id: string | null;
      token_hash: string;
      revoked_at: Date | null;
      expired: boolean;
      completed: boolean;
      superseded_by: string | null;
    }>
  >`
    select t.id, t.workspace_id, t.person_id, p.name as person_name, t.scope, t.task_id,
           t.token_hash, t.revoked_at, t.superseded_by,
           (t.expires_at is not null and t.expires_at <= now()) as expired,
           (t.scope = 'task' and k.status in ('done', 'killed') and k.closed_at is not null
            and k.closed_at <= now() - ${`${APPROVAL_GRACE_MINUTES} minutes`}::interval)
             as completed
      from delegation_tokens t
      -- LEFT join: an owner token has no person, and an inner join would make
      -- it resolve as 'unknown' -- an authentication failure that looks exactly
      -- like a bad token and would be hunted for hours.
      left join people p on p.id = t.person_id
      left join tasks k on k.id = t.task_id
     where t.token_hash = ${hash(raw)}
     limit 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };

  // The unique index on token_hash is the real defence; this compare costs
  // nothing and matches the constant-time discipline in auth.ts.
  const a = Buffer.from(row.token_hash, 'utf8');
  const b = Buffer.from(hash(raw), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'unknown' };

  if (row.revoked_at) return { ok: false, reason: 'revoked' };

  if (row.expired || row.completed) {
    const reason = row.completed ? 'completed' : 'expired';
    await sql`
      update delegation_tokens
         set revoked_at = now(), revoked_reason = coalesce(revoked_reason, ${reason})
       where id = ${row.id} and revoked_at is null`;
    return { ok: false, reason };
  }

  // A superseded token still works during its grace window, and its page will
  // carry a banner with the replacement. Rotation that silently locks somebody
  // out is rotation nobody ever performs.
  let supersededLink: string | null = null;
  if (row.superseded_by) {
    supersededLink = 'rotated';
  }

  return {
    ok: true,
    token: {
      token_id: row.id,
      workspace_id: row.workspace_id,
      person_id: row.person_id,
      person_name: row.person_name ?? 'Tal',
      scope: row.scope,
      task_id: row.task_id,
      superseded_link: supersededLink,
    },
  };
}

/** GET telemetry. Never reported as "they read it" — see the tool notes. */
export async function stampFetch(sql: Queryable, tokenId: string): Promise<void> {
  await sql`
    update delegation_tokens
       set fetch_count = fetch_count + 1, last_fetched_at = now()
     where id = ${tokenId}`;
}

/** POST telemetry. The only signal that is definitely a human. */
export async function stampAction(sql: Queryable, tokenId: string): Promise<void> {
  await sql`update delegation_tokens set acted_at = now() where id = ${tokenId}`;
}

// ---------------------------------------------------------------------------
// delegate_link
// ---------------------------------------------------------------------------

export interface DelegateLinkInput {
  person: string;
  scope?: Scope;
  task_id?: string;
  label?: string;
  rotate?: boolean;
  grace_hours?: number;
  expires_in_days?: number;
}

export async function delegateLink(sql: Sql, input: DelegateLinkInput): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const scope: Scope = input.scope ?? (input.task_id ? 'task' : 'person');

  if (scope === 'task' && !input.task_id) {
    return envelope(plainConfidence([]), { link: null }, [
      { code: 'task_required', message: 'a task-scoped link needs task_id — nothing was written' },
    ]);
  }
  if (scope !== 'task' && input.task_id) {
    return envelope(plainConfidence([]), { link: null }, [
      {
        code: 'task_not_allowed',
        message: `a ${scope}-scoped link covers the whole queue and must not name a task — nothing was written`,
      },
    ]);
  }

  const people = await sql<Array<{ id: string; name: string; active: boolean }>>`
    select id, name, active from people
     where workspace_id = ${workspaceId} and name = ${input.person} limit 1`;
  const person = people[0];
  if (!person) {
    const known = await sql<Array<{ name: string }>>`
      select name from people where workspace_id = ${workspaceId} order by name`;
    return envelope(plainConfidence([]), { link: null }, [
      {
        code: 'unknown_person',
        message: `person "${input.person}" does not exist — nothing was written. Known: ${
          known.map((k) => k.name).join(', ') || 'nobody yet; use create_person'
        }`,
      },
    ]);
  }

  let taskTitle: string | null = null;
  let deadline: string | null = null;
  if (scope === 'task') {
    const tasks = await sql<
      Array<{
        id: string;
        title: string;
        status: string;
        assignee_person_id: string | null;
        deadline_date: string | null;
      }>
    >`
      select id, title, status, assignee_person_id, deadline_date::text as deadline_date from tasks
       where id = ${input.task_id!} and workspace_id = ${workspaceId} limit 1`;
    const task = tasks[0];
    if (!task) {
      return envelope(plainConfidence([]), { link: null }, [
        { code: 'not_found', message: `task ${input.task_id} does not exist — nothing was written` },
      ]);
    }
    if (task.status === 'done' || task.status === 'killed') {
      // A link minted for finished work is dead ninety minutes later by the rule
      // below, so minting it at all just sends somebody a page that says "all
      // done" — which reads as a broken link rather than as good news.
      return envelope(plainConfidence([]), { link: null }, [
        {
          code: 'already_finished',
          message: `"${task.title}" is already ${task.status} — nothing was written. Reopen it first if it needs doing again.`,
        },
      ]);
    }
    if (task.assignee_person_id !== person.id) {
      // Minting a link for work the person is not assigned would create a
      // credential to a task they cannot close, which reads as a broken page.
      return envelope(plainConfidence([]), { link: null }, [
        {
          code: 'not_assigned',
          message: `"${task.title}" is not assigned to ${person.name} — nothing was written. Assign it with update_task first.`,
        },
      ]);
    }
    taskTitle = task.title;
    deadline = task.deadline_date;
  }

  // An existing live link is returned rather than replaced. Minting a second
  // one silently invalidates nothing but doubles what is in circulation, and
  // the person is usually still holding the first.
  const live = await sql<Array<{ id: string; token_prefix: string; created_at: Date }>>`
    select id, token_prefix, created_at from delegation_tokens
     where workspace_id = ${workspaceId} and person_id = ${person.id} and scope = ${scope}
       ${scope === 'task' ? sql`and task_id = ${input.task_id!}` : sql``}
       and revoked_at is null and superseded_by is null
       and (expires_at is null or expires_at > now())
     limit 1`;

  if (live[0] && !input.rotate) {
    return envelope(
      plainConfidence([
        'a live link already exists for this; the secret cannot be shown again because only its hash is stored',
        'pass rotate:true to mint a replacement, which keeps the old one working for a grace window',
      ]),
      {
        link: null,
        already_live: true,
        token_prefix: live[0].token_prefix,
        issued: live[0].created_at.toISOString().slice(0, 10),
        person: person.name,
      },
    );
  }

  const { raw, hash: tokenHash, prefix } = mint(scope);

  // A task link's real expiry is ninety minutes after the work is approved, and
  // that is enforced in resolveToken against tasks.closed_at rather than stored
  // here. What is stored is the BACKSTOP for the other ending: work that is
  // never finished at all, where nothing ever sets closed_at and the credential
  // would otherwise live forever.
  //
  // Person links are durable by default. A link that expires mid-sprint
  // generates a support request to a one-man company, and then nobody uses the
  // feature.
  const expiresAt =
    input.expires_in_days !== undefined
      ? sql`now() + ${`${input.expires_in_days} days`}::interval`
      : scope === 'task'
        ? deadline
          ? sql`${deadline}::date + interval '30 days'`
          : sql`now() + interval '90 days'`
        : null;

  // The id is chosen here rather than by the database, because the old row must
  // be marked superseded BEFORE the new one is inserted -- the partial unique
  // index forbids two live links for one person, and marking afterwards is too
  // late. superseded_by is DEFERRABLE INITIALLY DEFERRED so it may point at a
  // row that does not exist until commit.
  const newId = randomUUID();

  const created = await sql.begin(async (tx) => {
    if (live[0] && input.rotate) {
      const grace = input.grace_hours ?? 72;
      await tx`
        update delegation_tokens
           set superseded_by = ${newId},
               expires_at = least(coalesce(expires_at, 'infinity'::timestamptz),
                                  now() + ${`${grace} hours`}::interval)
         where id = ${live[0]!.id}`;
    }

    const rows = await tx<Array<{ id: string }>>`
      insert into delegation_tokens (id, workspace_id, person_id, scope, task_id, token_hash,
                                     token_prefix, label, expires_at)
      values (${newId}, ${workspaceId}, ${person.id}, ${scope}, ${input.task_id ?? null},
              ${tokenHash}, ${prefix}, ${input.label ?? null}, ${expiresAt})
      returning id`;
    return rows[0]!;
  });

  // Notes written before anyone else could read them are the likeliest place a
  // private aside is sitting. Surface them so Tal can look before he sends.
  const notesReview = await sql<Array<{ title: string; notes: string }>>`
    select t.title, t.notes from tasks t
     where t.workspace_id = ${workspaceId} and t.assignee_person_id = ${person.id}
       and t.status not in ('done', 'killed') and t.notes is not null and t.notes <> ''
       ${scope === 'task' ? sql`and t.id = ${input.task_id!}` : sql``}
     order by t.last_touched_at desc limit 10`;

  const notes: string[] = [
    'this link IS the credential: anyone holding it can see and close that work',
    'only its hash is stored, so it cannot be shown again — rotate to replace it',
  ];
  notes.push(
    scope === 'task'
      ? `one link, one task: it stops working ${APPROVAL_GRACE_MINUTES} minutes after the task is marked done`
      : `a ${scope} link covers this person's whole queue and does not expire on its own — revoke it when they stop working with you`,
  );
  if (!publicUrl()) {
    notes.push(
      'TASKOS_PUBLIC_URL is not set, so the path below is relative; set it to the deployment origin',
    );
  }
  if (notesReview.length > 0) {
    notes.push(
      `${notesReview.length} task(s) carry notes written before anyone else could read them — check them before sending: ${notesReview
        .map((n) => n.title)
        .join('; ')}`,
    );
  }
  if (!person.active) notes.push(`${person.name} is marked inactive`);

  return envelope(plainConfidence(notes), {
    link: linkFor(scope, raw),
    token_id: created.id,
    token_prefix: prefix,
    scope,
    person: person.name,
    ...(taskTitle ? { task: taskTitle } : {}),
    rotated: Boolean(live[0] && input.rotate),
    give_this_to: person.name,
  });
}

// ---------------------------------------------------------------------------
// list_delegation_links / revoke_delegation
// ---------------------------------------------------------------------------

export async function listDelegationLinks(
  sql: Sql,
  input: { person?: string; include_revoked?: boolean },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const rows = await sql<
    Array<{
      id: string;
      token_prefix: string;
      person: string | null;
      scope: string;
      task: string | null;
      created_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
      fetch_count: number;
      acted_at: Date | null;
    }>
  >`
    select d.id, d.token_prefix, p.name as person, d.scope, t.title as task,
           d.created_at, d.expires_at, d.revoked_at, d.fetch_count, d.acted_at
      from delegation_tokens d
      -- LEFT, for the same reason revoke_delegation takes no join at all: an
      -- owner token has no person, and an inner join would hide the one link
      -- that reaches everything.
      left join people p on p.id = d.person_id
      left join tasks t on t.id = d.task_id
     where d.workspace_id = ${workspaceId}
       ${input.person ? sql`and p.name = ${input.person}` : sql``}
       ${input.include_revoked ? sql`` : sql`and d.revoked_at is null`}
     order by d.created_at desc`;

  const list = narrow(
    rows.map((r) => ({
      token_id: r.id,
      token_prefix: r.token_prefix,
      person: r.person ?? "Tal (owner link)",
      scope: r.scope,
      task: r.task,
      issued: r.created_at.toISOString().slice(0, 10),
      expires: r.expires_at ? r.expires_at.toISOString().slice(0, 10) : null,
      revoked: Boolean(r.revoked_at),
      fetched: r.fetch_count,
      last_action: r.acted_at ? r.acted_at.toISOString().slice(0, 10) : null,
    })),
  );

  return envelope(
    plainConfidence([
      'a fetch count is not a read: link previews in WhatsApp, Telegram and Slack all fetch the URL. last_action is the only signal that is definitely a person.',
    ]),
    { links: list.items, total: list.total },
  );
}

export async function revokeDelegation(
  sql: Sql,
  input: { token_id?: string; token_prefix?: string; person?: string; reason?: string },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  if (!input.token_id && !input.token_prefix && !input.person) {
    return envelope(plainConfidence([]), { revoked: 0 }, [
      {
        code: 'no_target',
        message: 'name a token_id, a token_prefix, or a person — nothing was written',
      },
    ]);
  }

  // NO JOIN TO people. An owner token has no person, and joining dropped it
  // from the result set entirely -- which meant the widest credential in the
  // system was the one link that could not be revoked. The person filter is a
  // subquery so it constrains only when it is actually asked for.
  const rows = await sql<Array<{ id: string; token_prefix: string }>>`
    update delegation_tokens d
       set revoked_at = now(), revoked_reason = ${input.reason ?? 'revoked by Tal'}
     where d.workspace_id = ${workspaceId} and d.revoked_at is null
       ${input.token_id ? sql`and d.id = ${input.token_id}` : sql``}
       ${input.token_prefix ? sql`and d.token_prefix = ${input.token_prefix}` : sql``}
       ${
         input.person
           ? sql`and d.person_id = (select id from people
                                     where workspace_id = ${workspaceId} and name = ${input.person})`
           : sql``
       }
     returning d.id, d.token_prefix`;

  return envelope(
    plainConfidence(
      rows.length === 0
        ? ['nothing matched, so nothing was revoked']
        : ['revocation is immediate: the next request on those links is refused'],
    ),
    { revoked: rows.length, tokens: rows.map((r) => r.token_prefix) },
  );
}

// ---------------------------------------------------------------------------
// owner_link — Tal's own page
// ---------------------------------------------------------------------------

/**
 * Mint the link to Tal's own page.
 *
 * Separate from delegate_link rather than another scope on it, because the two
 * are different decisions with different consequences and a shared tool would
 * make the wide one reachable by a typo. This one takes no person, and it says
 * plainly in its notes what it is handing over.
 */
export async function ownerLink(
  sql: Sql,
  input: { rotate?: boolean; grace_hours?: number; label?: string } = {},
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);

  const live = await sql<Array<{ id: string; token_prefix: string; created_at: Date }>>`
    select id, token_prefix, created_at from delegation_tokens
     where workspace_id = ${workspaceId} and scope = 'owner'
       and revoked_at is null and superseded_by is null`;

  if (live.length > 0 && !input.rotate) {
    return envelope(
      plainConfidence([
        'a link already exists and cannot be shown again — only its hash is stored',
        'pass rotate:true to replace it; the old one keeps working for the grace window',
      ]),
      {
        link: null,
        already_live: true,
        token_prefix: live[0]!.token_prefix,
        issued: live[0]!.created_at.toISOString().slice(0, 10),
      },
    );
  }

  const { raw, hash: tokenHash, prefix } = mint('owner');
  const id = randomUUID();

  await sql.begin(async (tx) => {
    if (live.length > 0) {
      const grace = Math.max(0, input.grace_hours ?? 24);
      await tx`
        update delegation_tokens
           set superseded_by = ${id},
               expires_at = now() + ${`${grace} hours`}::interval
         where id = ${live[0]!.id}`;
    }
    await tx`
      insert into delegation_tokens (id, workspace_id, person_id, scope, token_hash,
                                     token_prefix, label)
      values (${id}, ${workspaceId}, null, 'owner', ${tokenHash}, ${prefix},
              ${input.label ?? 'Tal own page'})`;
  });

  return envelope(
    plainConfidence([
      'THIS IS THE WIDEST CREDENTIAL IN THE SYSTEM: anyone holding it can read the whole portfolio',
      'it can mark work done and undo that within 15 minutes, and nothing else — it cannot kill, delete or edit',
      'shown exactly once; only its hash is stored, so it cannot be recovered — bookmark it now',
      'revoke it with revoke_delegation if it ends up anywhere it should not be',
    ]),
    { link: linkFor('owner', raw), rotated: live.length > 0, token_prefix: prefix },
  );
}
