-- TaskOS V1 — Part 8 seed data. Ventures, controllable milestones, and the two
-- outcome targets. No tasks: those get entered conversationally.

insert into settings (id, active_tz, buffer_ratio)
values (1, 'America/New_York', 0.20)
on conflict (id) do update
  set active_tz = excluded.active_tz,
      buffer_ratio = excluded.buffer_ratio;

insert into ventures (name, slug, strategic_weight, floor_share, ceiling_share) values
  ('FoxStays / YachtyHub', 'yachtyhub',    1.3, 0.10, 0.60),
  ('Stackwrk',             'stackwrk',     1.2, 0.08, 0.55),
  ('Seatop Homes',         'seatop',       1.3, 0.07, 0.50),
  ('Fox Solutions',        'foxsolutions', 1.0, 0.10, 0.50),
  ('Octo',                 'octo',         0.5, 0.03, 0.30)
on conflict (slug) do update
  set name             = excluded.name,
      strategic_weight = excluded.strategic_weight,
      floor_share      = excluded.floor_share,
      ceiling_share    = excluded.ceiling_share;

-- Milestones: events Tal controls. These drive demand (D1).
--
-- DATES ARE RELATIVE TO WHEN THIS RUNS, not absolute, and that is a fix rather
-- than a preference. They were hardcoded to 2026-08-08/10/12; the calendar
-- walked past them and five tests in three files began failing on a day nobody
-- touched the code. An expired milestone stops being active, its blocking tasks
-- stop counting toward coverage, and assertions about slack quietly became
-- assertions about the wall clock.
--
-- Fixing it here rather than in each test is what stops the next one appearing:
-- a fresh database now always seeds a portfolio with a future in it. Production
-- is unaffected — this insert is guarded by `not exists` and its rows landed
-- long ago.
insert into milestones (venture_id, name, due_date, hardness, cost_of_slip)
select v.id, m.name, current_date + m.in_days, m.hardness, m.cost_of_slip
from ventures v
join (values
  ('yachtyhub', 'YachtyHub live',
   8, 'hard',
   'high — launch window and the paid listings pipeline both slide with it'),
  ('stackwrk', 'Site sale-ready: contract, pricing, pages',
   6, 'soft',
   'high — nothing can be sold until the site can take money'),
  ('seatop', 'Proposal delivered to warm lead',
   10, 'soft',
   'medium — the lead cools and has to be re-warmed')
) as m(slug, name, in_days, hardness, cost_of_slip) on m.slug = v.slug
where not exists (
  select 1 from milestones x where x.venture_id = v.id and x.name = m.name
);

-- Outcome targets: results other people decide. No critical path, no slack,
-- never any demand (D1). Linked to the milestones believed to cause them.
insert into outcome_targets (venture_id, name, target_date, indicator_config)
select v.id, o.name, current_date + o.in_days, o.indicator_config::jsonb
from ventures v
join (values
  ('stackwrk', 'First Stackwrk sale', 13,
   '{"indicators":["proposals_sent","demos_booked","follow_ups_open","pipeline_count"]}'),
  ('seatop', 'First Seatop sale', 29,
   '{"indicators":["proposals_sent","demos_booked","follow_ups_open","pipeline_count"]}')
) as o(slug, name, in_days, indicator_config) on o.slug = v.slug
where not exists (
  select 1 from outcome_targets x where x.venture_id = v.id and x.name = o.name
);

insert into outcome_milestones (outcome_id, milestone_id)
select o.id, m.id
from outcome_targets o
join ventures v on v.id = o.venture_id
join milestones m on m.venture_id = v.id
where (o.name, m.name) in (
  ('First Stackwrk sale', 'Site sale-ready: contract, pricing, pages'),
  ('First Seatop sale',   'Proposal delivered to warm lead')
)
on conflict do nothing;

-- Cold start (D4): every context starts at ratio 1.0 with zero samples, so
-- calibration is inert until sample_n >= 8.
insert into calibration (context, ratio, sample_n)
values ('deep_work',1.0,0), ('calls',1.0,0), ('admin',1.0,0), ('errands',1.0,0),
       ('creative',1.0,0), ('review',1.0,0), ('physical',1.0,0)
on conflict (context) do nothing;
