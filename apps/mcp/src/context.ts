import { resolveWorkspaceId, loadSettings, today as todayFor, type Sql } from './db.js';
import { loadPortfolio } from './load.js';
import { runCapacity, runEngine } from './pipeline.js';
import { envelope, plainConfidence, r1, r3, type ToolEnvelope } from './narrow.js';

/**
 * The whole situation, in one call, at the start of a session.
 *
 * The problem this solves is not a missing capability — every number here was
 * already reachable. It is that reaching it took six calls and a conversation,
 * so every session began by rebuilding the same picture from scratch: which
 * ventures exist, who works on what, how many hours there are, what is already
 * behind. Tal ends up teaching the system instead of being helped by it.
 *
 * So this is deliberately a READ of everything at once rather than a summary of
 * anything. It answers "what am I looking at" before the conversation starts,
 * and it says plainly which parts are unknown rather than filling them in.
 */
export async function getContext(
  sql: Sql,
  input: { available_hours?: number },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const settings = await loadSettings(sql, workspaceId);
  const today = await todayFor(sql, workspaceId);

  const defaults = await sql<Array<{ h: string | null }>>`
    select default_weekly_hours::text as h from settings where workspace_id = ${workspaceId}`;
  const rememberedHours = defaults[0]?.h == null ? null : Number(defaults[0].h);

  // The hours are the entire input to the answer, so an invented number would
  // produce a confident answer to a question nobody asked. Stated > remembered
  // > absent, and the absence is reported rather than filled.
  const hours = input.available_hours ?? rememberedHours ?? null;

  const portfolio = await loadPortfolio(sql, workspaceId);
  const pipeline = runEngine(portfolio);
  const capacity = hours === null ? null : runCapacity(portfolio, pipeline, hours);

  const ventures = portfolio.ventures
    .filter((v) => v.active)
    .map((v) => ({
      slug: v.slug,
      name: v.name,
      weight: v.strategic_weight,
      floor: v.floor_share,
      ceiling: v.ceiling_share,
      share: capacity ? r3(capacity.shareByVenture[v.id] ?? 0) : null,
      hours_per_week: capacity ? r1(capacity.allocatedHoursByVenture[v.id] ?? 0) : null,
      required_hours_per_week: r1(pipeline.demand.requiredByVenture[v.id] ?? 0),
    }))
    .sort((a, b) => b.weight - a.weight);

  const people = await sql<
    Array<{
      name: string;
      role: string | null;
      hours_per_week: string | null;
      open_tasks: number;
      assigned_minutes: number;
      blocked: number;
    }>
  >`
    select p.name, p.role, p.hours_per_week::text as hours_per_week,
           count(t.id) filter (where t.status not in ('done','killed'))::int as open_tasks,
           coalesce(sum(t.estimate_minutes) filter
             (where t.status not in ('done','killed')), 0)::int as assigned_minutes,
           count(t.id) filter (where t.needs_attention_at is not null
                                 and t.status not in ('done','killed'))::int as blocked
      from people p
      left join tasks t on t.assignee_person_id = p.id and t.workspace_id = p.workspace_id
     where p.workspace_id = ${workspaceId} and p.active
     group by p.id, p.name, p.role, p.hours_per_week
     order by p.hours_per_week desc nulls last, p.name`;

  const ventureById = new Map(portfolio.ventures.map((v) => [v.id, v]));
  const milestones = portfolio.milestones
    .filter((m) => m.status === 'active')
    .map((m) => {
      const detail = pipeline.demand.milestoneDetail.find((d) => d.milestone_id === m.id);
      const venture = ventureById.get(m.venture_id);
      return {
        id: m.id,
        name: m.name,
        venture: venture?.slug ?? '—',
        venture_active: venture?.active ?? false,
        due_date: m.due_date,
        hardness: m.hardness,
        cost_of_slip: m.cost_of_slip,
        slack_days: pipeline.slack.minSlackByMilestone[m.id] ?? null,
        coverage: pipeline.coverage.byMilestone[m.id] ?? null,
        coverage_trusted: !pipeline.coverage.lowConfidence.includes(m.id),
        required_hours_per_week: r1(detail?.requiredHours ?? 0),
        attached_tasks: portfolio.tasks.filter((t) => t.milestone_id === m.id).length,
      };
    })
    .sort((a, b) => (a.slack_days ?? 1e9) - (b.slack_days ?? 1e9));

  const counts = await sql<
    Array<{ inbox: number; active: number; blocked: number; triage: number; unread: number }>
  >`
    select
      count(*) filter (where status = 'inbox')::int as inbox,
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'blocked')::int as blocked,
      count(*) filter (where snooze_count >= 3 and status not in ('done','killed'))::int as triage,
      (select count(*) from task_comments c
        where c.workspace_id = ${workspaceId}
          and c.author_kind = 'delegate' and c.read_by_owner_at is null)::int as unread
      from tasks where workspace_id = ${workspaceId}`;

  const dayRows = await sql<
    Array<{ day_of_week: number; slug: string | null; flex_minutes: number; is_working_day: boolean }>
  >`
    select a.day_of_week, v.slug, a.flex_minutes, a.is_working_day
      from day_allocation a
      left join ventures v on v.id = a.primary_venture_id
     where a.workspace_id = ${workspaceId}
     order by a.day_of_week`;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Everything the system genuinely does not know, said once, so the session
  // does not have to discover each gap by tripping over it.
  const unknown: string[] = [];
  if (hours === null) {
    unknown.push(
      'how many hours are available this week — ASK, and consider storing a normal week so it is remembered',
    );
  }
  if (people.length === 0) unknown.push('who work can be delegated to (create_person)');
  for (const p of people) {
    if (p.hours_per_week === null) unknown.push(`${p.name}'s working week is unstated`);
  }
  const orphaned = milestones.filter((m) => !m.venture_active);
  for (const m of orphaned) {
    unknown.push(
      `"${m.name}" belongs to an inactive venture, so its demand is silently not counted`,
    );
  }
  if (dayRows.length === 0) {
    unknown.push(
      'which venture owns which day — set_day_allocation, or every day treats every venture equally',
    );
  }
  const bare = milestones.filter((m) => m.attached_tasks === 0);
  for (const m of bare) {
    unknown.push(`"${m.name}" has no tasks attached, so it has no critical path and no slack`);
  }

  // With no hours stated the engine still ran, but capacity did not, so there
  // is no confidence object from it. Build one from what the engine did say
  // rather than reporting nothing.
  const confidence = capacity
    ? capacity.confidence
    : plainConfidence([
        ...pipeline.coverage.lowConfidence.map(
          (id) =>
            `${milestones.find((m) => m.id === id)?.name ?? id}: dependency coverage is below 60%, so its slack is not trusted`,
        ),
        'no hours were given, so the week was not computed — only what is on file',
      ]);
  confidence.notes.unshift(
    'this is the whole situation as the system knows it; anything in `unknown` has not been told to it and must not be assumed',
  );

  return envelope(
    confidence,
    {
      today,
      timezone: settings.active_tz,
      buffer_ratio: settings.buffer_ratio,
      week: {
        available_hours: hours,
        source:
          input.available_hours !== undefined
            ? 'you just said so'
            : rememberedHours !== null
              ? 'a normal week on record'
              : 'unknown — ask',
        ...(capacity
          ? {
              recurring_overhead: r1(capacity.recurringHours),
              usable: r1(capacity.usableHours),
              required: r1(capacity.requiredHours),
              verdict: capacity.verdict,
              deficit: r1(capacity.deficitHours),
            }
          : {}),
      },
      day_allocation: dayRows.map((d) => ({
        day_of_week: d.day_of_week,
        day: DAY_NAMES[d.day_of_week],
        primary_venture: d.slug,
        flex_minutes: d.flex_minutes,
        is_working_day: d.is_working_day,
      })),
      ventures,
      people: people.map((p) => ({
        name: p.name,
        role: p.role,
        hours_per_week: p.hours_per_week === null ? null : Number(p.hours_per_week),
        open_tasks: p.open_tasks,
        assigned_hours: r1(p.assigned_minutes / 60),
        blocked_on_you: p.blocked,
      })),
      // The delegated capacity behind the bottleneck: the number that says how
      // much of the week could move off Tal at all.
      delegated_capacity_hours: r1(
        people.reduce((s, p) => s + (p.hours_per_week === null ? 0 : Number(p.hours_per_week)), 0),
      ),
      milestones,
      slip_order: capacity
        ? capacity.slipCandidates.slice(0, 5).map((c) => ({
            milestone: c.name,
            hardness: c.hardness,
            cost_of_slip: c.cost_of_slip,
            frees_hours_per_week: r1(c.hoursFreed),
            clears_deficit: c.clearsDeficit,
          }))
        : [],
      inbox: counts[0]!.inbox,
      active: counts[0]!.active,
      blocked: counts[0]!.blocked,
      needs_triage: counts[0]!.triage,
      unread_delegate_comments: counts[0]!.unread,
      unknown,
    },
    [],
  );
}
