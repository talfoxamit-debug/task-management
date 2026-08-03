-- Work that has been prepared, and is waiting only on Tal.
--
-- The model: Claude reads, gathers and drafts; Tal reviews and sends. Not
-- automation -- Tal has said plainly that automated output is often not what he
-- wants, and being the final reviewer is the point rather than a limitation.
--
-- What was missing is a way to record that state. A task Claude has drafted is
-- nearly finished and costs five minutes of judgement, which makes it the
-- cheapest valuable work in the system -- and it was completely invisible.
--
-- WHY NOT A STATUS. `waiting` is in DEMAND_EXCLUDED_STATUSES: marking a drafted
-- task `waiting` would drop its minutes out of demand while coverage still
-- counted it, and capacity() would report a lighter week because work got done
-- that has not actually landed. Preparation is a property of a task, not a
-- state of it, so it goes in columns beside the status rather than into it.

begin;

alter table tasks add column if not exists prepared_at timestamptz;
alter table tasks add column if not exists prepared_by text
  check (prepared_by is null or prepared_by in ('ai', 'tal', 'delegate'));
-- What was produced, in a sentence, so the review can start without re-reading
-- the whole conversation that produced it.
alter table tasks add column if not exists prepared_summary text;
-- What is genuinely LEFT: reading it, deciding, sending. Never the original
-- estimate. NULL means unstated and is never assumed -- the same rule that
-- governs actual_minutes.
alter table tasks add column if not exists review_minutes int
  check (review_minutes is null or review_minutes > 0);

comment on column tasks.prepared_at is
  'Claude has done the preparable part. The task is NOT done: it is waiting on Tal to review and send.';
comment on column tasks.review_minutes is
  'Minutes of Tal''s judgement still required. NULL means unstated, never assumed.';

create index if not exists tasks_prepared_idx on tasks (workspace_id)
  where prepared_at is not null and status not in ('done', 'killed');

commit;
