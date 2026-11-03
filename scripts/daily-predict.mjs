#!/usr/bin/env node
/**
 * daily-predict.mjs — the NHL ledger loop (GitHub Actions: daily-predict.yml).
 *
 *   1. GRADE   every ungraded nhl_picks row whose game is final, from the
 *              official boxscore. A skater missing from the box = void (hit null).
 *   2. PREDICT the slate: every skater on each team's current roster (who has
 *              played in one of his team's last 3 games, once his team has
 *              played, and is not OUT / IR / suspended on ESPN's injury report)
 *              × points/goals/assists/SOG, priced against the stored odds board
 *              (nhl_event_odds) and gated by public/lib/nhl-gates.json. Regulars
 *              missing from that slate hand their minutes on (lineupOut, v2.3);
 *              the slate's top 5 / next 5 by recent PP TOI are PP1 / PP2
 *              (ppRoles, v2.4).
 *              Only games that have NOT started are written, so a row's last
 *              rewrite is always pre-puck-drop — the snapshot that grades.
 *
 * The projection is public/lib/nhl-model.js — the same file the page runs.
 * Inputs come from the same sources the backtest walks: this season's per-game
 * rows (NHL stats API), last season's totals as the fading prior, opponent
 * season-to-date shrunk toward last season.
 *
 *   node scripts/daily-predict.mjs --dry-run            # no secrets needed
 *   node --env-file=.env scripts/daily-predict.mjs      # grade + predict today (ET)
 *   node --env-file=.env scripts/daily-predict.mjs --date 2026-10-02
 *   node --env-file=.env scripts/daily-predict.mjs --grade-only
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  NHLModel as M, ROOT, WEB, getJSON, skaterGames, skaterTotals, teamGames, teamTotals, leagueFrom,
  currentSeasonId, priorSeasonId, etDate, addDays,
} from './lib/nhl-data.mjs';
import { sbGetAll, sbUpsert, sbPatch, canWrite } from './lib/sb.mjs';

const ESPN_INJURIES = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';

const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = argv.includes('--dry-run');
const GRADE_ONLY = argv.includes('--grade-only');
// test hook: price games that already started (dry run only — never written)
const INCLUDE_STARTED = DRY && argv.includes('--include-started');
const DATE = argOf('--date') || etDate();
if (!DRY && !canWrite) { console.error('SUPABASE_SERVICE_ROLE_KEY missing (use --dry-run)'); process.exit(1); }

const GATES = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/lib/nhl-gates.json'), 'utf8')).gates;
const now = new Date();
console.log(`NHL ledger — slate ${DATE} (ET) · ${M.MODEL_VERSION}${DRY ? ' · DRY RUN' : ''}`);

// ── 1. GRADE ────────────────────────────────────────────────────────────────
async function grade() {
  const pending = await sbGetAll(`nhl_picks?graded_at=is.null&game_date=lte.${DATE}&select=id,game_id,game_date,player_id,market,line,side,price,priced`);
  if (!pending.length) { console.log('── GRADE — nothing pending'); return; }
  const byGame = new Map();
  for (const r of pending) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }
  let graded = 0, voided = 0, waiting = 0;
  for (const [gameId, rows] of byGame) {
    const box = await getJSON(`${WEB}/gamecenter/${gameId}/boxscore`);
    const state = box && box.gameState;
    const final = state === 'OFF' || state === 'FINAL';
    const stale = rows[0].game_date < addDays(DATE, -2);
    // postponed / cancelled and two days gone: void the lot
    const dead = !final && (box?.gameScheduleState === 'PPD' || box?.gameScheduleState === 'CNCL' || stale);
    if (!final && !dead) { waiting += rows.length; continue; }
    const stats = new Map();
    if (final) {
      for (const side of ['awayTeam', 'homeTeam']) {
        const t = box.playerByGameStats?.[side] || {};
        for (const p of [...(t.forwards || []), ...(t.defense || [])]) {
          stats.set(p.playerId, { points: p.points || 0, goals: p.goals || 0, assists: p.assists || 0, sog: p.sog || 0 });
        }
      }
    }
    for (const r of rows) {
      const s = stats.get(Number(r.player_id));
      const patch = { graded_at: new Date().toISOString() };
      if (!s) { Object.assign(patch, { actual: null, hit: null, units: null }); voided++; }
      else {
        const actual = s[r.market];
        const hit = r.side === 'over' ? actual > Number(r.line) : actual < Number(r.line);
        const units = r.priced && r.price != null ? (hit ? M.americanToDecimal(r.price) - 1 : -1) : null;
        Object.assign(patch, { actual, hit, units: units == null ? null : +units.toFixed(4) });
        graded++;
      }
      if (!DRY) await sbPatch('nhl_picks', `id=eq.${r.id}`, patch);
    }
  }
  console.log(`── GRADE — graded ${graded}, voided ${voided} (did not play), ${waiting} waiting on games in progress`);
}

async function scorecard() {
  const rows = await sbGetAll(`nhl_picks?hit=not.is.null&select=market,hit,units,is_official,qualifies,priced,model_version`);
  if (!rows.length) return;
  const line = (label, rs) => {
    if (!rs.length) return;
    const w = rs.filter((r) => r.hit).length, u = rs.reduce((a, r) => a + (Number(r.units) || 0), 0);
    const priced = rs.filter((r) => r.units != null).length;
    console.log(`  ${label.padEnd(22)} ${w}-${rs.length - w} (${(100 * w / rs.length).toFixed(1)}%)  ${u >= 0 ? '+' : ''}${u.toFixed(2)}u on ${priced} priced`);
  };
  console.log('── SCORECARD (season to date)');
  for (const m of M.MARKETS) {
    line(`${m} official`, rows.filter((r) => r.market === m && r.is_official));
    line(`${m} qualifying`, rows.filter((r) => r.market === m && r.qualifies));
  }
}

// ── 2. PREDICT ──────────────────────────────────────────────────────────────
async function predict() {
  const sched = await getJSON(`${WEB}/schedule/${DATE}`);
  const day = (sched?.gameWeek || []).find((d) => d.date === DATE);
  const games = (day?.games || []).filter((g) => g.gameType === 2);
  if (!day) console.log(`  schedule returned no ${DATE} day`);
  const open = games.filter((g) => INCLUDE_STARTED || (new Date(g.startTimeUTC) > now && (g.gameState === 'FUT' || g.gameState === 'PRE')));
  console.log(`── PREDICT — ${games.length} games on ${DATE}, ${open.length} not started`);
  if (!open.length) return;

  const season = currentSeasonId(new Date(DATE + 'T12:00:00Z'));
  const prior = priorSeasonId(season);
  const [curGames, priorTot, curTeamGames, priorTeamGames] = await Promise.all([
    skaterGames(season), skaterTotals(prior, { finished: true }), teamGames(season), teamGames(prior, { finished: true }),
  ]);
  const league = leagueFrom(priorTot, teamTotals(priorTeamGames));
  const priorBy = new Map(priorTot.map((s) => [s.playerId, s]));
  const priorTeams = teamTotals(priorTeamGames);
  // this season BEFORE today only (a --date in the past must not see its own games)
  const before = curGames.filter((g) => g.date < DATE && g.toi > 0).sort((a, b) => (a.date < b.date ? 1 : -1));
  const curTeams = teamTotals(curTeamGames.filter((t) => t.date < DATE));
  const cur = new Map(), recent = new Map();
  for (const g of before) {
    const c = cur.get(g.playerId) || { gp: 0, toi: 0, ppToi: 0, shots: 0, goals: 0, assists: 0, points: 0 };
    c.gp++; c.toi += g.toi; c.ppToi += g.ppToi; c.shots += g.shots; c.goals += g.goals; c.assists += g.assists; c.points += g.points;
    cur.set(g.playerId, c);
    const r = recent.get(g.playerId) || [];
    if (r.length < 10) r.push({ toi: g.toi, ppToi: g.ppToi, shots: g.shots, goals: g.goals, assists: g.assists, points: g.points });
    recent.set(g.playerId, r);
  }
  // who dressed in each team's last 3 games; each team's last 5 lineups
  const teamLast3 = new Map(), teamLineups = new Map();
  for (const t of new Set(curTeamGames.map((x) => x.team))) {
    const dates = curTeamGames.filter((x) => x.team === t && x.date < DATE).map((x) => x.date).sort().slice(-5);
    const ids = new Set(before.filter((g) => g.team === t && dates.slice(-3).includes(g.date)).map((g) => g.playerId));
    teamLast3.set(t, ids);
    teamLineups.set(t, dates.map((d) => before.filter((g) => g.team === t && g.date === d).map((g) => ({ id: g.playerId, pos: g.pos, toi: g.toi }))));
  }
  // ESPN injury report. Unreachable → no OUT/IR filter, said loudly; the
  // last-3 rule still holds.
  let injuries = {};
  try {
    injuries = M.injuriesFromEspn(await getJSON(ESPN_INJURIES));
    console.log(`  injury report: ${Object.keys(injuries).length} skaters listed`);
  } catch (e) {
    console.log(`  ⚠ injury report unavailable (${e.message}) — OUT/IR skaters are not filtered`);
  }
  const sidelined = []; // [{ gameId, playerId, status }] — rows already written get the status
  const playedYesterday = new Set(curTeamGames.filter((t) => t.date === addDays(DATE, -1)).map((t) => t.team));

  // odds board
  const events = (await sbGetAll(`nhl_event_odds?game_date=eq.${DATE}&select=data`)).map((r) => r.data);
  const quotes = M.quotesFromEvents(events);
  console.log(`  odds board: ${events.length} events, ${Object.keys(quotes).length} players quoted`);

  // pass 1: project every eligible skater on the slate
  const slate = [];
  for (const g of open) {
    for (const [team, opp, isHome] of [[g.awayTeam.abbrev, g.homeTeam.abbrev, false], [g.homeTeam.abbrev, g.awayTeam.abbrev, true]]) {
      const roster = await getJSON(`${WEB}/roster/${team}/current`);
      const skaters = [...(roster?.forwards || []), ...(roster?.defensemen || [])];
      const last3 = teamLast3.get(team);
      const oc = curTeams[opp] || { gp: 0, ga: 0, sa: 0 }, op = priorTeams[opp];
      const dressing = [];
      for (const s of skaters) {
        const name = `${s.firstName.default} ${s.lastName.default}`;
        const inj = M.injuryFor(injuries, team, name, s.positionCode);
        if (inj && inj.sidelined) { sidelined.push({ gameId: g.id, playerId: s.id, name, status: inj.status }); continue; }
        if (last3 && last3.size && !last3.has(s.id)) continue; // scratched / injured lately
        dressing.push({ s, name, inj });
      }
      // who is missing from the recent lineups (sidelined, scratched, traded, sent down)
      const out = M.lineupOut(teamLineups.get(team) || [], Object.fromEntries(dressing.map((x) => [x.s.id, true])));
      // tonight's PP units (v2.4): the dressing skaters ranked by recent PP TOI
      const pp = M.ppRoles(dressing.map(({ s }) => {
        const p = priorBy.get(s.id);
        return { id: s.id, recentPp: (recent.get(s.id) || []).map((x) => x.ppToi), priorPpPG: p && p.gp ? p.ppToi / p.gp : null };
      }));
      for (const { s, name, inj } of dressing) {
        const p = priorBy.get(s.id);
        const input = {
          pos: s.positionCode,
          cur: cur.get(s.id) || { gp: 0, toi: 0, ppToi: 0, shots: 0, goals: 0, assists: 0, points: 0 },
          prior: p ? { gp: p.gp, toi: p.toi, ppToi: p.ppToi, shots: p.shots, goals: p.goals, assists: p.assists, points: p.points } : null,
          recent: recent.get(s.id) || [],
          opp: { gp: oc.gp, ga: oc.ga, sa: oc.sa, prior: op ? { gp: op.gp, ga: op.ga, sa: op.sa } : null },
          isHome, isB2B: playedYesterday.has(team), lineupOut: out, ppRole: pp[s.id],
        };
        if (!input.cur.gp && !input.prior) continue; // no NHL games to stand on
        const proj = M.project(input, league);
        if (!proj) continue;
        slate.push({ g, team, opp, isHome, s, input, proj, name, inj });
      }
    }
  }
  // pass 2: price + gate
  const noPrice = M.ambiguousNameIds(slate.map((x) => ({ id: x.s.id, name: x.name, points: x.proj.lambda.points })));
  const rows = [];
  for (const { g, team, opp, isHome, s, input, proj, name, inj } of slate) {
    const q = noPrice[s.id] ? {} : (quotes[M.normName(name)] || {});
    for (const market of M.MARKETS) {
      const pr = M.priceMarket(market, proj.lambda[market], M.quoteFor(market, q[market]));
      pr.evidenceGp = input.cur.gp + (input.prior ? input.prior.gp : 0);
      pr.curGp = input.cur.gp;
      const v = M.gateVerdict(pr, GATES);
      rows.push({
        game_date: DATE, game_id: g.id, start_time: g.startTimeUTC, player_id: s.id, player: name,
        team, opp, is_home: isHome, position: s.positionCode, market,
        line: pr.line, side: pr.side, lambda: +pr.lambda.toFixed(4), prob_over: +pr.probOver.toFixed(4),
        prob_side: pr.probSide != null ? +pr.probSide.toFixed(4) : +(pr.side === 'over' ? pr.probOver : 1 - pr.probOver).toFixed(4),
        priced: pr.priced, fair_over: pr.fairOver != null ? +pr.fairOver.toFixed(4) : null,
        fair_side: pr.fairSide != null ? +pr.fairSide.toFixed(4) : null,
        lambda_market: pr.lambdaMarket != null ? +pr.lambdaMarket.toFixed(4) : null,
        two_sided: pr.twoSided ?? null, n_books: pr.nBooks ?? null, price: pr.price ?? null, book: pr.book ?? null,
        ev: pr.ev != null ? +pr.ev.toFixed(4) : null, score: pr.score != null ? +pr.score.toFixed(4) : null,
        qualifies: v.qualifies, is_official: v.official, gate_status: GATES[market]?.status || null, gate_reason: v.reason,
        gp: input.cur.gp, evidence_gp: pr.evidenceGp, prior_weight: +proj.priorWeight.toFixed(3), toi_proj: +proj.toiProj.toFixed(2),
        injury_status: inj ? inj.status : null, lineup_out: +proj.factors.lineupOut.toFixed(4),
        model_version: M.MODEL_VERSION, snapshot_at: now.toISOString(),
      });
    }
  }
  const players = new Set(rows.map((r) => r.player_id)).size;
  const priced = rows.filter((r) => r.priced).length;
  console.log(`  ${rows.length} rows · ${players} skaters · ${priced} priced · ${rows.filter((r) => r.qualifies).length} qualify · ${rows.filter((r) => r.is_official).length} official`);
  for (const m of M.MARKETS) {
    const off = rows.filter((r) => r.market === m && r.qualifies).sort((a, b) => b.score - a.score);
    for (const r of off.slice(0, 5)) {
      console.log(`   ${r.is_official ? '★' : '·'} ${m.padEnd(7)} ${r.player.padEnd(22)} ${r.side.padEnd(5)} ${r.line} ${r.price > 0 ? '+' : ''}${r.price} ${r.book}  model ${(r.prob_side * 100).toFixed(0)}% vs fair ${(r.fair_side * 100).toFixed(0)}%  score ${r.score}`);
    }
  }
  if (sidelined.length) console.log(`  left off (injury report): ${sidelined.map((x) => `${x.name} ${x.status}`).join(', ')}`);
  const lo = slate.filter((x) => x.proj.factors.lineupOut >= 0.02).sort((a, b) => b.proj.factors.lineupOut - a.proj.factors.lineupOut);
  if (lo.length) console.log(`  teammates out: ${[...new Set(lo.map((x) => `${x.team} ${x.s.positionCode === 'D' ? 'D' : 'F'} +${(100 * x.proj.factors.lineupOut).toFixed(0)}% TOI`))].join(', ')}`);
  const pp1 = {};
  slate.filter((x) => x.input.ppRole === 1).forEach((x) => { (pp1[x.team] = pp1[x.team] || []).push(x.s.lastName.default); });
  if (Object.keys(pp1).length) console.log(`  PP1: ${Object.entries(pp1).map(([t, ns]) => `${t} ${ns.join('/')}`).join(' · ')}`);
  if (argOf('--out')) fs.writeFileSync(argOf('--out'), JSON.stringify(rows, null, 1));
  if (DRY) { console.log('  (dry run — nothing written)'); return; }
  if (rows.length) await sbUpsert('nhl_picks', rows, 'game_date,player_id,market');
  console.log(`  upserted ${rows.length} rows into nhl_picks`);
  // ruled out after an earlier snapshot: keep the row (it grades void if he
  // sits), but say why it is there
  for (const x of sidelined) {
    await sbPatch('nhl_picks', `game_date=eq.${DATE}&game_id=eq.${x.gameId}&player_id=eq.${x.playerId}&graded_at=is.null`, { injury_status: x.status });
  }
}

await grade();
await scorecard();
if (!GRADE_ONLY) await predict();
