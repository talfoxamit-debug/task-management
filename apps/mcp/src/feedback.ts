import { resolveWorkspaceId, type Sql } from './db.js';
import { envelope, narrow, plainConfidence, type ToolEnvelope } from './narrow.js';

/**
 * A channel back to the person who builds this.
 *
 * Tal writes TaskOS. The agents using it are the ones who meet its edges — a
 * tool that cannot express what the conversation needs, a reply that answers
 * the wrong question, a failure with no way to report itself. Before this,
 * every one of those observations died with the conversation.
 *
 * TWO THINGS KEEP IT USEFUL RATHER THAN NOISE.
 *
 * First, it is not a task. Feedback about the tool never enters the portfolio,
 * takes a share of the week, or appears in a slip ranking. Filing it as work
 * would corrupt the one question this system exists to answer.
 *
 * Second, re-reporting increments a counter instead of creating a duplicate.
 * A unique index on the title makes that automatic, so an agent that hits the
 * same wall in three separate conversations produces one row with occurrences:3
 * — which is far better evidence than three rows, and cannot be gamed by an
 * eager reporter.
 */

export interface SuggestInput {
  kind: 'bug' | 'feature' | 'improvement' | 'friction' | 'question';
  title: string;
  detail: string;
  trigger_context?: string;
  severity?: 'blocking' | 'high' | 'medium' | 'low';
  reported_from?: string;
}

export async function suggestImprovement(sql: Sql, input: SuggestInput): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);

  const rows = await sql<
    Array<{ id: string; occurrences: number; status: string; created_at: Date }>
  >`
    insert into feedback (workspace_id, kind, title, detail, trigger_context,
                          severity, source, reported_from)
    values (${workspaceId}, ${input.kind}, ${input.title}, ${input.detail},
            ${input.trigger_context ?? null}, ${input.severity ?? 'medium'},
            'agent', ${input.reported_from ?? null})
    on conflict (workspace_id, lower(title)) do update
      set occurrences = feedback.occurrences + 1,
          last_seen_at = now(),
          -- A repeat report of something already dismissed reopens it: being
          -- hit again is new evidence, and silently swallowing it would hide
          -- exactly the recurring problems most worth fixing.
          status = case when feedback.status = 'declined' then 'open' else feedback.status end,
          -- Keep the worst severity ever reported rather than the latest.
          severity = case
            when ${input.severity ?? 'medium'} = 'blocking' then 'blocking'
            when feedback.severity = 'blocking' then 'blocking'
            when ${input.severity ?? 'medium'} = 'high' or feedback.severity = 'high' then 'high'
            else feedback.severity
          end
    returning id, occurrences, status, created_at
  `;

  const row = rows[0]!;
  const repeat = row.occurrences > 1;

  return envelope(
    plainConfidence([
      repeat
        ? `already reported; this is occurrence ${row.occurrences}, which raises its weight rather than duplicating it`
        : 'filed for Tal, who builds this system',
      'this is NOT a task: it takes no share of the week and drives no demand',
    ]),
    {
      filed: true,
      id: row.id,
      occurrences: row.occurrences,
      status: row.status,
      note: repeat
        ? 'Tell Tal it came up again rather than presenting it as new.'
        : 'Mention it to Tal in passing — do not derail what he asked for.',
    },
  );
}

export interface ListSuggestionsInput {
  status?: 'open' | 'planned' | 'done' | 'declined';
  kind?: SuggestInput['kind'];
}

export async function listSuggestions(
  sql: Sql,
  input: ListSuggestionsInput,
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const status = input.status ?? 'open';

  const rows = await sql<
    Array<{
      id: string;
      kind: string;
      title: string;
      detail: string;
      trigger_context: string | null;
      severity: string;
      status: string;
      occurrences: number;
      created_at: Date;
      last_seen_at: Date;
    }>
  >`
    select id, kind, title, detail, trigger_context, severity, status,
           occurrences, created_at, last_seen_at
      from feedback
     where workspace_id = ${workspaceId}
       and status = ${status}
       ${input.kind ? sql`and kind = ${input.kind}` : sql``}
     order by
       case severity when 'blocking' then 0 when 'high' then 1
                     when 'medium' then 2 else 3 end,
       occurrences desc,
       created_at desc
  `;

  const list = narrow(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      detail: r.detail,
      why_it_came_up: r.trigger_context,
      severity: r.severity,
      occurrences: r.occurrences,
      first_reported: r.created_at.toISOString().slice(0, 10),
      last_seen: r.last_seen_at.toISOString().slice(0, 10),
    })),
  );

  return envelope(plainConfidence(rows.length === 0 ? [`nothing ${status}`] : []), {
    suggestions: list.items,
    total: list.total,
    ...(list.truncated ? { truncated: list.truncated } : {}),
  });
}

export interface ResolveSuggestionInput {
  id: string;
  status: 'open' | 'planned' | 'done' | 'declined';
  note?: string;
}

/** Tal's side of the loop: mark something planned, built, or not happening. */
export async function resolveSuggestion(
  sql: Sql,
  input: ResolveSuggestionInput,
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const rows = await sql<Array<{ id: string; title: string; status: string }>>`
    update feedback
       set status = ${input.status},
           resolution_note = coalesce(${input.note ?? null}, resolution_note),
           resolved_at = case when ${input.status} in ('done', 'declined') then now() else null end
     where workspace_id = ${workspaceId} and id = ${input.id}
     returning id, title, status
  `;
  const row = rows[0];
  if (!row) {
    return envelope(plainConfidence([]), { updated: false }, [
      { code: 'not_found', message: `no suggestion ${input.id} in this workspace` },
    ]);
  }
  return envelope(plainConfidence([]), { updated: true, ...row });
}
