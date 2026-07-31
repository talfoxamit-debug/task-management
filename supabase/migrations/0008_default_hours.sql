-- A normal working week, remembered.
--
-- capacity(available_hours) takes the number as an argument because the engine
-- is pure and must not read anything it was not given. That is right for the
-- engine and wrong for a phone: asking someone to supply the input every time
-- makes the answer feel like homework, and the number barely changes week to
-- week.
--
-- So the workspace remembers a normal week. It stays NULL until set — the
-- system does not invent a working week for anyone, because a made-up number
-- produces a confident answer to a question nobody asked.

begin;

alter table settings
  add column default_weekly_hours numeric
  check (default_weekly_hours is null or (default_weekly_hours > 0 and default_weekly_hours <= 168));

comment on column settings.default_weekly_hours is
  'A normal working week, in hours. NULL means never stated: ask rather than assume.';

commit;
