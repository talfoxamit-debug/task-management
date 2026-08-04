-- The day, laid out in hours.
--
-- TaskOS has said since V1 that it does not schedule -- it ranks, and a ranking
-- is not a plan. That was the right default and it is being changed on purpose:
-- a list of bullet points at 08:00 still leaves the whole allocation problem to
-- the person reading it, every single morning.
--
-- What is NOT changing is where the numbers come from. The plan below is a
-- layout of the existing ranking against the hours actually on record. Nothing
-- here invents a duration, a priority or a deadline.

begin;

-- ---------------------------------------------------------------------------
-- When the day runs
-- ---------------------------------------------------------------------------
-- Without these the plan has nowhere to start, and the only alternative is
-- assuming 9-to-5 -- which for someone with roughly 28 usable hours across six
-- days would put work in hours that are not worked and quietly make every
-- start time wrong.
alter table settings add column if not exists work_start_hour int
  check (work_start_hour between 0 and 23);
alter table settings add column if not exists work_end_hour int
  check (work_end_hour between 1 and 24);

comment on column settings.work_start_hour is
  'Local hour the day starts. NULL means unstated: the plan says so rather than assuming one.';

-- Per-day overrides, nullable, falling back to settings. A Yathub Tuesday can
-- start later than a Seatop Monday without duplicating the whole row.
alter table day_allocation add column if not exists start_hour int
  check (start_hour between 0 and 23);
alter table day_allocation add column if not exists end_hour int
  check (end_hour between 1 and 24);

-- ---------------------------------------------------------------------------
-- What Claude can do before Tal gets to it
-- ---------------------------------------------------------------------------
-- prepared_at (0013) records that drafting HAS happened. This is the forward
-- half: that it CAN happen, stated ahead of time, so the plan can put a
-- fifteen-minute review in the calendar where a two-hour build would have gone.
--
-- It is set explicitly and never inferred. A keyword rule guessing that "write
-- the onboarding doc" is preparable and "call the accountant" is not would be
-- right often enough to be trusted and wrong often enough to waste a morning.
alter table tasks add column if not exists ai_preparable boolean not null default false;

comment on column tasks.ai_preparable is
  'Claude can produce a first draft of this before Tal reaches it. Set deliberately by an agent that has read the task, never inferred from the title. The day plan books the REVIEW, not the build.';

create index if not exists tasks_ai_preparable_idx on tasks (workspace_id)
  where ai_preparable and status not in ('done', 'killed');

commit;
