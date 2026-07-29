-- TaskOS V1 — the four required database-level triggers, plus the D3 event
-- de-duplication guard. These live in the database, not in application code,
-- because the MCP server writes to these tables directly.

-- ---------------------------------------------------------------------------
-- "today" always resolves in settings.active_tz (D2). Nothing in the system is
-- allowed to use the server's local date.
-- ---------------------------------------------------------------------------
create or replace function taskos_today() returns date
language sql stable as $$
  select (now() at time zone (select active_tz from settings where id = 1))::date
$$;

-- ---------------------------------------------------------------------------
-- TRIGGER 1 — CYCLE PREVENTION
-- Edge (task_id -> blocks_task_id) means task_id must close before
-- blocks_task_id can proceed. The edge is illegal when blocks_task_id can
-- already reach task_id, because that closes a loop.
-- ---------------------------------------------------------------------------
create or replace function taskos_reject_dependency_cycle() returns trigger
language plpgsql as $$
declare
  cycle_path uuid[];
begin
  with recursive reach(node, path) as (
    -- Start at the far end of the proposed edge and walk forward. The path
    -- seed holds only visited nodes -- new.task_id must NOT be seeded into it,
    -- or the loop-detection step below prunes the one node we are looking for.
    select new.blocks_task_id, array[new.blocks_task_id]
    union all
    select d.blocks_task_id, r.path || d.blocks_task_id
    from task_dependencies d
    join reach r on d.task_id = r.node
    -- do not revisit a node: bounds the walk on any pre-existing loop
    where not d.blocks_task_id = any (r.path)
  )
  select new.task_id || path into cycle_path
  from reach
  where node = new.task_id
  limit 1;

  if cycle_path is not null then
    raise exception
      'dependency cycle rejected: edge % -> % closes the loop %',
      new.task_id, new.blocks_task_id, cycle_path
      using errcode = '23514',
            hint = 'break the chain before adding this edge';
  end if;

  return new;
end $$;

create trigger trg_task_dependencies_no_cycle
before insert or update on task_dependencies
for each row execute function taskos_reject_dependency_cycle();

-- ---------------------------------------------------------------------------
-- TRIGGER 2 — AUTO-UNBLOCK
-- When a task closes, any dependent whose blockers are ALL closed flips
-- blocked -> active. If the blocker was KILLED the dependent also gets a
-- needs_review event: it is not automatically still valid just because the
-- thing blocking it died.
-- ---------------------------------------------------------------------------
create or replace function taskos_auto_unblock() returns trigger
language plpgsql as $$
begin
  if new.status = 'killed' then
    insert into events (actor, verb, task_id, venture_id, payload)
    select 'system', 'needs_review', t.id, t.venture_id,
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

create trigger trg_tasks_auto_unblock
after update of status on tasks
for each row
when (new.status in ('done', 'killed')
      and old.status not in ('done', 'killed'))
execute function taskos_auto_unblock();

-- ---------------------------------------------------------------------------
-- TRIGGER 3 — MILESTONE EXPIRY
-- Daily-callable. Flips active -> missed for milestones whose due_date is in
-- the past in active_tz, and records why. Not scheduled here: V1 has no cron,
-- the MCP server calls this at the top of capacity().
-- ---------------------------------------------------------------------------
create or replace function taskos_expire_milestones() returns int
language plpgsql as $$
declare
  n int;
begin
  with expired as (
    update milestones
       set status = 'missed'
     where status = 'active'
       and due_date < taskos_today()
    returning id, venture_id, name, due_date
  ), logged as (
    insert into events (actor, verb, venture_id, payload)
    select 'system', 'milestone_missed', e.venture_id,
           jsonb_build_object('milestone_id', e.id,
                              'name', e.name,
                              'due_date', e.due_date)
    from expired e
    returning 1
  )
  select count(*) into n from expired;

  return n;
end $$;

-- ---------------------------------------------------------------------------
-- TRIGGER 4 — MOVEMENT
-- Closing a task is the only thing that counts as movement on its project.
-- ---------------------------------------------------------------------------
create or replace function taskos_touch_project_movement() returns trigger
language plpgsql as $$
begin
  if new.project_id is not null then
    update projects
       set last_movement_at = now()
     where id = new.project_id;
  end if;
  return null;
end $$;

create trigger trg_tasks_project_movement
after update of status on tasks
for each row
when (new.status in ('done', 'killed')
      and old.status not in ('done', 'killed'))
execute function taskos_touch_project_movement();

-- Stamp closed_at from the status transition so no writer can forget to.
create or replace function taskos_stamp_closed_at() returns trigger
language plpgsql as $$
begin
  if new.status in ('done', 'killed') and old.status not in ('done', 'killed') then
    new.closed_at := coalesce(new.closed_at, now());
  elsif new.status not in ('done', 'killed') then
    new.closed_at := null;
  end if;
  return new;
end $$;

create trigger trg_tasks_stamp_closed_at
before update of status on tasks
for each row execute function taskos_stamp_closed_at();

-- ---------------------------------------------------------------------------
-- D3 — reject identical (verb, task_id, actor) events inside 60 seconds.
-- Silently dropped rather than raised: this fires on system-written events
-- (needs_review) too, and a duplicate log line must never abort a task close.
-- Events carrying an explicit idempotency_key skip this path; the unique index
-- on that column is the stronger guarantee and the MCP layer catches it.
-- ---------------------------------------------------------------------------
create or replace function taskos_dedupe_events() returns trigger
language plpgsql as $$
begin
  if new.idempotency_key is not null then
    return new;
  end if;

  if exists (select 1
               from events e
              where e.verb = new.verb
                and e.actor = new.actor
                and e.task_id is not distinct from new.task_id
                and e.at > now() - interval '60 seconds') then
    return null;
  end if;

  return new;
end $$;

create trigger trg_events_dedupe
before insert on events
for each row execute function taskos_dedupe_events();
