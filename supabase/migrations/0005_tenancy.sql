-- TaskOS — multi-user groundwork: workspaces, tenancy columns, and RLS.
--
-- Everything that exists today becomes one workspace owned by the first member.
-- No row moves and no id changes, so the MCP server keeps working throughout.
--
-- Two singletons have to stop being singletons, and they are the reason this
-- migration is worth doing before a UI rather than after:
--
--   settings    was `check (id = 1)`. active_tz and buffer_ratio are per-person
--               values, and every day boundary in the system resolves through
--               them. This is the only place single-tenancy was baked into a
--               CONSTRAINT rather than an absent column.
--   calibration was keyed on context alone, so one person's "deep_work runs
--               40% long" would become everybody's.

begin;

-- ---------------------------------------------------------------------------
-- Workspaces and membership
-- ---------------------------------------------------------------------------
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  -- References auth.users(id) in Supabase. The foreign key is added
  -- conditionally at the end of this file: the auth schema does not exist in a
  -- bare Postgres, and the test suite runs against exactly that.
  user_id uuid not null,
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on workspace_members (user_id);

-- ---------------------------------------------------------------------------
-- Tenancy columns
--
-- workspace_id is denormalised onto every table rather than reached through
-- ventures. An RLS policy that has to join to find its owner is both slow and
-- easy to get subtly wrong, and "slow" here means on every single row read.
-- ---------------------------------------------------------------------------
alter table ventures         add column workspace_id uuid references workspaces(id) on delete cascade;
alter table milestones       add column workspace_id uuid references workspaces(id) on delete cascade;
alter table outcome_targets  add column workspace_id uuid references workspaces(id) on delete cascade;
alter table projects         add column workspace_id uuid references workspaces(id) on delete cascade;
alter table people           add column workspace_id uuid references workspaces(id) on delete cascade;
alter table tasks            add column workspace_id uuid references workspaces(id) on delete cascade;
alter table events           add column workspace_id uuid references workspaces(id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Backfill: everything that exists now belongs to one workspace
-- ---------------------------------------------------------------------------
insert into workspaces (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Fox Solutions');

update ventures        set workspace_id = '00000000-0000-0000-0000-000000000001';
update milestones      set workspace_id = '00000000-0000-0000-0000-000000000001';
update outcome_targets set workspace_id = '00000000-0000-0000-0000-000000000001';
update projects        set workspace_id = '00000000-0000-0000-0000-000000000001';
update people          set workspace_id = '00000000-0000-0000-0000-000000000001';
update tasks           set workspace_id = '00000000-0000-0000-0000-000000000001';
update events          set workspace_id = '00000000-0000-0000-0000-000000000001';

alter table ventures         alter column workspace_id set not null;
alter table milestones       alter column workspace_id set not null;
alter table outcome_targets  alter column workspace_id set not null;
alter table projects         alter column workspace_id set not null;
alter table people           alter column workspace_id set not null;
alter table tasks            alter column workspace_id set not null;
-- events.workspace_id stays nullable: on delete set null on task_id and
-- venture_id already means an event can outlive its subject, and an audit row
-- with a dangling tenant is better than one silently deleted.

-- A venture's slug is unique per workspace now, not globally: two people may
-- both have a venture called "consulting".
alter table ventures drop constraint ventures_slug_key;
create unique index ventures_workspace_slug_key on ventures (workspace_id, slug);

create index ventures_workspace_idx        on ventures (workspace_id);
create index milestones_workspace_idx      on milestones (workspace_id);
create index outcome_targets_workspace_idx on outcome_targets (workspace_id);
create index projects_workspace_idx        on projects (workspace_id);
create index people_workspace_idx          on people (workspace_id);
create index tasks_workspace_status_idx    on tasks (workspace_id, status);
create index events_workspace_at_idx       on events (workspace_id, at desc);

-- ---------------------------------------------------------------------------
-- settings: one row per workspace, no longer a singleton
-- ---------------------------------------------------------------------------
alter table settings add column workspace_id uuid references workspaces(id) on delete cascade;
update settings set workspace_id = '00000000-0000-0000-0000-000000000001' where id = 1;
alter table settings alter column workspace_id set not null;

alter table settings drop constraint settings_pkey;
alter table settings drop constraint settings_id_check;
alter table settings drop column id;
alter table settings add primary key (workspace_id);

-- ---------------------------------------------------------------------------
-- calibration: keyed per workspace and context
-- ---------------------------------------------------------------------------
alter table calibration add column workspace_id uuid references workspaces(id) on delete cascade;
update calibration set workspace_id = '00000000-0000-0000-0000-000000000001';
alter table calibration alter column workspace_id set not null;
alter table calibration drop constraint calibration_pkey;
alter table calibration add primary key (workspace_id, context);

-- ---------------------------------------------------------------------------
-- taskos_today() is per-workspace now
--
-- The old no-argument form is kept, resolving against the single workspace when
-- there is exactly one and falling back to America/New_York otherwise, because
-- taskos_expire_milestones() and the trigger tests call it. It raises rather
-- than guessing once a second workspace exists.
-- ---------------------------------------------------------------------------
create or replace function taskos_today(p_workspace uuid) returns date
language sql stable as $$
  select (now() at time zone coalesce(
    (select active_tz from settings where workspace_id = p_workspace),
    'America/New_York'))::date
$$;

create or replace function taskos_today() returns date
language plpgsql stable as $$
declare
  n int;
  ws uuid;
begin
  -- No min(uuid) aggregate exists in Postgres, so the single row is taken
  -- directly rather than aggregated.
  select count(*) into n from settings;
  if n = 1 then
    select workspace_id into ws from settings limit 1;
    return taskos_today(ws);
  elsif n = 0 then
    return (now() at time zone 'America/New_York')::date;
  else
    raise exception 'taskos_today() is ambiguous with % workspaces: pass one', n;
  end if;
end $$;

-- Milestone expiry resolves "today" in each workspace's own timezone.
create or replace function taskos_expire_milestones() returns int
language plpgsql as $$
declare
  n int;
begin
  with expired as (
    update milestones m
       set status = 'missed'
     where m.status = 'active'
       and m.due_date < taskos_today(m.workspace_id)
    returning m.id, m.venture_id, m.workspace_id, m.name, m.due_date
  ), logged as (
    insert into events (actor, verb, venture_id, workspace_id, payload)
    select 'system', 'milestone_missed', e.venture_id, e.workspace_id,
           jsonb_build_object('milestone_id', e.id,
                              'name', e.name,
                              'due_date', e.due_date)
    from expired e
    returning 1
  )
  select count(*) into n from expired;

  return n;
end $$;

-- needs_review events inherit the dependent's workspace.
create or replace function taskos_auto_unblock() returns trigger
language plpgsql as $$
begin
  if new.status = 'killed' then
    insert into events (actor, verb, task_id, venture_id, workspace_id, payload)
    select 'system', 'needs_review', t.id, t.venture_id, t.workspace_id,
           jsonb_build_object(
             'killed_blocker_id', new.id,
             'killed_blocker_title', new.title,
             'kill_reason', new.kill_reason)
    from task_dependencies d
    join tasks t on t.id = d.blocks_task_id
    where d.task_id = new.id
      and t.status not in ('done', 'killed');
  end if;

  update tasks t
     set status = 'active',
         last_touched_at = now()
   where t.status = 'blocked'
     and t.id in (select d.blocks_task_id
                    from task_dependencies d
                   where d.task_id = new.id)
     and not exists (select 1
                       from task_dependencies d2
                       join tasks b on b.id = d2.task_id
                      where d2.blocks_task_id = t.id
                        and b.status not in ('done', 'killed'));

  return null;
end $$;

-- A dependency edge may never cross a workspace boundary. The cycle walk
-- already refuses loops; this refuses the other way of corrupting a graph.
create or replace function taskos_reject_cross_workspace_dependency() returns trigger
language plpgsql as $$
declare
  a uuid;
  b uuid;
begin
  select workspace_id into a from tasks where id = new.task_id;
  select workspace_id into b from tasks where id = new.blocks_task_id;
  if a is distinct from b then
    raise exception 'dependency crosses a workspace boundary: % and %',
      new.task_id, new.blocks_task_id
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger trg_task_dependencies_same_workspace
before insert or update on task_dependencies
for each row execute function taskos_reject_cross_workspace_dependency();

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- This is the point of the whole migration. Isolation lives in Postgres, not in
-- application code: a forgotten `where workspace_id = ...` in a tool handler
-- then returns nothing instead of somebody else's tasks.
--
-- The MCP server connects as the table owner and is NOT subject to these
-- policies; it scopes by workspace in application code. The UI connects with a
-- user's JWT through PostgREST and IS subject to them. That asymmetry is
-- deliberate: the server is trusted code under test, the browser is not.
-- ---------------------------------------------------------------------------
-- auth.uid() is provided by Supabase. A bare Postgres has no auth schema, and
-- the integration tests run against exactly that, so a stub is created when it
-- is absent. It returns null, which makes every policy deny -- the safe
-- direction, and irrelevant to the tests, which connect as the table owner and
-- bypass RLS anyway.
do $$
begin
  if not exists (select 1 from information_schema.routines
                  where routine_schema = 'auth' and routine_name = 'uid') then
    create schema if not exists auth;
    execute 'create function auth.uid() returns uuid language sql stable as ''select null::uuid''';
  end if;
end $$;

create or replace function taskos_is_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members
     where workspace_id = p_workspace
       and user_id = auth.uid()
  )
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'ventures', 'milestones', 'outcome_targets', 'projects',
    'people', 'tasks', 'events', 'settings', 'calibration'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format($f$
      create policy taskos_member_all on %I
        for all
        using (taskos_is_member(workspace_id))
        with check (taskos_is_member(workspace_id))
    $f$, t);
  end loop;
end $$;

alter table workspaces enable row level security;
create policy taskos_workspace_member on workspaces
  for all using (taskos_is_member(id)) with check (taskos_is_member(id));

alter table workspace_members enable row level security;
create policy taskos_own_membership on workspace_members
  for select using (user_id = auth.uid() or taskos_is_member(workspace_id));

-- Join tables reach their tenant through their parents.
alter table task_dependencies enable row level security;
create policy taskos_dep_member on task_dependencies
  for all
  using (exists (select 1 from tasks t
                  where t.id = task_dependencies.task_id
                    and taskos_is_member(t.workspace_id)))
  with check (exists (select 1 from tasks t
                       where t.id = task_dependencies.task_id
                         and taskos_is_member(t.workspace_id)));

alter table outcome_milestones enable row level security;
create policy taskos_outcome_link_member on outcome_milestones
  for all
  using (exists (select 1 from outcome_targets o
                  where o.id = outcome_milestones.outcome_id
                    and taskos_is_member(o.workspace_id)))
  with check (exists (select 1 from outcome_targets o
                       where o.id = outcome_milestones.outcome_id
                         and taskos_is_member(o.workspace_id)));

-- ---------------------------------------------------------------------------
-- Supabase-only wiring, skipped on a bare Postgres so the tests can run.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'auth' and table_name = 'users') then
    alter table workspace_members
      add constraint workspace_members_user_fk
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

commit;
