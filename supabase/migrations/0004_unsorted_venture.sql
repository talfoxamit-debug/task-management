-- tasks.venture_id is NOT NULL, but capture() takes raw text with no parsing and
-- therefore cannot know a venture yet. Rather than weaken the constraint or make
-- capture() guess, inbox items are parked against a holding venture until
-- process_inbox proposes a real one and commit_tasks confirms it.
--
-- active = false is what makes this safe: computeDemand skips inactive ventures
-- entirely, so the holding venture can never take a share of the week or appear
-- in the slip ranking. strategic_weight sits at the schema minimum so anything
-- still parked here ranks below real work.

insert into ventures (name, slug, strategic_weight, floor_share, ceiling_share, active)
values ('Unsorted inbox', 'unsorted', 0.3, 0.0, 0.1, false)
on conflict (slug) do update
  set active = false,
      strategic_weight = 0.3;
