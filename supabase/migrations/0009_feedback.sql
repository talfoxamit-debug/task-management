-- What the system is missing, reported by whoever hit it.
--
-- Tal builds this. The agents using it are the ones who run into its edges --
-- a tool that cannot express something, a reply that does not answer the
-- question, a failure with no way to report itself. Before this table that
-- knowledge died with the conversation.
--
-- Deliberately NOT a task. Feedback about the tool is not work inside the
-- portfolio: it must never take a share of the week, drive demand, or appear in
-- a slip ranking. Filing it as a task would corrupt the one question this
-- system exists to answer.

begin;

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,

  kind text not null check (kind in ('bug', 'feature', 'improvement', 'friction', 'question')),
  title text not null,
  -- What was being attempted when this came up. A request without its
  -- occasion is a wish; with it, it is evidence.
  detail text not null,
  -- The concrete moment that prompted it: the call that failed, the question
  -- that could not be answered, the workaround that was needed.
  trigger_context text,

  severity text not null default 'medium'
    check (severity in ('blocking', 'high', 'medium', 'low')),
  status text not null default 'open'
    check (status in ('open', 'planned', 'done', 'declined')),

  -- Who noticed. 'agent' is the common case; Tal can file his own.
  source text not null default 'agent' check (source in ('agent', 'tal', 'telegram')),
  -- Free text: which surface it came from, e.g. 'claude session', 'dashboard'.
  reported_from text,

  -- How many times this has been hit. A recurring annoyance outranks a
  -- one-off, and counting is more honest than filing the same thing twice.
  occurrences integer not null default 1 check (occurrences > 0),

  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text
);

create index if not exists feedback_workspace_idx on feedback (workspace_id, status, created_at desc);
create index if not exists feedback_open_idx on feedback (workspace_id, severity) where status = 'open';

-- One row per distinct title, so re-reporting increments rather than duplicates.
create unique index if not exists feedback_title_unique on feedback (workspace_id, lower(title));

alter table feedback enable row level security;
drop policy if exists taskos_member_all on feedback;
create policy taskos_member_all on feedback
  for all
  using (taskos_is_member(workspace_id))
  with check (taskos_is_member(workspace_id));

commit;
