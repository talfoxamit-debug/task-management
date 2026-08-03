-- Which venture owns which day.
--
-- Tal allocates whole days to ventures -- Sunday and Monday to Seatop, Tuesday
-- to Yathub, and so on. That rule existed only in conversation, so it had to be
-- re-explained every session and had already caused two planning errors.
--
-- The flex budget is the part that makes it usable rather than a cage. A day
-- belonging to Seatop still has to absorb the Yathub thing that catches fire,
-- and a rule with no give gets abandoned the first time it is inconvenient.

begin;

create table if not exists day_allocation (
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  -- 0 = Sunday, matching Postgres extract(dow).
  day_of_week       int  not null check (day_of_week between 0 and 6),
  primary_venture_id uuid references ventures(id) on delete set null,
  -- Minutes of OTHER ventures' work this day can absorb.
  flex_minutes      int  not null default 90 check (flex_minutes >= 0),
  is_working_day    boolean not null default true,
  note              text,
  primary key (workspace_id, day_of_week)
);

alter table day_allocation enable row level security;
drop policy if exists taskos_member_all on day_allocation;
create policy taskos_member_all on day_allocation
  for all using (taskos_is_member(workspace_id)) with check (taskos_is_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Flex is spent by DOING, not by ASKING
-- ---------------------------------------------------------------------------
-- Recorded per day so it can be counted, and counted from closes rather than
-- from suggestions: if merely asking "what should I do?" consumed the budget,
-- the day would be gone before any of it was worked. This table is written on
-- close only.
create table if not exists day_flex_spent (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  on_date      date not null,
  task_id      uuid not null references tasks(id) on delete cascade,
  minutes      int  not null check (minutes >= 0),
  venture_id   uuid references ventures(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, on_date, task_id)
);

create index if not exists day_flex_spent_date_idx on day_flex_spent (workspace_id, on_date);

alter table day_flex_spent enable row level security;
drop policy if exists taskos_member_all on day_flex_spent;
create policy taskos_member_all on day_flex_spent
  for all using (taskos_is_member(workspace_id)) with check (taskos_is_member(workspace_id));

-- No rollover, deliberately: unspent flex does not accumulate into a licence to
-- spend a whole day off-plan later. Each day starts at its own budget, which is
-- the only version of this rule that keeps meaning anything.

commit;
