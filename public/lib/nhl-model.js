/**
 * nhl-model.js — the ONE copy of the NHL projection + pricing math.
 *
 * Loaded two ways, so the page and the ledger can never disagree:
 *   · browser: <script src="lib/nhl-model.js"> → window.NHLModel
 *   · Node:    createRequire(import.meta.url)('../public/lib/nhl-model.js')
 * Pure functions only — no fetch, no DOM, no Date.now(). Callers build the
 * input (see buildInput) from whatever source they have; the backtest builds the
 * identical shape walk-forward, which is what makes its numbers mean anything.
 *
 * ── PUBLIC REFERENCE MODEL ──────────────────────────────────────────────────
 *   The production projection (prior-season fading, power-play weighting,
 *   opponent and venue effects, calibration) is private. This stand-in keeps
 *   the same inputs and output shape:
 *
 *   λ = per-minute rate × projected minutes × opponent shots-against factor
 *
 *   rate     this season's count / minutes, shrunk toward the position-group
 *            league rate (POP_MIN pseudo-minutes)
 *   minutes  season TOI/GP blended with last-5 TOI
 *   goals    λ_sog × shrunk shooting%
 *   SOG      negative binomial (shots are overdispersed); G/A/PTS Poisson.
 *
 *   Against a priced line the probability bet on is anchored to the market:
 *     λ_bet = λ_market · (λ_model / λ_market)^MKT_W[market]
 *   and the edge score is ln(λ_model / λ_market) on the side.
 *
 *   Every number in PARAMS is illustrative, not fitted.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NHLModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODEL_VERSION = 'nhl-public-1';

  // Versions whose edge scores pool for gate decisions (review-gates): the gate
  // lives in score space, so a change that barely moves the score must not
  // reset its evidence. v2.1→v2.2 changed pricing only (identical λ). v2.3 moves
  // λ ~0.6% down everywhere (CAL rescale) and up on the ~11% of rows with a
  // regular teammate out — a score shift of ~0.006, far inside the gate bands.
  // v2.4 (power-play role) moves λ by more on the PP-heavy rows — a PP1 star up
  // a few %, a no-PP depth player down a few % — still well inside the bands.
  var SCORE_VERSIONS = ['nhl-public-1'];

  var MARKETS = ['points', 'goals', 'assists', 'sog'];

  // Fit by scripts/backtest.mjs — see docs/BACKTEST.md for the run that set them.
  var PARAMS = {
    FADE_GP: 40, PRIOR_CAP_MIN: 1000,
    POP_MIN: 300,         // position-group prior, in minutes
    RECENT_W: 0, RECENT_N: 10,
    TOI_PRIOR_GP: 1,
    TOI_RECENT_W: 0.5,    // pull toward last-5 TOI
    SH_K: 150,            // shooting% shrinkage, in shots
    TEAM_K: 20,
    OPP_SOG_EXP: 1.0, OPP_FIN_EXP: 0, OPP_GA_EXP: 0.5,
    HOME: { sog: 1, goals: 1, assists: 1, points: 1 },
    B2B: { sog: 1, goals: 1, assists: 1, points: 1 },
    CAL: { sog: 1, goals: 1, assists: 1, points: 1 },
    SOG_NB_SIZE: 12,      // negative-binomial size for SOG
    MKT_W: { points: 0.5, goals: 0.5, assists: 0.5, sog: 0.5 },
    OUT_TOI_K: 1.0, OUT_REPL_F: 14, OUT_REPL_D: 17,
    PP_W: 0, PP_MIN: [0, 3, 1.5], PP_RANK_N: 3
  };

  var DEFAULT_LEAGUE = {
    F: { sog: 0.128, goals: 0.0138, assists: 0.0198, points: 0.0336, sh: 0.108, toiPG: 15.2 },
    D: { sog: 0.080, goals: 0.0040, assists: 0.0160, points: 0.0200, sh: 0.050, toiPG: 19.8 },
    team: { gaPG: 3.05, saPG: 28.6, gaPerSa: 0.1066 }
  };

  function posGroup(pos) { return pos === 'D' ? 'D' : 'F'; }
  function n(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

  // ── league context from a set of season totals ────────────────────────────
  // skaters: [{pos, toi(sec), shots, goals, assists, points, gp}]; teams: [{gp, ga, sa}]
  function leagueContext(skaters, teams) {
    var acc = { F: { m: 0, sog: 0, goals: 0, assists: 0, points: 0, gp: 0 }, D: { m: 0, sog: 0, goals: 0, assists: 0, points: 0, gp: 0 } };
    (skaters || []).forEach(function (s) {
      var a = acc[posGroup(s.pos)];
      a.m += n(s.toi) / 60; a.sog += n(s.shots); a.goals += n(s.goals);
      a.assists += n(s.assists); a.points += n(s.points); a.gp += n(s.gp);
    });
    var out = { F: {}, D: {}, team: {} };
    ['F', 'D'].forEach(function (g) {
      var a = acc[g];
      if (a.m < 1000) { out[g] = DEFAULT_LEAGUE[g]; return; }
      out[g] = { sog: a.sog / a.m, goals: a.goals / a.m, assists: a.assists / a.m, points: a.points / a.m,
                 sh: a.sog ? a.goals / a.sog : DEFAULT_LEAGUE[g].sh, toiPG: a.gp ? a.m / a.gp : DEFAULT_LEAGUE[g].toiPG };
    });
    var tg = 0, ga = 0, sa = 0;
    (teams || []).forEach(function (t) { tg += n(t.gp); ga += n(t.ga); sa += n(t.sa); });
    out.team = tg >= 100 ? { gaPG: ga / tg, saPG: sa / tg, gaPerSa: sa ? ga / sa : DEFAULT_LEAGUE.team.gaPerSa } : DEFAULT_LEAGUE.team;
    return out;
  }

  // ── the projection ────────────────────────────────────────────────────────
  // input: {
  //   pos, cur:{gp,toi,ppToi,shots,goals,assists,points}, prior:{...}|null,
  //   recent:[{toi,ppToi,shots,goals,assists,points}] newest first, CURRENT season only,
  //   opp:{gp,ga,sa, prior:{gp,ga,sa}|null}, isHome, isB2B,
  //   lineupOut:{F,D} (lineupOut), ppRole: 0|1|2 (ppRoles)
  // }  (toi / ppToi in SECONDS everywhere)
  function project(input, league, params) {
    var P = params || PARAMS, L = league || DEFAULT_LEAGUE;
    var grp = posGroup(input.pos), lg = L[grp];
    var cur = input.cur || {};
    var gp = n(cur.gp);
    var curMin = n(cur.toi) / 60;
    function rate(stat) {
      var num = n(cur[stat === 'sog' ? 'shots' : stat]) + P.POP_MIN * lg[stat];
      return num / (curMin + P.POP_MIN);
    }
    var rec = (input.recent || []).slice(0, 5), l5Min = 0;
    for (var i = 0; i < rec.length; i++) l5Min += n(rec[i].toi) / 60;
    var seasonTpg = gp > 0 ? curMin / gp : lg.toiPG;
    var toiW = rec.length ? P.TOI_RECENT_W * Math.min(1, rec.length / 5) : 0;
    var toiProj = rec.length ? (1 - toiW) * seasonTpg + toiW * (l5Min / rec.length) : seasonTpg;

    var opp = input.opp || {}, op = opp.prior || null, T = L.team;
    var oppSa = op && n(op.gp) > 0 ? 0.5 * (n(op.sa) / n(op.gp)) + 0.5 * T.saPG : T.saPG;
    var oppGa = op && n(op.gp) > 0 ? 0.5 * (n(op.ga) / n(op.gp)) + 0.5 * T.gaPG : T.gaPG;
    var oppSogMult = Math.pow(oppSa / T.saPG, P.OPP_SOG_EXP);
    var oppGaMult = Math.pow(oppGa / T.gaPG, P.OPP_GA_EXP);

    var sh = (n(cur.goals) + P.SH_K * lg.sh) / (n(cur.shots) + P.SH_K);
    var lamSog = rate('sog') * toiProj * oppSogMult;
    var lamG = lamSog * sh;
    var lamA = rate('assists') * toiProj * oppGaMult;
    var lamP = Math.max(rate('points') * toiProj * oppGaMult, lamG);

    return {
      lambda: { sog: lamSog, goals: lamG, assists: lamA, points: lamP },
      toiProj: toiProj,
      shPct: sh,
      priorWeight: 0,
      factors: {
        oppSogMult: oppSogMult, oppGaMult: oppGaMult, oppFinMult: 1,
        toiTrend: seasonTpg > 0 && rec.length >= 3 ? (l5Min / rec.length) / seasonTpg - 1 : 0,
        recentPointRate: null,
        isHome: !!input.isHome, isB2B: !!input.isB2B, lineupOut: 0,
        ppRole: input.ppRole != null ? input.ppRole : null, ppProj: 0
      }
    };
  }

  // ── distributions ─────────────────────────────────────────────────────────
  function poissonCdf(k, lam) { // P(X ≤ k)
    if (k < 0) return 0;
    var term = Math.exp(-lam), sum = term;
    for (var i = 1; i <= k; i++) { term *= lam / i; sum += term; }
    return Math.min(1, sum);
  }
  function nbPmf0(lam, r) { return Math.pow(r / (r + lam), r); }
  function nbCdf(k, lam, r) { // NB with mean lam, size r
    if (!isFinite(r)) return poissonCdf(k, lam);
    if (k < 0) return 0;
    var p = r / (r + lam), q = 1 - p;
    var term = Math.pow(p, r), sum = term;
    for (var i = 1; i <= k; i++) { term *= q * (r + i - 1) / i; sum += term; }
    return Math.min(1, sum);
  }
  function lgamma(x) { // Lanczos
    var c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
    var ser = 1.000000000190015;
    for (var j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  // log-likelihood of an observed count (backtest objective)
  function logLik(market, k, lam, params) {
    var P = params || PARAMS;
    lam = Math.max(lam, 1e-6);
    if (market === 'sog' && isFinite(P.SOG_NB_SIZE)) {
      var r = P.SOG_NB_SIZE;
      return lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(r / (r + lam)) + k * Math.log(lam / (r + lam));
    }
    return k * Math.log(lam) - lam - lgamma(k + 1);
  }

  // P(stat > line) for a half-point line
  function probOver(market, lam, line, params) {
    var P = params || PARAMS, k = Math.floor(line);
    var cdf = market === 'sog' ? nbCdf(k, lam, P.SOG_NB_SIZE) : poissonCdf(k, lam);
    return 1 - cdf;
  }

  // Invert a (no-vig) probability of going over `line` back to the λ that
  // would price it — the market's own projection. Bisection; monotone in λ.
  function lambdaFromProb(market, pOver, line, params) {
    if (!(pOver > 0 && pOver < 1)) return null;
    var lo = 1e-4, hi = 30;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (probOver(market, mid, line, params) < pOver) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ── prices ────────────────────────────────────────────────────────────────
  function americanToDecimal(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function impliedFromAmerican(a) { return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100); }
  // A one-sided market (anytime goal, a book posting only the over) carries its
  // whole margin on the one price. Shaved by this much as a stand-in for the
  // missing under — re-check against the ledger's two-sided books.
  var ONE_SIDED_HOLD = 0.06;
  function noVigOver(overAm, underAm) {
    if (overAm == null) return null;
    var po = impliedFromAmerican(overAm);
    if (underAm == null) return po / (1 + ONE_SIDED_HOLD);
    var pu = impliedFromAmerican(underAm);
    return po / (po + pu);
  }

  // ── score space ───────────────────────────────────────────────────────────
  // score = ln(λ_model / λ_market) on the side we'd bet: + means the model sees
  // MORE than the price implies on that side. Gates live here, not in
  // probability space, so a recalibration can't silently retune them.
  function sideScore(lamModel, lamMarket, side) {
    if (!(lamModel > 0 && lamMarket > 0)) return null;
    var s = Math.log(lamModel / lamMarket);
    return side === 'under' ? -s : s;
  }

  // Shrink the model toward the market in log space: λ_mkt · (λ_model/λ_mkt)^w.
  // The side never flips (w > 0 keeps the sign of the disagreement).
  function blendLambda(lamModel, lamMarket, w) {
    if (!(lamModel > 0 && lamMarket > 0)) return lamModel;
    return lamMarket * Math.pow(lamModel / lamMarket, w);
  }

  // ── the official-play rule ────────────────────────────────────────────────
  // Every priced row is saved and graded; this only stamps is_official.
  // gates: { <market>: { status:'official'|'probation', min, max, sides:['over','under'] } }
  // Lives here (not in a script) so the page's MODEL PLAY badge and the ledger
  // apply the same rule. The initial band is a prior, not a fit: the 2025-26
  // backtest had no prices to fit it against. scripts/review-gates.mjs moves it
  // (and promotes probation markets) from the graded ledger.
  var DEFAULT_GATES = {
    sog:     { status: 'probation', min: 0.05, max: 0.35, priceMin: -200, priceMax: 300, sides: ['over', 'under'] },
    points:  { status: 'probation', min: 0.05, max: 0.35, priceMin: -200, priceMax: 300, sides: ['over', 'under'] },
    goals:   { status: 'probation', min: 0.05, max: 0.35, priceMin: -200, priceMax: 300, sides: ['over', 'under'] },
    assists: { status: 'probation', min: 0.05, max: 0.35, priceMin: -200, priceMax: 300, sides: ['over', 'under'] }
  };
  var MIN_EVIDENCE_GP = 20;
  var MIN_CUR_GP = 3;
  // returns { qualifies, official, reason }
  function gateVerdict(row, gates) {
    var g = (gates || DEFAULT_GATES)[row.market];
    if (!g) return { qualifies: false, official: false, reason: 'no gate' };
    if (!row.priced) return { qualifies: false, official: false, reason: 'no book line' };
    if (row.score == null) return { qualifies: false, official: false, reason: 'unpriceable' };
    // Rookies project off a position average; the book knows his draft slot and
    // his camp. Below this many NHL games (this season + last) we don't bet him.
    if (row.evidenceGp != null && row.evidenceGp < MIN_EVIDENCE_GP) return { qualifies: false, official: false, reason: 'under ' + MIN_EVIDENCE_GP + ' NHL games of evidence' };
    // Role confirmation. Opening night 2026-27 the gate's top SOG plays were all
    // unders on players the book priced ~40% higher than last season implies —
    // new team, bigger minutes, a PP1 spot: things the model only learns from
    // THIS season's TOI. Until he has MIN_CUR_GP games, the row is graded but
    // never qualifies; review-gates can show whether that cost anything.
    if (row.curGp != null && row.curGp < MIN_CUR_GP) return { qualifies: false, official: false, reason: 'role unconfirmed (<' + MIN_CUR_GP + ' GP this season)' };
    if (g.sides.indexOf(row.side) < 0) return { qualifies: false, official: false, reason: row.side + ' side not gated in' };
    if (row.score < g.min) return { qualifies: false, official: false, reason: 'edge below band' };
    if (row.score > g.max) return { qualifies: false, official: false, reason: 'edge above band (model error, not value)' };
    // Juice cap: a −300 under that wins 75% still loses on a 70% day, and a
    // +1000 long shot is a lottery ticket the ledger can't grade in a season.
    if (g.priceMin != null && row.price != null && row.price < 0 && row.price < g.priceMin) return { qualifies: false, official: false, reason: 'price shorter than ' + g.priceMin };
    if (g.priceMax != null && row.price != null && row.price > g.priceMax) return { qualifies: false, official: false, reason: 'price longer than +' + g.priceMax };
    return { qualifies: true, official: g.status === 'official', reason: g.status === 'official' ? 'model play' : 'qualifies — market on probation' };
  }

  // ── odds: raw /events/{id}/odds responses → per-player quotes ───────────
  // Same normalization on both sides of the join (NHL API names vs book names):
  // strip accents, punctuation and suffixes. "Tim Stützle" = "Tim Stutzle".
  function normName(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[.'’\-]/g, ' ').replace(/\b(jr|sr|ii|iii)\b/g, '').replace(/\s+/g, ' ').trim();
  }
  var MAIN_KEY = { player_shots_on_goal: 'sog', player_points: 'points', player_assists: 'assists', player_goals: 'goals' };
  var ALT_KEY = { player_shots_on_goal_alternate: 'sog', player_points_alternate: 'points', player_assists_alternate: 'assists' };

  // returns { normName: { market: { books: { bookKey: { main:{line,over,under,overLink,underLink}, alt:{line:{over,link}} } } } } }
  function quotesFromEvents(events) {
    var out = {};
    function slot(name, market, book) {
      var p = out[name] || (out[name] = {});
      var m = p[market] || (p[market] = { books: {} });
      return m.books[book] || (m.books[book] = { main: null, alt: {} });
    }
    (events || []).forEach(function (ev) {
      ((ev && ev.bookmakers) || []).forEach(function (bk) {
        (bk.markets || []).forEach(function (mk) {
          (mk.outcomes || []).forEach(function (o) {
            var nm = normName(o.description);
            if (!nm) return;
            var market = MAIN_KEY[mk.key], b;
            if (market) {
              b = slot(nm, market, bk.key);
              // Hard Rock posts several Over-only 0.5 goal rows per player; keep
              // the first (main) line per book.
              if (b.main && b.main.line !== o.point) return;
              b.main = b.main || { line: o.point };
              if (o.name === 'Over') { b.main.over = o.price; b.main.overLink = o.link || null; }
              if (o.name === 'Under') { b.main.under = o.price; b.main.underLink = o.link || null; }
            } else if (ALT_KEY[mk.key] && o.name === 'Over' && o.point != null) {
              slot(nm, ALT_KEY[mk.key], bk.key).alt[o.point] = { over: o.price, link: o.link || null };
            } else if (mk.key === 'player_goal_scorer_anytime' && o.name === 'Yes') {
              slot(nm, 'goals', bk.key).alt[0.5] = { over: o.price, link: o.link || null };
            }
          });
        });
      });
    });
    return out;
  }

  // One market's books → the quote the model prices against:
  //   line      the consensus main line (most books; ties → more two-sided, then lower)
  //   fairOver  no-vig P(over) averaged over two-sided books at that line, or
  //             over one-sided prices shaved by ONE_SIDED_HOLD when none are
  //   bestOver / bestUnder  the best price (and book) for each side at that line
  function quoteFor(market, entry) {
    if (!entry || !entry.books) return null;
    var books = entry.books, lines = {};
    Object.keys(books).forEach(function (bk) {
      var m = books[bk].main;
      if (m && m.line != null && (m.over != null || m.under != null)) {
        var l = lines[m.line] || (lines[m.line] = { n: 0, two: 0 });
        l.n++; if (m.over != null && m.under != null) l.two++;
      }
    });
    var cands = Object.keys(lines).map(Number);
    if (!cands.length) cands = market === 'goals' ? [0.5] : [];
    if (!cands.length) return null;
    cands.sort(function (a, b) {
      var A = lines[a] || { n: 0, two: 0 }, B = lines[b] || { n: 0, two: 0 };
      return B.n - A.n || B.two - A.two || a - b;
    });
    var line = cands[0];
    var two = [], one = [], bestOver = null, bestUnder = null;
    Object.keys(books).forEach(function (bk) {
      var m = books[bk].main, over = null, under = null, oLink = null, uLink = null;
      if (m && m.line === line) { over = m.over; under = m.under; oLink = m.overLink; uLink = m.underLink; }
      if (over == null && books[bk].alt[line]) { over = books[bk].alt[line].over; oLink = books[bk].alt[line].link; }
      if (over != null && under != null) two.push(noVigOver(over, under));
      else if (over != null) one.push(noVigOver(over, null));
      if (over != null && (!bestOver || americanToDecimal(over) > americanToDecimal(bestOver.price))) bestOver = { price: over, book: bk, link: oLink };
      if (under != null && (!bestUnder || americanToDecimal(under) > americanToDecimal(bestUnder.price))) bestUnder = { price: under, book: bk, link: uLink };
    });
    var src = two.length ? two : one;
    if (!src.length) return null;
    var fair = src.reduce(function (a, b) { return a + b; }, 0) / src.length;
    return { line: line, fairOver: fair, twoSided: two.length > 0, nBooks: two.length + one.length, bestOver: bestOver, bestUnder: bestUnder };
  }

  // Two skaters on one slate can share a name (VAN carries two Elias
  // Petterssons, F and D). Book outcomes carry only the name, so the line belongs
  // to whichever the book means — in practice the bigger role. Returns the ids
  // that must NOT be priced: every same-name skater but the one projected most
  // points. players: [{ id, name, points }]
  function ambiguousNameIds(players) {
    var groups = {}, skip = {};
    players.forEach(function (p) { var k = normName(p.name); (groups[k] = groups[k] || []).push(p); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length < 2) return;
      g.sort(function (a, b) { return b.points - a.points; });
      g.slice(1).forEach(function (p) { skip[p.id] = true; });
    });
    return skip;
  }

  // ── lineup: who is missing tonight ────────────────────────────────────────
  // lineups: the team's last ≤5 games (any order), each [{ id, pos, toi (sec) }];
  // dressing: { id: true } for tonight's lineup. A regular counts by how much
  // of that window he played (his absence is already partly in his teammates'
  // last-5 TOI otherwise). Returns { F, D } shares, capped at 0.5.
  function lineupOut(lineups, dressing, params) {
    var P = params || PARAMS, repl = { F: P.OUT_REPL_F || 0, D: P.OUT_REPL_D || 0 };
    var by = {}, nG = lineups.length;
    if (!nG) return { F: 0, D: 0 };
    lineups.forEach(function (L) {
      L.forEach(function (p) {
        var b = by[p.id] = by[p.id] || { pos: p.pos, k: 0, min: 0 };
        b.k++; b.min += n(p.toi) / 60;
      });
    });
    var out = { F: 0, D: 0 }, dress = { F: 0, D: 0 };
    Object.keys(by).forEach(function (id) {
      var b = by[id], g = posGroup(b.pos), tpg = b.min / b.k, w = b.k / nG;
      // a call-up takes replacement minutes; only the excess moves up the lineup
      if (dressing[id]) dress[g] += tpg * w; else out[g] += Math.max(0, tpg - repl[g]) * w;
    });
    return {
      F: dress.F > 0 ? Math.min(0.5, out.F / dress.F) : 0,
      D: dress.D > 0 ? Math.min(0.5, out.D / dress.D) : 0
    };
  }

  // ── power-play units: who is on PP1 / PP2 tonight (v2.4) ──────────────────
  // skaters: tonight's dressed skaters on ONE team, each { id, recentPp: [PP
  // seconds, newest first, this season], priorPpPG: last season's PP sec/game
  // or null }. Ranked by mean PP TOI over the last PP_RANK_N games (last season's
  // per-game when he has none yet): top 5 = 1, next 5 = 2, no PP time = 0.
  // ESPN's posted PP units are this same ranking off the last game (299/320
  // skaters matched on 2026-10-25), so the model builds it from NHL data itself.
  function ppRoles(skaters, params) {
    var P = params || PARAMS, N = P.PP_RANK_N || 3;
    var sc = skaters.map(function (s) {
      var r = (s.recentPp || []).slice(0, N), v = 0;
      if (r.length) r.forEach(function (x) { v += n(x) / r.length; });
      else v = n(s.priorPpPG);
      return { id: s.id, v: v };
    });
    sc.sort(function (a, b) { return b.v - a.v; });
    var out = {};
    sc.forEach(function (x, i) { out[x.id] = x.v <= 0 ? 0 : i < 5 ? 1 : i < 10 ? 2 : 0; });
    return out;
  }

  // ── injuries: ESPN's league report → per-skater status ─────────────────────
  // site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries (no key, CORS
  // open). ESPN ids are not NHL ids, so the join is team + normName, with the
  // F/D group breaking a same-name pair (VAN's two Elias Petterssons).
  // Not a model input: OUT/IR/SUSP skaters are left off the slate, DTD is flagged.
  var ESPN_TEAM = { LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL' };
  var INJ_CODE = { INJURY_STATUS_OUT: 'OUT', INJURY_STATUS_IR: 'IR', INJURY_STATUS_DAYTODAY: 'DTD', INJURY_STATUS_SUSPENSION: 'SUSP' };
  var INJ_SIDELINED = { OUT: true, IR: true, SUSP: true };
  function injuryCode(x) {
    var c = INJ_CODE[x.type && x.type.name];
    if (c) return c;
    if (/suspen/i.test(x.status || '')) return 'SUSP';
    if (/injured reserve/i.test(x.status || '')) return 'IR';
    if (/^out$/i.test(x.status || '')) return 'OUT';
    if (/day/i.test(x.status || '')) return 'DTD';
    return String(x.status || 'INJ').toUpperCase();
  }
  // returns { 'TEAM|normName': [{ status, label, type, returnDate, note, date, group, sidelined }] }
  function injuriesFromEspn(json) {
    var out = {};
    ((json && json.injuries) || []).forEach(function (t) {
      (t.injuries || []).forEach(function (x) {
        var a = x.athlete || {}, ab = a.team && a.team.abbreviation;
        if (!ab || !a.displayName) return;
        var team = ESPN_TEAM[ab] || ab, pos = a.position && a.position.abbreviation;
        if (pos === 'G') return;
        var code = injuryCode(x), d = x.details || {};
        // ESPN pads empty notes with the bare status ("day-to-day", "ir-nr")
        var note = x.shortComment && x.shortComment.length > 20 ? x.shortComment : null;
        var key = team + '|' + normName(a.displayName);
        (out[key] = out[key] || []).push({
          status: code, label: (d.fantasyStatus && d.fantasyStatus.abbreviation) || x.status || code,
          type: d.type || null, returnDate: d.returnDate || null, note: note, date: x.date || null,
          group: pos === 'D' ? 'D' : 'F', sidelined: !!INJ_SIDELINED[code]
        });
      });
    });
    return out;
  }
  function injuryFor(map, team, name, pos) {
    var list = map && map[team + '|' + normName(name)];
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    var g = posGroup(pos);
    return list.filter(function (x) { return x.group === g; })[0] || null;
  }

  // ── price one market for one player ───────────────────────────────────────
  // quote from quoteFor() or null. Unpriced rows get the market's standard line
  // so they still grade, but carry no score and can never be official.
  var STANDARD_LINE = { points: 0.5, goals: 0.5, assists: 0.5, sog: 2.5 };
  function priceMarket(market, lam, quote, params) {
    var priced = !!(quote && quote.fairOver > 0 && quote.fairOver < 1);
    var line = priced ? quote.line : STANDARD_LINE[market];
    var pOver = probOver(market, lam, line, params);
    var row = { market: market, line: line, lambda: lam, probOver: pOver, priced: priced, score: null };
    if (!priced) { row.side = pOver >= 0.5 ? 'over' : 'under'; return row; }
    var lamMkt = lambdaFromProb(market, quote.fairOver, line, params);
    var P = params || PARAMS;
    var w = P.MKT_W && P.MKT_W[market] != null ? P.MKT_W[market] : 1;
    var lamBet = lamMkt != null ? blendLambda(lam, lamMkt, w) : lam;
    var pBet = probOver(market, lamBet, line, params);
    // Bet the side the model favors RELATIVE TO THE PRICE, not relative to 50%:
    // a 30% anytime goal against a 20% no-vig price is an over.
    var side = lamMkt != null && lam < lamMkt && quote.bestUnder ? 'under' : 'over';
    var best = side === 'over' ? quote.bestOver : quote.bestUnder;
    row.side = side;
    row.fairOver = quote.fairOver;
    row.twoSided = quote.twoSided;
    row.nBooks = quote.nBooks;
    row.lambdaMarket = lamMkt;
    row.lambdaBet = lamBet;
    row.probSide = side === 'over' ? pBet : 1 - pBet;
    row.fairSide = side === 'over' ? quote.fairOver : 1 - quote.fairOver;
    row.price = best ? best.price : null;
    row.book = best ? best.book : null;
    row.link = best ? best.link : null;
    row.ev = best ? row.probSide * americanToDecimal(best.price) - 1 : null;
    row.score = lamMkt != null ? sideScore(lam, lamMkt, side) : null;
    return row;
  }

  return {
    MODEL_VERSION: MODEL_VERSION, MARKETS: MARKETS, PARAMS: PARAMS, DEFAULT_LEAGUE: DEFAULT_LEAGUE,
    DEFAULT_GATES: DEFAULT_GATES, MIN_EVIDENCE_GP: MIN_EVIDENCE_GP, MIN_CUR_GP: MIN_CUR_GP, STANDARD_LINE: STANDARD_LINE, ONE_SIDED_HOLD: ONE_SIDED_HOLD,
    posGroup: posGroup, leagueContext: leagueContext, project: project,
    poissonCdf: poissonCdf, nbCdf: nbCdf, probOver: probOver, logLik: logLik,
    lambdaFromProb: lambdaFromProb, americanToDecimal: americanToDecimal,
    impliedFromAmerican: impliedFromAmerican, noVigOver: noVigOver, sideScore: sideScore, blendLambda: blendLambda, SCORE_VERSIONS: SCORE_VERSIONS,
    gateVerdict: gateVerdict, priceMarket: priceMarket,
    normName: normName, quotesFromEvents: quotesFromEvents, quoteFor: quoteFor,
    ambiguousNameIds: ambiguousNameIds, injuriesFromEspn: injuriesFromEspn, injuryFor: injuryFor,
    lineupOut: lineupOut, ppRoles: ppRoles
  };
});
