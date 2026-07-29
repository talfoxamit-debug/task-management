import type {
  CalibrationRow,
  Dependency,
  Milestone,
  OutcomeTarget,
  Person,
  Project,
  Task,
  Venture,
} from '@taskos/engine';
import { daysSince } from '@taskos/engine';
import { loadSettings, today as dbToday, type Settings, type Sql } from './db.js';

/**
 * Loads a whole portfolio out of the database and into plain values the engine
 * can chew on. This is the only place rows are read for a computation, so there
 * is exactly one definition of "the portfolio as of today".
 */

export interface Portfolio {
  settings: Settings;
  today: string;
  ventures: Venture[];
  milestones: Milestone[];
  outcomeTargets: OutcomeTarget[];
  outcomeMilestones: Array<{ outcome_id: string; milestone_id: string }>;
  projects: Project[];
  people: Person[];
  tasks: Task[];
  dependencies: Dependency[];
  calibration: CalibrationRow[];
  /** Whole days of event history, for the D4 balance gate. Null when none. */
  daysOfEvents: number | null;
  /** Whole days since settings.started_at, for the D4 debt gate. */
  daysSinceStart: number | null;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

export async function loadPortfolio(sql: Sql): Promise<Portfolio> {
  const settings = await loadSettings(sql);
  const todayStr = await dbToday(sql);

  const [ventures, milestones, outcomeTargets, outcomeMilestones, projects, people, tasks, deps, calibration, firstEvent] =
    await Promise.all([
      sql<Array<Record<string, unknown>>>`
        select id, name, slug, strategic_weight, floor_share, ceiling_share,
               attention_debt_hours, current_bottleneck, active
          from ventures order by slug`,
      sql<Array<Record<string, unknown>>>`
        select id, venture_id, name, due_date::text as due_date, hardness,
               cost_of_slip, status
          from milestones order by due_date, name`,
      sql<Array<Record<string, unknown>>>`
        select id, venture_id, name, target_date::text as target_date, status,
               indicator_config
          from outcome_targets order by name`,
      sql<Array<Record<string, unknown>>>`
        select outcome_id, milestone_id from outcome_milestones`,
      sql<Array<Record<string, unknown>>>`
        select id, venture_id, milestone_id, name, outcome, status,
               last_movement_at
          from projects order by name`,
      sql<Array<Record<string, unknown>>>`select id, name, role from people order by name`,
      sql<Array<Record<string, unknown>>>`
        select id, project_id, venture_id, milestone_id, title, notes,
               criticality, context, energy, estimate_minutes, actual_minutes,
               actual_inferred, value, deadline_date::text as deadline_date,
               deadline_time::text as deadline_time,
               target_date::text as target_date, lead_time_days, status,
               kill_reason, snooze_count, snooze_reason, assignee_person_id,
               waiting_since, is_recurring, recurrence_rule, created_at,
               last_touched_at, closed_at
          from tasks
         where status not in ('done','killed')
            or closed_at > now() - interval '30 days'
         order by created_at`,
      sql<Array<Record<string, unknown>>>`
        select task_id, blocks_task_id from task_dependencies`,
      sql<Array<Record<string, unknown>>>`select context, ratio, sample_n from calibration`,
      sql<Array<{ at: Date }>>`select min(at) as at from events`,
    ]);

  const firstAt = firstEvent[0]?.at ?? null;

  return {
    settings,
    today: todayStr,
    ventures: ventures.map((v) => ({
      id: String(v['id']),
      name: String(v['name']),
      slug: String(v['slug']),
      strategic_weight: num(v['strategic_weight']),
      floor_share: num(v['floor_share']),
      ceiling_share: num(v['ceiling_share']),
      attention_debt_hours: num(v['attention_debt_hours']),
      active: Boolean(v['active']),
    })),
    milestones: milestones.map((m) => ({
      id: String(m['id']),
      venture_id: String(m['venture_id']),
      name: String(m['name']),
      due_date: String(m['due_date']),
      hardness: m['hardness'] as Milestone['hardness'],
      cost_of_slip: String(m['cost_of_slip']),
      status: m['status'] as Milestone['status'],
    })),
    outcomeTargets: outcomeTargets.map((o) => ({
      id: String(o['id']),
      venture_id: String(o['venture_id']),
      name: String(o['name']),
      target_date: o['target_date'] === null ? null : String(o['target_date']),
      status: o['status'] as OutcomeTarget['status'],
      indicator_config: (o['indicator_config'] ?? {}) as Record<string, unknown>,
    })),
    outcomeMilestones: outcomeMilestones.map((r) => ({
      outcome_id: String(r['outcome_id']),
      milestone_id: String(r['milestone_id']),
    })),
    projects: projects.map((p) => ({
      id: String(p['id']),
      venture_id: String(p['venture_id']),
      milestone_id: p['milestone_id'] === null ? null : String(p['milestone_id']),
      name: String(p['name']),
      status: p['status'] as Project['status'],
    })),
    people: people.map((p) => ({ id: String(p['id']), name: String(p['name']) })),
    tasks: tasks.map((t) => ({
      id: String(t['id']),
      venture_id: String(t['venture_id']),
      project_id: t['project_id'] === null ? null : String(t['project_id']),
      milestone_id: t['milestone_id'] === null ? null : String(t['milestone_id']),
      title: String(t['title']),
      criticality: t['criticality'] as Task['criticality'],
      context: t['context'] as Task['context'],
      energy: t['energy'] as Task['energy'],
      estimate_minutes: num(t['estimate_minutes']),
      value: num(t['value']),
      deadline_date: t['deadline_date'] === null ? null : String(t['deadline_date']),
      deadline_time: t['deadline_time'] === null ? null : String(t['deadline_time']),
      target_date: t['target_date'] === null ? null : String(t['target_date']),
      lead_time_days: num(t['lead_time_days']),
      status: t['status'] as Task['status'],
      snooze_count: num(t['snooze_count']),
      assignee_person_id:
        t['assignee_person_id'] === null ? null : String(t['assignee_person_id']),
      is_recurring: Boolean(t['is_recurring']),
      recurrence_rule: t['recurrence_rule'] === null ? null : String(t['recurrence_rule']),
    })),
    dependencies: deps.map((d) => ({
      task_id: String(d['task_id']),
      blocks_task_id: String(d['blocks_task_id']),
    })),
    calibration: calibration.map((c) => ({
      context: String(c['context']),
      ratio: num(c['ratio']),
      sample_n: num(c['sample_n']),
    })) as CalibrationRow[],
    daysOfEvents:
      firstAt === null ? null : daysSince(firstAt.toISOString(), todayStr, settings.active_tz),
    daysSinceStart: daysSince(settings.started_at, todayStr, settings.active_tz),
  };
}
