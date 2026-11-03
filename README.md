# NHL Research Dashboard

A nightly NHL player research dashboard: shots on goal, goals, assists and
points projections for every skater, matchup and deployment context, prices
from four books, and a ledger that snapshots every projection before puck
drop and grades it after.

**Live:** https://nhl.schiffpicks.com · Vanilla JS (no build step) · Vercel functions · Supabase · GitHub Actions

> **About this repository.** This is a public showcase copy of a private repo.
> It contains the real page, the serverless proxy, the nightly predict-and-grade
> job, the ledger schema and the tests. **The production model and its
> calibration are private.** `public/lib/nhl-model.js` keeps the same API and
> pricing code, but `project()` is a simplified stand-in (shrunk per-minute rate
> × projected minutes × an opponent factor) and every parameter is
> illustrative. The backtest and git history are not included.

<!-- Screenshot: add docs/screenshot.png and uncomment
![NHL Research Dashboard](docs/screenshot.png)
-->

## What it does

- **Slate and player cards.** Tonight's games, each skater's projection per
  market, the consensus line, the model's side and edge, and the best price.
- **Shooters and goalies.** Shot volume, cold streaks, splits and goalie
  comparisons from the NHL's public API.
- **Tracker.** The graded ledger: every priced projection, its result, and
  running record by market.

## Architecture

```
 Browser ── Vercel ── /api/proxy ──► api-web.nhle.com, ESPN (follows the NHL's
    │                                 307 redirects server-side, same-origin JSON)
    │
    └── publishable key ──► Supabase: nhl_event_odds, nhl_picks (RLS read-only)
                                   ▲ service role
 GitHub Actions ── pull_nhl_odds.mjs   odds → Postgres (one slate) + Drive archive
               ── daily-predict.mjs   grade yesterday, project + price + snapshot today
               ── backup-to-drive.mjs
```

One model file, two runners: `public/lib/nhl-model.js` is a UMD module that
the page loads with a `<script>` tag and the nightly job loads with
`createRequire`, so the board and the ledger can never disagree. Page views
never spend odds-API credits; the odds job fills a table the page reads.

## Where to look

| Area | Files |
|---|---|
| Model API, pricing, de-vigging, gates | `public/lib/nhl-model.js`, `scripts/model.test.mjs` |
| Nightly snapshot and grading | `scripts/daily-predict.mjs` |
| Odds ingestion and archiving before prune | `scripts/pull_nhl_odds.mjs`, `scripts/prune-archived-odds.mjs` (+ test) |
| Redirect-following same-origin proxy | `api/proxy.js` |
| Ledger schema | `db/` |

## Running it

```bash
npm ci
npm test                                 # node --test, no network or keys needed
cp public/config.example.js public/config.js   # add a Supabase URL + publishable key
npm start                                # Express dev server at http://localhost:3000
```

## License

All rights reserved. The code is published for viewing and evaluation; see [LICENSE](LICENSE).
