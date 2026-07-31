-- Delegation: sending work to the people who do it, and getting it back.
--
-- Tal has roughly 28 usable hours a week and two collaborators with about 48
-- between them. Delegation is the largest lever in the system, and until now
-- assigning a task told the assignee nothing at all.
--
-- The shape: a secret link, no account, no app, no invite. The person opens a
-- page, sees only their own work, marks it done, says what they are stuck on.
-- Nothing runs on a schedule, because nothing here needs to.
--
-- THE ONE THING IN THIS MIGRATION THAT PREVENTS SILENT DATA CORRUPTION is
-- tasks.actual_by_person_id. Without it, a delegate's volunteered duration
-- flows into the calibration table and teaches Tal's estimator from someone
-- else's speed.

begin;

-- ---------------------------------------------------------------------------
-- Tokens
-- ---------------------------------------------------------------------------
create table if not exists delegation_tokens (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  person_id      uuid not null references people(id) on delete cascade,

  -- 'task'     one task, the default, expires after it is done
  -- 'person'   that person's whole open queue, durable, bookmarkable
  -- 'calendar' read-only feed; a SEPARATE row from 'person' on purpose, because
  --            a feed URL lives forever in Google's servers and in a settings
  --            screen nobody audits, so it must not be able to close anything
  scope          text not null check (scope in ('person', 'task', 'calendar')),
  task_id        uuid references tasks(id) on delete cascade,

  -- sha256 hex only. The plaintext exists exactly once, in the response to
  -- delegate_link. A database dump, a backup or a screenshot of a query yields
  -- no working link.
  token_hash     text not null unique,
  -- First 8 characters, so Tal can name a link he is looking at in a chat
  -- window in order to revoke it, without the server ever holding the secret.
  token_prefix   text not null,
  label          text,

  created_at     timestamptz not null default now(),
  -- NULL means durable. Expiry is enforced ON READ rather than by a sweeper,
  -- which turns "this platform has no cron" from a constraint into a property.
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  -- The rotation grace window: during it both links work and the old page
  -- carries a banner with the new URL. Naive rotation locks people out, so
  -- nobody ever rotates; this makes rotating routine.
  --
  -- DEFERRABLE INITIALLY DEFERRED, and that is required rather than tidy. The
  -- partial unique index below forbids two live links for one person, so a
  -- rotation must mark the old row superseded BEFORE inserting the new one --
  -- which means pointing at a row that does not exist yet. Deferring the
  -- foreign key to commit time is what lets both happen in one transaction.
  superseded_by  uuid references delegation_tokens(id) on delete set null
                 deferrable initially deferred,

  -- Stamped on GET, and NEVER reported as "they read it": WhatsApp, Telegram
  -- and Slack all fetch a URL to build a link preview.
  last_fetched_at timestamptz,
  fetch_count    int not null default 0,
  -- Stamped only on POST. The one signal that is definitely a human.
  acted_at       timestamptz,

  check ((scope = 'task') = (task_id is not null))
);

-- Partial-unique indexes deliberately do NOT mention expires_at: now() is not
-- immutable and cannot appear in an index predicate. Expired-but-unrevoked rows
-- are revoked lazily at read time, which keeps the index honest and lets a
-- dormant person be re-onboarded.
create unique index if not exists delegation_tokens_live_person_idx
  on delegation_tokens (person_id, scope)
  where scope in ('person', 'calendar') and revoked_at is null and superseded_by is null;
create unique index if not exists delegation_tokens_live_task_idx
  on delegation_tokens (task_id, person_id)
  where scope = 'task' and revoked_at is null and superseded_by is null;
create index if not exists delegation_tokens_person_idx
  on delegation_tokens (workspace_id, person_id);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
-- NOT events: taskos_dedupe_events (0002_triggers.sql) silently drops a second
-- (verb, task_id, actor) row inside 60 seconds, which would eat a delegate's
-- rapid follow-up with no error anywhere. And events.payload is jsonb; burying
-- human prose there makes it unqueryable.
--
-- NOT tasks.notes: updateTask writes notes wholesale, so a comment appended
-- there dies on Tal's next correction.
create table if not exists task_comments (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  task_id          uuid not null references tasks(id) on delete cascade,
  token_id         uuid references delegation_tokens(id) on delete set null,
  author_person_id uuid references people(id) on delete set null,
  author_kind      text not null check (author_kind in ('tal', 'delegate', 'system')),
  body             text not null check (length(btrim(body)) between 1 and 4000),
  -- "I am stuck" writes one of these. It does NOT change status: `waiting` is
  -- in DEMAND_EXCLUDED_STATUSES, so a delegate marking themselves blocked would
  -- drop the minutes out of demand while coverage still counted the task --
  -- and capacity() would report a BETTER week because someone got stuck.
  blocks_progress  boolean not null default false,
  created_at       timestamptz not null default now(),
  read_by_owner_at    timestamptz,
  read_by_assignee_at timestamptz,
  check (author_kind <> 'delegate' or author_person_id is not null)
);

create index if not exists task_comments_task_idx on task_comments (task_id, created_at);
create index if not exists task_comments_unread_idx on task_comments (workspace_id)
  where read_by_owner_at is null and author_kind = 'delegate';

-- ---------------------------------------------------------------------------
-- Columns on existing tables
-- ---------------------------------------------------------------------------
alter table tasks add column if not exists actual_by_person_id uuid references people(id);
alter table tasks add column if not exists needs_attention_at timestamptz;
alter table people add column if not exists timezone text;
alter table people add column if not exists telegram_chat_id text;

comment on column tasks.actual_by_person_id is
  'Who volunteered the duration. NULL means Tal. A delegate''s minutes measure THEIR speed, not Tal''s, and must never reach the calibration table.';
comment on column tasks.needs_attention_at is
  'A delegate said they are blocked. The most expensive silence in a system with 48h of execution capacity behind a 28h bottleneck.';
comment on column people.telegram_chat_id is
  'Outbound only. NEVER add this to TELEGRAM_ALLOWED_CHAT_IDS -- that list grants inbound command access to the whole portfolio.';
comment on column people.timezone is
  'NULL means unstated and is never assumed; the page falls back to settings.active_tz and says which it used.';

-- ---------------------------------------------------------------------------
-- Cross-workspace guard, the same one 0007 puts on documents
-- ---------------------------------------------------------------------------
-- One function, two tables with different columns, so the optional person
-- columns are read through jsonb rather than as new.<field>.
--
-- plpgsql resolves a record field reference at RUNTIME even inside a branch
-- that is not taken, so `if to_jsonb(new) ? 'author_person_id' and
-- new.author_person_id is not null` still raises "record new has no field
-- author_person_id" on delegation_tokens. Reading the value out of the jsonb
-- is the only form that works for both tables.
create or replace function taskos_delegation_same_workspace() returns trigger
language plpgsql as $$
declare
  j jsonb := to_jsonb(new);
  other uuid;
  who uuid;
begin
  if new.task_id is not null then
    select workspace_id into other from tasks where id = new.task_id;
    if other is distinct from new.workspace_id then
      raise exception 'row workspace % does not match task workspace %',
        new.workspace_id, other using errcode = '23514';
    end if;
  end if;

  foreach who in array array[
    nullif(j->>'person_id', '')::uuid,
    nullif(j->>'author_person_id', '')::uuid
  ] loop
    if who is not null then
      select workspace_id into other from people where id = who;
      if other is distinct from new.workspace_id then
        raise exception 'row workspace % does not match person workspace %',
          new.workspace_id, other using errcode = '23514';
      end if;
    end if;
  end loop;

  return new;
end $$;

drop trigger if exists delegation_tokens_same_workspace on delegation_tokens;
create trigger delegation_tokens_same_workspace
  before insert or update on delegation_tokens
  for each row execute function taskos_delegation_same_workspace();

drop trigger if exists task_comments_same_workspace on task_comments;
create trigger task_comments_same_workspace
  before insert or update on task_comments
  for each row execute function taskos_delegation_same_workspace();

alter table delegation_tokens enable row level security;
drop policy if exists taskos_member_all on delegation_tokens;
create policy taskos_member_all on delegation_tokens
  for all using (taskos_is_member(workspace_id)) with check (taskos_is_member(workspace_id));

alter table task_comments enable row level security;
drop policy if exists taskos_member_all on task_comments;
create policy taskos_member_all on task_comments
  for all using (taskos_is_member(workspace_id)) with check (taskos_is_member(workspace_id));

commit;
