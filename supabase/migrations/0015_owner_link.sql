-- Tal's own page.
--
-- Every interface built so far talks TO him: a Claude conversation, a Telegram
-- message, a delegate page for somebody else. There has never been anywhere he
-- can simply look. The dashboard needs a Supabase magic link that has not
-- worked since the first deploy, which means in practice he has no interface at
-- all — and a task system you cannot look at is not a task system.
--
-- So: the same mechanism the delegates already use, pointed at the owner. A
-- secret URL, bookmarkable, no login, works on a phone with one bar.
--
-- THE TRADE IS BIGGER HERE AND IS BEING MADE DELIBERATELY. A delegate link
-- reaches one person's own assigned work; an owner link reaches the whole
-- portfolio. The token is the same 256 bits of CSPRNG and only its hash is
-- stored, so the difference is not the strength of the secret, it is the
-- consequence of losing it.
--
-- Three things bound that consequence:
--   * the page performs exactly two mutations, close and undo. No kill, no
--     delete, no editing. A stolen link cannot destroy anything.
--   * it is revocable in one call, like every other link here.
--   * it carries no-referrer, no-store and a content policy that forbids
--     loading anything external, so the URL cannot leak out of the page itself.
--
-- The alternative was not "a safer interface". It was the status quo: no
-- interface, and a person running five ventures reading his own portfolio out
-- of a chat window.

begin;

-- 'owner' joins the existing scopes. person_id becomes nullable, because the
-- owner is not a row in `people` -- that table is who work is delegated TO.
alter table delegation_tokens alter column person_id drop not null;

alter table delegation_tokens drop constraint if exists delegation_tokens_scope_check;
alter table delegation_tokens add constraint delegation_tokens_scope_check
  check (scope in ('person', 'task', 'calendar', 'owner'));

-- An owner token has no person; every other scope must have one. Stated as a
-- constraint rather than a convention, because a person-scoped row with a null
-- person_id would silently widen what that link can see.
alter table delegation_tokens drop constraint if exists delegation_tokens_person_scope_check;
alter table delegation_tokens add constraint delegation_tokens_person_scope_check
  check ((scope = 'owner') = (person_id is null));

-- One live owner link at a time, same rule the person links follow. Rotation
-- with a grace window is how it gets replaced.
create unique index if not exists delegation_tokens_live_owner_idx
  on delegation_tokens (workspace_id)
  where scope = 'owner' and revoked_at is null and superseded_by is null;

comment on column delegation_tokens.person_id is
  'Who the link is for. NULL only when scope = owner, which is Tal himself and is not a row in people.';

commit;
