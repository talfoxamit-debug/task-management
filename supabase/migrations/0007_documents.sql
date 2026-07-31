-- TaskOS — documents: files attached to the work they belong to.
--
-- The bytes live in Supabase Storage; only metadata lives here. Postgres is a
-- poor filesystem, and a 20MB PDF in a row makes every query that touches the
-- table slower for no benefit. The table records what a document IS and what it
-- is ABOUT; the bucket records what it contains.
--
-- One design point worth stating plainly. There is no callback from Storage
-- telling us an upload finished, so a row created to hand out an upload link
-- starts as 'pending' and becomes 'stored' when the server next reconciles
-- against the bucket. A document listed as pending means "we handed out a link
-- and have not yet seen bytes" -- not "the upload failed". Reporting that
-- honestly is better than defaulting to 'stored' and listing files that do not
-- exist.

begin;

create table documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,

  -- What this document is about. All optional and independent: a document may
  -- belong to a venture generally, or to one task specifically, or to both.
  -- Nothing is required, because a contract that arrives before anyone has
  -- decided which project it belongs to still needs somewhere to live.
  venture_id uuid references ventures(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  milestone_id uuid references milestones(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,

  title text not null,
  -- Free text for what this is and why it matters. This is the field that makes
  -- a document useful as context later; a filename rarely is.
  notes text,

  -- Path within the bucket. Always '<workspace_id>/<document_id>/<filename>',
  -- so a storage policy can authorise on the leading path segment alone and a
  -- misfiled row cannot reach another tenant's objects.
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  sha256 text,

  status text not null default 'pending' check (status in ('pending', 'stored', 'missing')),
  source text not null default 'claude'
    check (source in ('claude', 'upload_link', 'telegram', 'email', 'dashboard')),

  created_at timestamptz not null default now(),
  stored_at timestamptz,
  -- Set when a reconcile pass finds no object at storage_path, so a document
  -- that vanished from the bucket says so instead of silently reading as fine.
  checked_at timestamptz
);

create index documents_workspace_idx on documents (workspace_id, created_at desc);
create index documents_venture_idx on documents (venture_id) where venture_id is not null;
create index documents_task_idx on documents (task_id) where task_id is not null;
create index documents_milestone_idx on documents (milestone_id) where milestone_id is not null;
create index documents_project_idx on documents (project_id) where project_id is not null;
create index documents_pending_idx on documents (workspace_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- A document may not point across a tenant boundary
-- ---------------------------------------------------------------------------
-- The same guard 0005 puts on dependencies. Without it a document row carrying
-- one workspace's id can reference another workspace's task, and every "show me
-- what is attached to this task" query becomes a cross-tenant read.
create or replace function taskos_documents_same_workspace() returns trigger
language plpgsql as $$
declare
  other uuid;
begin
  if new.venture_id is not null then
    select workspace_id into other from ventures where id = new.venture_id;
    if other is distinct from new.workspace_id then
      raise exception 'document workspace % does not match venture workspace %',
        new.workspace_id, other using errcode = '23514';
    end if;
  end if;

  if new.project_id is not null then
    select workspace_id into other from projects where id = new.project_id;
    if other is distinct from new.workspace_id then
      raise exception 'document workspace % does not match project workspace %',
        new.workspace_id, other using errcode = '23514';
    end if;
  end if;

  if new.milestone_id is not null then
    select workspace_id into other from milestones where id = new.milestone_id;
    if other is distinct from new.workspace_id then
      raise exception 'document workspace % does not match milestone workspace %',
        new.workspace_id, other using errcode = '23514';
    end if;
  end if;

  if new.task_id is not null then
    select workspace_id into other from tasks where id = new.task_id;
    if other is distinct from new.workspace_id then
      raise exception 'document workspace % does not match task workspace %',
        new.workspace_id, other using errcode = '23514';
    end if;
  end if;

  return new;
end $$;

create trigger documents_same_workspace
  before insert or update on documents
  for each row execute function taskos_documents_same_workspace();

-- ---------------------------------------------------------------------------
-- The storage_path must start with the owning workspace
-- ---------------------------------------------------------------------------
-- Belt and braces for the bucket policy below, which authorises on the first
-- path segment. If a row could name a path outside its own workspace prefix,
-- that policy would be authorising the wrong thing.
alter table documents
  add constraint documents_path_is_workspace_scoped
  check (storage_path like workspace_id::text || '/%');

-- ---------------------------------------------------------------------------
-- RLS, matching every other table
-- ---------------------------------------------------------------------------
alter table documents enable row level security;
create policy taskos_member_all on documents
  for all
  using (taskos_is_member(workspace_id))
  with check (taskos_is_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Supabase-only wiring, skipped on a bare Postgres so the tests can run
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'no storage schema: skipping bucket creation (this is expected on a bare Postgres)';
    return;
  end if;

  -- Private, not public. A public bucket makes every object readable by anyone
  -- holding the URL, forever, which is the wrong default for a contract or an
  -- invoice. Reads go through short-lived signed URLs instead.
  insert into storage.buckets (id, name, public)
  values ('taskos-documents', 'taskos-documents', false)
  on conflict (id) do nothing;

  -- Members may reach objects under their own workspace prefix and no other.
  -- storage.foldername(name) splits the object path; element 1 is the workspace
  -- id this migration forces every storage_path to begin with.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'taskos_documents_member_access'
  ) then
    execute $p$
      create policy taskos_documents_member_access on storage.objects
        for all
        using (
          bucket_id = 'taskos-documents'
          and taskos_is_member(((storage.foldername(name))[1])::uuid)
        )
        with check (
          bucket_id = 'taskos-documents'
          and taskos_is_member(((storage.foldername(name))[1])::uuid)
        )
    $p$;
  end if;
end $$;

commit;
