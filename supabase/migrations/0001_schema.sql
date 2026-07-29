-- TaskOS V1 — Part 3 schema.
--
-- Conventions that are load-bearing elsewhere in the system:
--   * every timestamp is timestamptz, never bare timestamp (D2)
--   * deadlines are (date, nullable time), never a midnight timestamp (D2)
--   * settings.active_tz is the single source of truth for day/week boundaries

create extension if not exists pgcrypto;

create table settings (
  id int primary key default 1 check (id = 1),
  active_tz text not null default 'America/New_York',
  buffer_ratio numeric not null default 0.20,
  started_at timestamptz not null default now()
);

create table ventures (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  strategic_weight numeric not null default 1.0
    check (strategic_weight between 0.3 and 2.0),
  floor_share numeric not null default 0.05
    check (floor_share between 0 and 0.5),
  ceiling_share numeric not null default 0.60
    check (ceiling_share between 0.1 and 1.0),
  current_bottleneck text,
  attention_debt_hours numeric not null default 0,
  active boolean not null default true,
  check (floor_share < ceiling_share)
);

-- A milestone is an event Tal controls. It has a critical path and it DRIVES
-- DEMAND. Contrast outcome_targets below (D1).
create table milestones (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid not null references ventures(id) on delete cascade,
  name text not null,
  due_date date not null,
  hardness text not null check (hardness in ('hard','soft')),
  cost_of_slip text not null,
  status text not null default 'active'
    check (status in ('active','hit','missed','dropped')),
  confirmed_at timestamptz
);

-- An outcome target is a result someone else decides. No critical path, never
-- drives demand, never gets slack computed (D1).
create table outcome_targets (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid not null references ventures(id) on delete cascade,
  name text not null,
  target_date date,
  status text not null default 'open'
    check (status in ('open','achieved','abandoned')),
  indicator_config jsonb not null default '{}'::jsonb
);

create table outcome_milestones (
  outcome_id uuid references outcome_targets(id) on delete cascade,
  milestone_id uuid references milestones(id) on delete cascade,
  primary key (outcome_id, milestone_id)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid not null references ventures(id) on delete cascade,
  milestone_id uuid references milestones(id) on delete set null,
  name text not null,
  outcome text not null,
  status text not null default 'active'
    check (status in ('active','paused','done','killed')),
  last_movement_at timestamptz default now()
);

create table people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text,
  asana_gid text
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,
  venture_id uuid not null references ventures(id) on delete cascade,
  milestone_id uuid references milestones(id) on delete set null,
  title text not null,
  notes text,
  criticality text not null default 'supporting'
    check (criticality in ('blocking','enabling','supporting','optional')),
  context text not null default 'admin'
    check (context in ('deep_work','calls','admin','errands',
                       'creative','review','physical')),
  energy text not null default 'medium'
    check (energy in ('high','medium','low')),
  estimate_minutes int not null check (estimate_minutes > 0),
  actual_minutes int check (actual_minutes > 0),
  actual_inferred boolean not null default true,
  value int not null default 5 check (value between 1 and 10),
  deadline_date date,
  deadline_time time,
  target_date date,
  lead_time_days int not null default 3 check (lead_time_days > 0),
  status text not null default 'inbox'
    check (status in ('inbox','active','blocked','waiting',
                      'parked','done','killed')),
  kill_reason text,
  snooze_count int not null default 0,
  snooze_reason text,
  assignee_person_id uuid references people(id),
  waiting_since timestamptz,
  is_recurring boolean not null default false,
  recurrence_rule text,
  created_at timestamptz not null default now(),
  last_touched_at timestamptz not null default now(),
  closed_at timestamptz,
  check (status <> 'killed' or kill_reason is not null),
  check (not is_recurring or recurrence_rule is not null)
);

-- Edge semantics: task_id must be closed before blocks_task_id can proceed.
create table task_dependencies (
  task_id uuid references tasks(id) on delete cascade,
  blocks_task_id uuid references tasks(id) on delete cascade,
  primary key (task_id, blocks_task_id),
  check (task_id <> blocks_task_id)
);

create table events (
  id bigserial primary key,
  actor text not null,
  verb text not null,
  task_id uuid references tasks(id) on delete set null,
  venture_id uuid references ventures(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  at timestamptz not null default now()
);

create table calibration (
  context text primary key,
  ratio numeric not null default 1.0,
  sample_n int not null default 0
);

-- Read paths: the engine loads whole open sets per venture/milestone, the MCP
-- tools filter by status and by inbox.
create index tasks_venture_status_idx on tasks (venture_id, status);
create index tasks_milestone_idx on tasks (milestone_id) where milestone_id is not null;
create index tasks_project_idx on tasks (project_id) where project_id is not null;
create index tasks_inbox_idx on tasks (created_at) where status = 'inbox';
create index task_dependencies_blocks_idx on task_dependencies (blocks_task_id);
create index milestones_venture_status_idx on milestones (venture_id, status);
create index outcome_targets_venture_idx on outcome_targets (venture_id);
create index events_at_idx on events (at desc);
-- Supports the 60-second (verb, task_id, actor) duplicate rejection in D3.
create index events_dedupe_idx on events (verb, task_id, actor, at desc);

insert into settings (id) values (1) on conflict (id) do nothing;
