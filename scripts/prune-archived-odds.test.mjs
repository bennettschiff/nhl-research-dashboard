import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prunableDates } from './prune-archived-odds.mjs';

const f = (d) => `nhl_event_odds_${d}.json.gz`;
const TODAY = '2026-10-13';

test('keeps today and yesterday, takes older slates that are on Drive', () => {
  const local = new Map([[f('2026-10-10'), 900], [f('2026-10-11'), 800], [f('2026-10-12'), 700], [f('2026-10-13'), 600]]);
  const drive = new Map(local);
  assert.deepEqual(prunableDates(local, drive, TODAY), ['2026-10-10', '2026-10-11']);
});

test('never prunes a slate missing from Drive', () => {
  const local = new Map([[f('2026-10-06'), 900]]);
  assert.deepEqual(prunableDates(local, new Map(), TODAY), []);
});

test('never prunes a slate whose Drive copy is a different size (stale or partial upload)', () => {
  const local = new Map([[f('2026-10-06'), 900]]);
  assert.deepEqual(prunableDates(local, new Map([[f('2026-10-06'), 512]]), TODAY), []);
});

test('ignores files that are not odds boards', () => {
  const local = new Map([['nhl_picks.json.gz', 10], [f('2026-10-06'), 900]]);
  const drive = new Map(local);
  assert.deepEqual(prunableDates(local, drive, TODAY), ['2026-10-06']);
});
