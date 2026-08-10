-- Sending work to the people who do it, in the chat they already use.
--
-- The delegate pages exist and work, and every link so far has had to be
-- copied out of a Claude response and pasted into WhatsApp by hand. That is the
-- step that does not happen on a busy day, which makes the whole feature
-- optional in practice.
--
-- The bot already has an outbound channel. What it has never had is permission
-- to speak to anyone but Tal, and no way to know which chat belongs to whom.

begin;

-- ---------------------------------------------------------------------------
-- Binding a chat to a person
-- ---------------------------------------------------------------------------
-- people.telegram_chat_id (0011) is where the binding lands. Its comment there
-- is load-bearing and repeated here: that id is OUTBOUND ONLY. Putting it in
-- TELEGRAM_ALLOWED_CHAT_IDS would grant that chat inbound command access to the
-- entire portfolio -- capacity, every venture, every task.
--
-- The code below is what lets an UNKNOWN chat identify itself exactly once. The
-- webhook's allow-list is otherwise absolute, and has to stay that way, so the
-- exception is deliberately the narrowest possible: one command, one code, one
-- use, and a short life.
create table if not exists chat_pairing_codes (
  code          text primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  person_id     uuid not null references people(id) on delete cascade,
  created_at    timestamptz not null default now(),
  -- Single-use. A code that still works after it has been redeemed is a code
  -- that can bind a second, unintended chat to the same person.
  redeemed_at   timestamptz,
  redeemed_chat text,
  expires_at    timestamptz not null default now() + interval '30 minutes'
);

create index if not exists chat_pairing_codes_person_idx
  on chat_pairing_codes (workspace_id, person_id);

alter table chat_pairing_codes enable row level security;
drop policy if exists taskos_member_all on chat_pairing_codes;
create policy taskos_member_all on chat_pairing_codes
  for all using (taskos_is_member(workspace_id)) with check (taskos_is_member(workspace_id));

-- Which chat a paired person is reachable in, and whether it is a group. A
-- group is the common case: Tal already has one with each of them, and using it
-- means he sees every message the bot sends rather than having to trust it.
alter table people add column if not exists telegram_chat_title text;
alter table people add column if not exists telegram_paired_at timestamptz;

comment on column people.telegram_chat_id is
  'OUTBOUND ONLY. Never add to TELEGRAM_ALLOWED_CHAT_IDS -- that list grants inbound command access to the whole portfolio.';

-- ---------------------------------------------------------------------------
-- Not nagging
-- ---------------------------------------------------------------------------
-- A chaser that fires every time the cron runs is a chaser that gets muted in
-- two days, and a muted channel is worse than no channel: it fails silently and
-- takes the useful messages with it. One nudge per task per day, at most, and
-- recorded so the rule survives a redeploy.
create table if not exists task_nudges (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  task_id      uuid not null references tasks(id) on delete cascade,
  on_date      date not null,
  reason       text not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, task_id, on_date)
);

alter table task_nudges enable row level security;
drop policy if exists taskos_member_all on task_nudges;
create policy taskos_member_all on task_nudges
  for all using (taskos_is_member(workspace_id)) with check (taskos_is_member(workspace_id));

commit;
