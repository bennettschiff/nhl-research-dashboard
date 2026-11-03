#!/usr/bin/env node
/**
 * pull_nhl_odds.mjs — tonight's NHL player-prop board → public.nhl_event_odds.
 *
 * The NHL sibling of the NFL lab's scripts/pull_live_odds.mjs. The dashboard
 * (nhl.schiffpicks.com) never calls The Odds API itself: this runs on a schedule
 * (.github/workflows/odds-pull.yml), buys the slate once, and stores each event's
 * raw /events/{id}/odds response. The page reads those rows with the publishable
 * key, so page views cost 0 credits no matter how many people open it.
 *
 * ── COST MODEL ───────────────────────────────────────────────────────────────
 *   /events                     → 0 credits (lists every upcoming NHL game)
 *   /events/{id}/odds           → 1 credit per market RETURNED per region
 * The 4 books below go in `bookmakers=`, which the API bills as one region per
 * group of up to 10 books. So each game is at most MARKETS.length (8) credits,
 * and a market nobody has posted yet is not billed. The actual per-event cost is
 * printed from the x-requests-last header, so the first run measures it.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 * The key is SHARED with the MLB / WNBA / NFL labs (20,000/mo, resets on the 1st).
 *   · dry run unless --live, printing exactly what --live would spend
 *   · only games on the target ET date that have NOT started are priced
 *   · --reserve (default 3000): refuse if the ceiling would take the account
 *     below that — the same floor the NFL pull enforces
 *   · an event priced in the last --skip-fresher-than minutes (default 90) is not
 *     re-bought, so re-running a job that died halfway is cheap
 *   · every live run logs a row to public.odds_credit_log (source `nhl_live`)
 *
 * USAGE
 *   node --env-file=.env scripts/pull_nhl_odds.mjs                 # dry run, today (ET)
 *   node --env-file=.env scripts/pull_nhl_odds.mjs --live
 *   node --env-file=.env scripts/pull_nhl_odds.mjs --date 2026-10-03 --live
 *
 * ENV: ODDS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const API = "https://api.the-odds-api.com/v4";
const SPORT = "icehockey_nhl";
const TZ = "America/New_York";

// Keep in step with fetchOddsData() in public/index.html — these are the markets
// its parser reads. Adding one costs up to 1 credit per game.
const MARKETS = [
  "player_shots_on_goal", "player_shots_on_goal_alternate",
  "player_goals", "player_goal_scorer_anytime",
  "player_assists", "player_assists_alternate",
  "player_points", "player_points_alternate",
];
const BOOKMAKERS = ["draftkings", "fanduel", "fanatics", "hardrockbet"];

const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const LIVE = argv.includes("--live");
const FORCE = argv.includes("--force");
const RESERVE = Number(argOf("--reserve") ?? 3000);
const FRESH_MIN = Number(argOf("--skip-fresher-than") ?? 90);

function etDate(d) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const DATE = argOf("--date") || etDate(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) die(`bad --date "${DATE}" (want YYYY-MM-DD)`);

const KEY = process.env.ODDS_API_KEY;
const SUPA = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) die("ODDS_API_KEY not set");
if (LIVE && (!SUPA || !SERVICE)) die("--live needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");

function die(msg) {
  console.error(`[nhl-odds] ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Supabase REST ────────────────────────────────────────────────────────────
// Retries only the instance being unavailable (5xx/429/408/network), the same
// policy as the other labs' scripts/lib/sb.mjs. Every write here is an upsert
// or a DELETE, so retrying one that actually landed is harmless — except the
// credit-log INSERT, which passes retry:false.
async function sb(path, { method = "GET", body, prefer, retry = true } = {}) {
  const waits = retry ? [5000, 15000, 45000] : [];
  for (let attempt = 0; ; attempt++) {
    let res, err;
    try {
      res = await fetch(`${SUPA}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: SERVICE,
          Authorization: `Bearer ${SERVICE}`,
          "Content-Type": "application/json",
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      err = e;
    }
    const transient = err || res.status >= 500 || res.status === 429 || res.status === 408;
    if (!transient) {
      const txt = await res.text();
      if (!res.ok) throw new Error(`supabase ${method} ${path.split("?")[0]} → ${res.status} ${txt.slice(0, 300)}`);
      return txt ? JSON.parse(txt) : null;
    }
    if (attempt >= waits.length) throw new Error(`supabase ${method} ${path.split("?")[0]} → ${err ? err.message : res.status}`);
    await sleep(waits[attempt]);
  }
}

// ── The Odds API ─────────────────────────────────────────────────────────────
let creditsSpent = 0;
let creditsUsed = null;
let creditsRemaining = null;

async function odds(path, qs = "") {
  const res = await fetch(`${API}${path}?apiKey=${KEY}${qs ? "&" + qs : ""}`, { signal: AbortSignal.timeout(30000) });
  const last = Number(res.headers.get("x-requests-last") || 0);
  const used = res.headers.get("x-requests-used");
  const rem = res.headers.get("x-requests-remaining");
  if (used != null) creditsUsed = Number(used);
  if (rem != null) creditsRemaining = Number(rem);
  creditsSpent += last;
  const txt = await res.text();
  if (!res.ok) throw new Error(`odds ${path} → ${res.status} ${txt.slice(0, 300)}`);
  return { json: JSON.parse(txt), cost: last };
}

// ── 1. slate (free) ──────────────────────────────────────────────────────────
const { json: events } = await odds(`/sports/${SPORT}/events`);
const now = Date.now();
const onDate = events.filter((e) => etDate(new Date(e.commence_time)) === DATE);
const upcoming = onDate.filter((e) => new Date(e.commence_time).getTime() > now);
console.log(`[nhl-odds] ${DATE}: ${onDate.length} games listed, ${upcoming.length} not yet started (of ${events.length} upcoming NHL events)`);

// ── 2. skip anything priced recently ─────────────────────────────────────────
let targets = upcoming;
if (!FORCE && upcoming.length && SUPA && SERVICE) {
  const since = new Date(now - FRESH_MIN * 60000).toISOString();
  const fresh = await sb(
    `nhl_event_odds?select=event_id&event_id=in.(${upcoming.map((e) => e.id).join(",")})&pulled_at=gte.${since}`,
  );
  const freshIds = new Set(fresh.map((r) => r.event_id));
  targets = upcoming.filter((e) => !freshIds.has(e.id));
  if (freshIds.size) console.log(`[nhl-odds] skipping ${freshIds.size} priced in the last ${FRESH_MIN} min (--force to re-buy)`);
}

const ceiling = targets.length * MARKETS.length;
console.log(`[nhl-odds] ceiling ${ceiling} credits (${targets.length} games × ${MARKETS.length} markets × 1 region) · account remaining ${creditsRemaining} · reserve ${RESERVE}`);
for (const e of targets) console.log(`           ${e.commence_time}  ${e.away_team} @ ${e.home_team}`);

if (!targets.length) {
  console.log("[nhl-odds] nothing to buy");
  process.exit(0);
}
if (creditsRemaining != null && creditsRemaining - ceiling < RESERVE) {
  die(`refusing: ${creditsRemaining} remaining − ${ceiling} ceiling would drop below the ${RESERVE} reserve`);
}
if (!LIVE) {
  console.log("[nhl-odds] dry run — pass --live to buy");
  process.exit(0);
}

// ── 3. buy + store, one event at a time ──────────────────────────────────────
const qs = `markets=${MARKETS.join(",")}&oddsFormat=american&bookmakers=${BOOKMAKERS.join(",")}&includeLinks=true&includeSids=true`;
let stored = 0;
for (const [i, e] of targets.entries()) {
  if (i > 0) await sleep(300);
  try {
    const { json, cost } = await odds(`/sports/${SPORT}/events/${e.id}/odds`, qs);
    const marketKeys = new Set();
    for (const bk of json.bookmakers || []) for (const m of bk.markets || []) marketKeys.add(m.key);
    await sb("nhl_event_odds?on_conflict=event_id", {
      method: "POST",
      prefer: "return=minimal,resolution=merge-duplicates",
      body: [{
        event_id: e.id,
        game_date: DATE,
        commence_time: e.commence_time,
        home_team: e.home_team,
        away_team: e.away_team,
        markets: marketKeys.size,
        data: json,
        pulled_at: new Date().toISOString(),
      }],
    });
    stored++;
    console.log(`[nhl-odds] ${e.away_team} @ ${e.home_team}: ${cost} credits · ${marketKeys.size} markets · ${(json.bookmakers || []).map((b) => b.key).join(",") || "no books yet"}`);
  } catch (err) {
    // An error response is not billed; move on so one bad event can't cost the rest.
    console.warn(`[nhl-odds] ${e.away_team} @ ${e.home_team} skipped: ${err.message}`);
  }
}

// ── 4. no prune here — old boards leave Supabase in backup-to-drive.yml, only
// after their file is confirmed on Drive (scripts/prune-archived-odds.mjs).

// ── 5. log the spend to the SHARED ledger ────────────────────────────────────
try {
  await sb("odds_credit_log", {
    method: "POST",
    prefer: "return=minimal",
    retry: false,
    body: [{ game_date: DATE, source: "nhl_live", credits_used: creditsUsed, credits_remaining: creditsRemaining }],
  });
} catch (err) {
  console.warn(`[nhl-odds] could not write odds_credit_log: ${err.message}`);
}

console.log(`[nhl-odds] done — ${stored}/${targets.length} games stored · spent ${creditsSpent} (ceiling ${ceiling}) · account used ${creditsUsed}, remaining ${creditsRemaining}`);
if (stored === 0) process.exit(1);
