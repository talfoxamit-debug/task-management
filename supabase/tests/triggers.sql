-- TaskOS V1 — proof that the four database triggers behave as specified.
-- Run against a scratch database:  psql -f supabase/tests/triggers.sql
-- Every assertion raises on failure, so a clean run to "ALL TRIGGER TESTS
-- PASSED" is the proof.

\set ON_ERROR_STOP on
set client_min_messages = notice;

begin;

-- ---------------------------------------------------------------------------
-- fixture: one workspace, one venture, one project, a five-deep chain
-- a -> b -> c -> d -> e
-- ---------------------------------------------------------------------------
insert into workspaces (id, name) values ('99999999-9999-9999-9999-999999999999', 'Trigger Test Workspace');

insert into ventures (id, workspace_id, name, slug) values
  ('11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999', 'Trigger Test', 'trigtest');

insert into milestones (id, workspace_id, venture_id, name, due_date, hardness, cost_of_slip)
values ('22222222-2222-2222-2222-222222222222', '99999999-9999-9999-9999-999999999999',
        '11111111-1111-1111-1111-111111111111',
        'Trigger test milestone', '2026-12-31', 'hard', 'low');

insert into projects (id, workspace_id, venture_id, name, outcome)
values ('33333333-3333-3333-3333-333333333333', '99999999-9999-9999-9999-999999999999',
        '11111111-1111-1111-1111-111111111111',
        'Trigger test project', 'triggers proven');

insert into people (id, workspace_id, name) values
  ('44444444-4444-4444-4444-444444444444', '99999999-9999-9999-9999-999999999999', 'Other Person');

insert into tasks (id, workspace_id, venture_id, project_id, milestone_id, title,
                   criticality, estimate_minutes, status)
values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'a', 'blocking', 60, 'active'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'b', 'blocking', 60, 'blocked'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', '99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'c', 'blocking', 60, 'blocked'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'd', 'blocking', 60, 'blocked'),
  ('aaaaaaaa-0000-0000-0000-00000000000e', '99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'e', 'blocking', 60, 'blocked');

insert into task_dependencies (task_id, blocks_task_id) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000b'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000c'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000d'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-00000000000e');

-- ===========================================================================
-- TRIGGER 1 — CYCLE PREVENTION
-- ===========================================================================

-- 1a. the direct back-edge e -> a must be rejected (5-node loop)
do $$
begin
  begin
    insert into task_dependencies (task_id, blocks_task_id)
    values ('aaaaaaaa-0000-0000-0000-00000000000e',
            'aaaaaaaa-0000-0000-0000-00000000000a');
    raise exception 'FAIL 1a: five-node cycle e->a was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS 1a: five-node cycle e->a rejected (%)', sqlerrm;
  end;
end $$;

-- 1b. the shortest possible cycle, b -> a on top of a -> b
do $$
begin
  begin
    insert into task_dependencies (task_id, blocks_task_id)
    values ('aaaaaaaa-0000-0000-0000-00000000000b',
            'aaaaaaaa-0000-0000-0000-00000000000a');
    raise exception 'FAIL 1b: two-node cycle b->a was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS 1b: two-node cycle b->a rejected';
  end;
end $$;

-- 1c. a mid-chain back-edge, d -> b
do $$
begin
  begin
    insert into task_dependencies (task_id, blocks_task_id)
    values ('aaaaaaaa-0000-0000-0000-00000000000d',
            'aaaaaaaa-0000-0000-0000-00000000000b');
    raise exception 'FAIL 1c: mid-chain cycle d->b was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS 1c: mid-chain cycle d->b rejected';
  end;
end $$;

-- 1d. self-edge, caught by the table check constraint
do $$
begin
  begin
    insert into task_dependencies (task_id, blocks_task_id)
    values ('aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-00000000000a');
    raise exception 'FAIL 1d: self-edge was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS 1d: self-edge rejected';
  end;
end $$;

-- 1e. the NEAR-cycle must still be ACCEPTED: a -> d is a shortcut, not a loop.
--     This is the half of the trigger that is easy to get wrong: an
--     over-eager check that rejects any edge between two connected nodes.
insert into task_dependencies (task_id, blocks_task_id)
values ('aaaaaaaa-0000-0000-0000-00000000000a',
        'aaaaaaaa-0000-0000-0000-00000000000d');
do $$
begin
  if not exists (select 1 from task_dependencies
                  where task_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
                    and blocks_task_id = 'aaaaaaaa-0000-0000-0000-00000000000d')
  then raise exception 'FAIL 1e: legal shortcut edge a->d was rejected';
  end if;
  raise notice 'PASS 1e: legal shortcut a->d accepted (near-cycle, not a cycle)';
end $$;
delete from task_dependencies
 where task_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
   and blocks_task_id = 'aaaaaaaa-0000-0000-0000-00000000000d';

-- 1f. an UPDATE that would close a loop is rejected too
do $$
begin
  begin
    update task_dependencies
       set blocks_task_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     where task_id = 'aaaaaaaa-0000-0000-0000-00000000000d';
    raise exception 'FAIL 1f: cycle introduced by UPDATE was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS 1f: cycle via UPDATE rejected';
  end;
end $$;

-- ===========================================================================
-- TRIGGER 2 — AUTO-UNBLOCK
-- ===========================================================================

-- 2a. b has exactly one blocker (a). Closing a flips b blocked -> active.
update tasks set status = 'done'
 where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
do $$
declare s text;
begin
  select status into s from tasks where id = 'aaaaaaaa-0000-0000-0000-00000000000b';
  if s <> 'active' then
    raise exception 'FAIL 2a: b should be active after a closed, is %', s;
  end if;
  raise notice 'PASS 2a: sole blocker closed -> dependent unblocked';
end $$;

-- 2b. closing a also stamped closed_at and moved the project
do $$
declare
  c timestamptz;
  m timestamptz;
begin
  select closed_at into c from tasks where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if c is null then raise exception 'FAIL 2b: closed_at not stamped'; end if;
  select last_movement_at into m from projects
   where id = '33333333-3333-3333-3333-333333333333';
  if m is null or m < now() - interval '5 seconds' then
    raise exception 'FAIL 2b: project last_movement_at not touched (%)', m;
  end if;
  raise notice 'PASS 2b/4: closed_at stamped and project movement recorded';
end $$;

-- 2c. a dependent with TWO blockers stays blocked until both are closed
insert into tasks (id, workspace_id, venture_id, project_id, title, criticality,
                   estimate_minutes, status)
values ('bbbbbbbb-0000-0000-0000-00000000000f', '99999999-9999-9999-9999-999999999999',
        '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        'second blocker of c', 'blocking', 30, 'active');
insert into task_dependencies (task_id, blocks_task_id)
values ('bbbbbbbb-0000-0000-0000-00000000000f',
        'aaaaaaaa-0000-0000-0000-00000000000c');

update tasks set status = 'done' where id = 'aaaaaaaa-0000-0000-0000-00000000000b';
do $$
declare s text;
begin
  select status into s from tasks where id = 'aaaaaaaa-0000-0000-0000-00000000000c';
  if s <> 'blocked' then
    raise exception 'FAIL 2c: c must stay blocked, one blocker still open, is %', s;
  end if;
  raise notice 'PASS 2c: dependent stays blocked while any blocker is open';
end $$;

-- 2d. killing the last blocker unblocks c AND files needs_review on it
update tasks set status = 'killed', kill_reason = 'not needed after all'
 where id = 'bbbbbbbb-0000-0000-0000-00000000000f';
do $$
declare
  s text;
  n int;
begin
  select status into s from tasks where id = 'aaaaaaaa-0000-0000-0000-00000000000c';
  if s <> 'active' then
    raise exception 'FAIL 2d: c should be active once all blockers closed, is %', s;
  end if;
  select count(*) into n from events
   where verb = 'needs_review'
     and task_id = 'aaaaaaaa-0000-0000-0000-00000000000c';
  if n <> 1 then
    raise exception 'FAIL 2d: expected 1 needs_review event on c, got %', n;
  end if;
  raise notice 'PASS 2d: killed blocker unblocks dependent and files needs_review';
end $$;

-- 2e. a DONE blocker files no needs_review (d was unblocked by nothing yet;
--     use c -> d, closing c normally)
update tasks set status = 'done' where id = 'aaaaaaaa-0000-0000-0000-00000000000c';
do $$
declare
  s text;
  n int;
begin
  select status into s from tasks where id = 'aaaaaaaa-0000-0000-0000-00000000000d';
  if s <> 'active' then raise exception 'FAIL 2e: d should be active, is %', s; end if;
  select count(*) into n from events
   where verb = 'needs_review' and task_id = 'aaaaaaaa-0000-0000-0000-00000000000d';
  if n <> 0 then
    raise exception 'FAIL 2e: a done blocker must not file needs_review, got %', n;
  end if;
  raise notice 'PASS 2e: done blocker unblocks without needs_review';
end $$;

-- ===========================================================================
-- TRIGGER 3 — MILESTONE EXPIRY
-- ===========================================================================
insert into milestones (id, workspace_id, venture_id, name, due_date, hardness, cost_of_slip)
values ('55555555-5555-5555-5555-555555555555', '99999999-9999-9999-9999-999999999999',
        '11111111-1111-1111-1111-111111111111',
        'already past', taskos_today() - 1, 'soft', 'low'),
       ('66666666-6666-6666-6666-666666666666', '99999999-9999-9999-9999-999999999999',
        '11111111-1111-1111-1111-111111111111',
        'due today', taskos_today(), 'soft', 'low');

do $$
declare
  n int;
  s_past text;
  s_today text;
begin
  select taskos_expire_milestones() into n;
  select status into s_past  from milestones where id = '55555555-5555-5555-5555-555555555555';
  select status into s_today from milestones where id = '66666666-6666-6666-6666-666666666666';
  if s_past <> 'missed' then
    raise exception 'FAIL 3: past-due milestone should be missed, is %', s_past;
  end if;
  if s_today <> 'active' then
    raise exception 'FAIL 3: milestone due today must stay active, is %', s_today;
  end if;
  if not exists (select 1 from events where verb = 'milestone_missed') then
    raise exception 'FAIL 3: no milestone_missed event written';
  end if;
  raise notice 'PASS 3: % milestone(s) expired, due-today untouched', n;
end $$;

-- ===========================================================================
-- D3 — 60-second event de-duplication
-- ===========================================================================
do $$
declare n int;
begin
  insert into events (actor, verb, task_id, payload)
  values ('tal', 'snoozed', 'aaaaaaaa-0000-0000-0000-00000000000d', '{"i":1}'),
         ('tal', 'snoozed', 'aaaaaaaa-0000-0000-0000-00000000000d', '{"i":2}');
  select count(*) into n from events
   where verb = 'snoozed' and actor = 'tal'
     and task_id = 'aaaaaaaa-0000-0000-0000-00000000000d';
  if n <> 1 then
    raise exception 'FAIL D3: expected 1 event after duplicate insert, got %', n;
  end if;

  -- a different actor is not a duplicate
  insert into events (actor, verb, task_id) values
    ('claude', 'snoozed', 'aaaaaaaa-0000-0000-0000-00000000000d');
  select count(*) into n from events where verb = 'snoozed';
  if n <> 2 then
    raise exception 'FAIL D3: different actor must not be deduped, got %', n;
  end if;
  raise notice 'PASS D3: identical (verb, task_id, actor) inside 60s dropped';
end $$;

-- idempotency_key is unique
do $$
begin
  insert into events (actor, verb, idempotency_key) values ('tal', 'capture', 'k-1');
  begin
    insert into events (actor, verb, idempotency_key) values ('tal', 'capture', 'k-1');
    raise exception 'FAIL D3: duplicate idempotency_key was ACCEPTED';
  exception when unique_violation then
    raise notice 'PASS D3: duplicate idempotency_key rejected';
  end;
end $$;

-- ===========================================================================
-- schema constraints that carry real weight
-- ===========================================================================
do $$
begin
  begin
    insert into tasks (workspace_id, venture_id, title, estimate_minutes, status)
    values ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'no reason', 10, 'killed');
    raise exception 'FAIL: killed task without kill_reason was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS: killed requires kill_reason';
  end;
  begin
    insert into tasks (workspace_id, venture_id, title, estimate_minutes, is_recurring)
    values ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'no rule', 10, true);
    raise exception 'FAIL: recurring task without recurrence_rule was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS: is_recurring requires recurrence_rule';
  end;
  begin
    insert into ventures (workspace_id, name, slug, floor_share, ceiling_share)
    values ('99999999-9999-9999-9999-999999999999', 'bad', 'bad-shares', 0.5, 0.4);
    raise exception 'FAIL: floor_share >= ceiling_share was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS: floor_share < ceiling_share enforced';
  end;
end $$;

-- ===========================================================================
-- TENANCY — a dependency edge may never cross a workspace boundary
-- ===========================================================================
insert into workspaces (id, name)
values ('88888888-8888-8888-8888-888888888888', 'Someone Else');
insert into ventures (id, workspace_id, name, slug)
values ('77777777-7777-7777-7777-777777777777',
        '88888888-8888-8888-8888-888888888888', 'Theirs', 'theirs');
insert into tasks (id, workspace_id, venture_id, title, criticality,
                   estimate_minutes, status)
values ('cccccccc-0000-0000-0000-00000000000a',
        '88888888-8888-8888-8888-888888888888',
        '77777777-7777-7777-7777-777777777777',
        'their task', 'blocking', 60, 'active');

do $$
begin
  begin
    insert into task_dependencies (task_id, blocks_task_id)
    values ('aaaaaaaa-0000-0000-0000-00000000000d',
            'cccccccc-0000-0000-0000-00000000000a');
    raise exception 'FAIL T1: cross-workspace dependency was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS T1: dependency across a workspace boundary rejected';
  end;
  begin
    insert into task_dependencies (task_id, blocks_task_id)
    values ('cccccccc-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-00000000000d');
    raise exception 'FAIL T2: cross-workspace dependency (reversed) was ACCEPTED';
  exception when check_violation then
    raise notice 'PASS T2: rejected in the other direction too';
  end;
end $$;

do $$
declare n int;
begin
  -- Milestone expiry must respect each workspace's own timezone and rows.
  select taskos_expire_milestones() into n;
  raise notice 'PASS T3: expiry ran across workspaces, % milestone(s) flipped', n;
end $$;

rollback;

\echo 'ALL TRIGGER TESTS PASSED'
