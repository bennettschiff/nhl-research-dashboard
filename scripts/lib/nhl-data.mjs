/**
 * nhl-data.mjs — bulk NHL stats pulls for the Node side (backtest, daily ledger).
 *
 * The legacy stats API (api.nhle.com/stats/rest) returns per-GAME rows for every
 * skater in a season in a handful of paged calls, where the per-player game-log
 * API would need ~900. Finished seasons are cached to scripts/cache/ (gitignored)
 * because they never change; the current season is always re-pulled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const NHLModel = createRequire(import.meta.url)(path.join(ROOT, 'public/lib/nhl-model.js'));

const LEGACY = 'https://api.nhle.com/stats/rest/en';
export const WEB = 'https://api-web.nhle.com/v1';
const CACHE = path.join(ROOT, 'scripts', 'cache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJSON(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'nhl-props-lab' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

function cached(name, finished, fn) {
  const file = path.join(CACHE, name + '.json');
  if (finished && fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  return fn().then((data) => {
    if (finished) {
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    }
    return data;
  });
}

// Regular season only. Without gameTypeId=2 every playoff skater gets a second
// row that overwrites the regular-season one.
function exp(seasonId, extra) {
  return encodeURIComponent(`seasonId=${seasonId} and gameTypeId=2${extra ? ' and ' + extra : ''}`);
}

// The API hard-caps every query at 10,000 rows and ignores `start` past it
// (a full season of skater-games is ~47k), so per-game reports are pulled in
// half-month gameDate windows (~4k rows each) instead of pages.
async function paged(report, seasonId, isGame, extra) {
  const q = (e) => getJSON(`${LEGACY}/${report}?isAggregate=false&isGame=${isGame}&limit=-1&cayenneExp=${e}`)
    .then((d) => (d && d.data) || []);
  if (!isGame) return q(exp(seasonId, extra));
  const y = Number(String(seasonId).slice(0, 4));
  const edges = [];
  for (let m = 8; m <= 19; m++) { // Sept of start year → July of end year
    const yy = y + Math.floor(m / 12), mm = (m % 12) + 1;
    const ym = `${yy}-${String(mm).padStart(2, '0')}`;
    edges.push(`${ym}-01`, `${ym}-16`);
  }
  edges.push(`${y + 1}-08-01`);
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const rows = await q(exp(seasonId, `gameDate>="${edges[i]}" and gameDate<"${edges[i + 1]}"${extra ? ' and ' + extra : ''}`));
    if (rows.length >= 10000) throw new Error(`${report} ${edges[i]} window hit the 10k cap`);
    out.push(...rows);
  }
  return out;
}

export function currentSeasonId(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const start = m >= 9 ? y : y - 1; // regular season opens late Sept / early Oct
  return `${start}${start + 1}`;
}
export function priorSeasonId(seasonId) {
  const s = Number(String(seasonId).slice(0, 4)) - 1;
  return `${s}${s + 1}`;
}

// Per-game skater rows: summary (counts) joined to timeonice (TOI split, shifts).
export async function skaterGames(seasonId, { finished = false } = {}) {
  return cached(`skater-games-${seasonId}`, finished, async () => {
    const [summ, toi] = await Promise.all([
      paged('skater/summary', seasonId, true),
      paged('skater/timeonice', seasonId, true),
    ]);
    const t = new Map(toi.map((r) => [r.playerId + ':' + r.gameId, r]));
    return summ.map((r) => {
      const x = t.get(r.playerId + ':' + r.gameId) || {};
      return {
        playerId: r.playerId, gameId: r.gameId, date: r.gameDate, team: r.teamAbbrev,
        opp: r.opponentTeamAbbrev, home: r.homeRoad === 'H', pos: r.positionCode,
        name: r.skaterFullName,
        toi: r.timeOnIcePerGame || x.timeOnIce || 0, ppToi: x.ppTimeOnIce || 0, shifts: x.shifts || 0,
        shots: r.shots || 0, goals: r.goals || 0, assists: r.assists || 0, points: r.points || 0,
        ppPoints: r.ppPoints || 0,
      };
    });
  });
}

// Season totals per skater (one row each), same field names as skaterGames.
export async function skaterTotals(seasonId, { finished = false } = {}) {
  return cached(`skater-totals-${seasonId}`, finished, async () => {
    const [summ, toi] = await Promise.all([
      paged('skater/summary', seasonId, false),
      paged('skater/timeonice', seasonId, false),
    ]);
    const t = new Map(toi.map((r) => [r.playerId, r]));
    return summ.map((r) => {
      const x = t.get(r.playerId) || {};
      return {
        playerId: r.playerId, pos: r.positionCode, name: r.skaterFullName, gp: r.gamesPlayed || 0,
        toi: x.timeOnIce || (r.timeOnIcePerGame || 0) * (r.gamesPlayed || 0), ppToi: x.ppTimeOnIce || 0,
        shots: r.shots || 0, goals: r.goals || 0, assists: r.assists || 0, points: r.points || 0,
      };
    });
  });
}

// Per-game team rows → { team, opp, date, gameId, home, ga, sa, gf, sf }
export async function teamGames(seasonId, { finished = false } = {}) {
  return cached(`team-games-${seasonId}`, finished, async () => {
    const d = await getJSON(`${LEGACY}/team/summary?isAggregate=false&isGame=true&limit=-1&cayenneExp=${exp(seasonId)}`);
    return ((d && d.data) || []).map((r) => ({
      team: abbrevOf(r.teamFullName), opp: r.opponentTeamAbbrev, date: r.gameDate, gameId: r.gameId,
      home: r.homeRoad === 'H', ga: r.goalsAgainst || 0, gf: r.goalsFor || 0,
      sa: r.shotsAgainstPerGame || 0, sf: r.shotsForPerGame || 0,
    }));
  });
}

// team/summary has no abbreviation column; map full names (and survive renames).
const TEAM_ABBR = {
  'Anaheim Ducks': 'ANA', 'Arizona Coyotes': 'ARI', 'Boston Bruins': 'BOS', 'Buffalo Sabres': 'BUF',
  'Calgary Flames': 'CGY', 'Carolina Hurricanes': 'CAR', 'Chicago Blackhawks': 'CHI',
  'Colorado Avalanche': 'COL', 'Columbus Blue Jackets': 'CBJ', 'Dallas Stars': 'DAL',
  'Detroit Red Wings': 'DET', 'Edmonton Oilers': 'EDM', 'Florida Panthers': 'FLA',
  'Los Angeles Kings': 'LAK', 'Minnesota Wild': 'MIN', 'Montréal Canadiens': 'MTL',
  'Montreal Canadiens': 'MTL', 'Nashville Predators': 'NSH', 'New Jersey Devils': 'NJD',
  'New York Islanders': 'NYI', 'New York Rangers': 'NYR', 'Ottawa Senators': 'OTT',
  'Philadelphia Flyers': 'PHI', 'Pittsburgh Penguins': 'PIT', 'San Jose Sharks': 'SJS',
  'Seattle Kraken': 'SEA', 'St. Louis Blues': 'STL', 'Tampa Bay Lightning': 'TBL',
  'Toronto Maple Leafs': 'TOR', 'Utah Hockey Club': 'UTA', 'Utah Mammoth': 'UTA',
  'Vancouver Canucks': 'VAN', 'Vegas Golden Knights': 'VGK', 'Washington Capitals': 'WSH',
  'Winnipeg Jets': 'WPG',
};
function abbrevOf(full) { return TEAM_ABBR[full] || full; }

// Season totals per team → { team: {gp, ga, sa} }
export function teamTotals(games) {
  const out = {};
  for (const g of games) {
    const t = out[g.team] || (out[g.team] = { gp: 0, ga: 0, sa: 0, gf: 0 });
    t.gp++; t.ga += g.ga; t.sa += g.sa; t.gf += g.gf;
  }
  return out;
}

// League context the model normalizes against, from one season's totals.
export function leagueFrom(skTotals, tmTotals) {
  return NHLModel.leagueContext(
    skTotals.map((s) => ({ pos: s.pos, toi: s.toi, shots: s.shots, goals: s.goals, assists: s.assists, points: s.points, gp: s.gp })),
    Object.values(tmTotals).map((t) => ({ gp: t.gp, ga: t.ga, sa: t.sa })),
  );
}

// ET calendar date (games are scheduled in ET)
export function etDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addDays(ymd, k) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}
