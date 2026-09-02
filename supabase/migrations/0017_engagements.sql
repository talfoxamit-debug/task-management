-- A temporary change to the week.
--
-- day_allocation models the week as PERMANENT: one repeating shape, keyed by
-- day_of_week. That is right for the steady state and wrong for every
-- fixed-duration commitment — a relief, a delivery, a site visit, a trip, a
-- holiday. Each of those is the same shape of fact: for THESE dates, the week
-- is different.
--
-- The live failure this was written for: a three-week chief engineer relief on
-- Miss Michelle, 31 Aug - 20 Sep 2026. For 21 days Tal is on a boat on someone
-- else's schedule, and the system still believed Monday belonged to seatop. So
-- next_actions and day_plan offered the wrong venture's work every day, and
-- capacity computed deficits against hours that do not exist. The only escape
-- was ignore_day_allocation:true on every call -- a per-call override of a
-- persistent fact, which has to be remembered every time, and which day_plan
-- did not even offer.

begin;

create table if not exists engagements (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  -- Named, because a session three days in has to be able to tell WHY the week
  -- looks unusual. An unnamed override reads as corrupted data and the next
  -- agent "corrects" it back.
  name           text not null,

  -- NULL means the days are not worked at all: a holiday, a flight, a hospital
  -- stay. That is the same fact as a relief -- a temporary change to the week --
  -- so it is the same row rather than a second concept.
  venture_id     uuid references ventures(id) on delete set null,
  is_working_day boolean not null default true,

  start_date     date not null,
  end_date       date not null,

  -- Overrides for the days it covers. NULL falls back to the weekly default,
  -- so an engagement that only changes WHICH venture owns the day does not have
  -- to restate the hours.
  flex_minutes   int check (flex_minutes >= 0),
  start_hour     int check (start_hour between 0 and 23),
  end_hour       int check (end_hour between 1 and 24),

  note           text,
  created_at     timestamptz not null default now(),
  ended_early_at timestamptz,
  ended_reason   text,

  check (end_date >= start_date),
  check (end_hour is null or start_hour is null or end_hour > start_hour),
  -- A working engagement that names no venture would silently widen the day to
  -- every venture, which is not what "I am on a boat" means.
  check (is_working_day = false or venture_id is not null)
);

create index if not exists engagements_range_idx
  on engagements (workspace_id, start_date, end_date)
  where ended_early_at is null;

alter table engagements enable row level security;
drop policy if exists taskos_member_all on engagements;
create policy taskos_member_all on engagements
  for all using (taskos_is_member(workspace_id)) with check (taskos_is_member(workspace_id));

comment on table engagements is
  'A dated override of the weekly day_allocation. Resolution when several cover one date: SHORTEST duration wins, so a one-day holiday inside a three-week relief is the more specific fact. Overlap is allowed on purpose and every covering row is reported.';

commit;
