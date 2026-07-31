-- What is needed to CORRECT rather than only create.
--
-- The system could write a task and close it, and nothing in between. Every
-- mistake was therefore permanent: a wrong estimate, a task filed as recurring
-- that is not, a milestone superseded by reality. A task system whose mistakes
-- cannot be repaired stops being trusted the first time one is made, and then
-- it stops being used.
--
-- Two additions here; everything else the edit tools need already exists.

begin;

-- ---------------------------------------------------------------------------
-- People: enough to make delegation measurable
-- ---------------------------------------------------------------------------
-- commit_tasks already refuses an unknown assignee, correctly. There was simply
-- no way to create one, so the assignee field was unusable and ownership was
-- being carried in the notes field in capital letters.
--
-- hours_per_week is what turns a name into a constraint: delegated load is the
-- real limit on what can be moved off Tal's week, and it cannot be reported
-- without knowing how much of each person's week exists.
alter table people add column if not exists hours_per_week numeric
  check (hours_per_week is null or (hours_per_week >= 0 and hours_per_week <= 168));
alter table people add column if not exists active boolean not null default true;

comment on column people.hours_per_week is
  'Their working week. NULL means unstated -- never assumed.';

-- ---------------------------------------------------------------------------
-- Snooze: a date, so deferral is a fact rather than only a counter
-- ---------------------------------------------------------------------------
-- snooze_count already exists and already drives the triage threshold, but
-- nothing could increment it, so "snoozed three times, this needs a decision"
-- was unreachable. The date records WHEN it was pushed to, which is what makes
-- a deferral reviewable rather than merely counted.
alter table tasks add column if not exists snoozed_until date;

comment on column tasks.snoozed_until is
  'Deferred to this date. snooze_count is what drives triage; this is the record of where it went.';

-- Note on duplicate dependency edges: no constraint is added here because
-- task_dependencies already has primary key (task_id, blocks_task_id), so a
-- duplicate row has never been possible. Declaring the same edge from both
-- `blocks` and `depends_on` inserted once and reported twice -- a reporting
-- bug, fixed in commit_tasks, with nothing to clean up in the data.

commit;
