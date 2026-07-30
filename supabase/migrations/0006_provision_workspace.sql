-- Provisioning a workspace.
--
-- Migration 0005 gave the existing data a workspace, but said nothing about how
-- the SECOND one comes into being. A bare `insert into workspaces` produces a
-- workspace that looks fine and is quietly broken: no settings row, so every
-- day boundary has no timezone and loadPortfolio throws; no holding venture, so
-- capture() has nowhere to park an inbox item; no calibration rows, so the
-- cold-start gates have nothing to count.
--
-- The integration test that found this created a workspace by hand, which is
-- exactly what a UI signup would have done.

create or replace function taskos_provision_workspace(
  p_name text,
  p_active_tz text default 'America/New_York',
  p_buffer_ratio numeric default 0.20
) returns uuid
language plpgsql as $$
declare
  ws uuid;
begin
  insert into workspaces (name) values (p_name) returning id into ws;

  insert into settings (workspace_id, active_tz, buffer_ratio)
  values (ws, p_active_tz, p_buffer_ratio);

  -- The inactive holding venture inbox items park against, because
  -- tasks.venture_id is NOT NULL and capture() must not guess a venture.
  -- Inactive is what keeps it out of computeDemand and out of the week.
  insert into ventures (workspace_id, name, slug, strategic_weight,
                        floor_share, ceiling_share, active)
  values (ws, 'Unsorted inbox', 'unsorted', 0.3, 0.0, 0.1, false);

  -- Calibration starts inert for every context (D4).
  insert into calibration (workspace_id, context, ratio, sample_n)
  select ws, c, 1.0, 0
  from unnest(array['deep_work','calls','admin','errands','creative','review','physical']) as c;

  return ws;
end $$;

comment on function taskos_provision_workspace is
  'Create a workspace along with everything it needs to function: settings, the inactive unsorted holding venture, and a full set of inert calibration rows. Never insert into workspaces directly.';
