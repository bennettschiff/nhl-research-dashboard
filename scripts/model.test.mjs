// Golden-value tests for public/lib/nhl-model.js — run with `npm test`.
// If one fails because a formula changed on purpose, update the golden in the
// same commit that bumps MODEL_VERSION.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const M = createRequire(import.meta.url)('../public/lib/nhl-model.js');
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('Poisson P(over 0.5) = 1 − e^−λ', () => near(M.probOver('goals', 0.4, 0.5), 1 - Math.exp(-0.4)));
test('NB SOG reduces to Poisson as size → ∞', () => {
  near(M.probOver('sog', 2.6, 2.5, { ...M.PARAMS, SOG_NB_SIZE: Infinity }), 1 - M.poissonCdf(2, 2.6));
});
test('lambdaFromProb inverts probOver', () => {
  for (const [m, line, lam] of [['sog', 2.5, 2.7], ['points', 0.5, 0.8], ['sog', 1.5, 1.2]]) {
    near(M.lambdaFromProb(m, M.probOver(m, lam, line), line), lam, 1e-3);
  }
});
test('no-vig: two-sided normalizes, one-sided is shaved', () => {
  near(M.noVigOver(-110, -110), 0.5);
  near(M.noVigOver(300, null), 0.25 / (1 + M.ONE_SIDED_HOLD));
});
test('side follows the price, not 50%', () => {
  const r = M.priceMarket('goals', 0.4, { line: 0.5, fairOver: 0.25, bestOver: { price: 300, book: 'fd' }, bestUnder: null });
  assert.equal(r.side, 'over');
  assert.ok(r.score > 0);
});
test('same-name skaters: only the bigger projection is priced', () => {
  const skip = M.ambiguousNameIds([{ id: 1, name: 'Elias Pettersson', points: 0.9 }, { id: 2, name: 'Elias Pettersson', points: 0.2 }, { id: 3, name: 'Tim Stützle', points: 1 }]);
  assert.deepEqual(Object.keys(skip), ['2']);
});
test('normName folds accents and punctuation', () => assert.equal(M.normName("Tim Stützle"), M.normName('Tim Stutzle')));
test('market blend: w=0 is the market, w=1 the model, side and score untouched', () => {
  near(M.blendLambda(0.8, 0.5, 0), 0.5);
  near(M.blendLambda(0.8, 0.5, 1), 0.8);
  near(M.blendLambda(0.8, 0.5, 0.5), Math.sqrt(0.8 * 0.5));
  const q = { line: 0.5, fairOver: 0.4, twoSided: true, bestOver: { price: 150, book: 'dk' }, bestUnder: { price: -170, book: 'fd' } };
  const raw = M.priceMarket('points', 0.8, q, { ...M.PARAMS, MKT_W: { points: 1 } });
  const cal = M.priceMarket('points', 0.8, q);
  assert.equal(cal.side, raw.side);
  near(cal.score, raw.score);
  assert.ok(cal.probSide < raw.probSide && cal.probSide > q.fairOver, `${cal.probSide} not between fair and raw`);
  assert.ok(cal.ev < raw.ev);
});

test('injuriesFromEspn: team codes, status codes, same-name split by F/D', () => {
  const ath = (name, team, pos) => ({ displayName: name, team: { abbreviation: team }, position: { abbreviation: pos } });
  const inj = M.injuriesFromEspn({ injuries: [{ injuries: [
    { athlete: ath('Wyatt Johnston', 'DAL', 'C'), status: 'Out', type: { name: 'INJURY_STATUS_OUT' }, details: { type: 'Illness', returnDate: '2026-10-17' }, shortComment: 'Johnston (illness) will not travel to Colorado.' },
    { athlete: ath('Roope Hintz', 'DAL', 'C'), status: 'Day-To-Day', type: { name: 'INJURY_STATUS_DAYTODAY' }, details: {}, shortComment: 'day-to-day' },
    { athlete: ath('Kevin Fiala', 'LA', 'LW'), status: 'Injured Reserve', type: { name: 'INJURY_STATUS_IR' }, details: {} },
    { athlete: ath('Elias Pettersson', 'VAN', 'D'), status: 'Day-To-Day', type: { name: 'INJURY_STATUS_DAYTODAY' }, details: {} },
    { athlete: ath('Jake Oettinger', 'DAL', 'G'), status: 'Out', type: { name: 'INJURY_STATUS_OUT' }, details: {} },
  ] }] });
  const j = M.injuryFor(inj, 'DAL', 'Wyatt Johnston', 'C');
  assert.equal(j.status, 'OUT'); assert.ok(j.sidelined); assert.equal(j.returnDate, '2026-10-17');
  const h = M.injuryFor(inj, 'DAL', 'Roope Hintz', 'C');
  assert.equal(h.status, 'DTD'); assert.ok(!h.sidelined); assert.equal(h.note, null); // bare-status note dropped
  assert.equal(M.injuryFor(inj, 'LAK', 'Kevin Fiala', 'L').status, 'IR'); // ESPN "LA" = NHL "LAK"
  assert.equal(M.injuryFor(inj, 'DAL', 'Jake Oettinger', 'G'), null);   // goalies skipped
  // one listed Pettersson matches either skater by name; a pair splits by group
  inj['VAN|elias pettersson'].push({ status: 'OUT', group: 'F', sidelined: true });
  assert.equal(M.injuryFor(inj, 'VAN', 'Elias Pettersson', 'C').status, 'OUT');
  assert.equal(M.injuryFor(inj, 'VAN', 'Elias Pettersson', 'D').status, 'DTD');
});

