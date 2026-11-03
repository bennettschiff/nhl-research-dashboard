-- nhl_picks: injury report + lineup context (2026-10-14, nhl-v2.3).
--
-- injury_status: the skater's own ESPN status at snapshot time — 'DTD' rows are
--   snapshotted (they usually play); OUT / IR / SUSP skaters are left off the
--   slate, and a row written before one was ruled out keeps its row with the
--   new status (it grades void if he sits). null = not on the report.
-- lineup_out: share of his F/D group's recent minutes (above replacement level)
--   missing tonight — the input to the v2.3 TOI bump (nhl-model.js lineupOut).
alter table public.nhl_picks
  add column if not exists injury_status text,
  add column if not exists lineup_out    numeric;
