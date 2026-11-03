-- nhl_picks — the NHL model ledger (shared Supabase project).
--
-- One row per (game_date, player, market) for every projected skater on the
-- slate. scripts/daily-predict.mjs writes it; it only ever rewrites rows whose
-- game has NOT started, so the last pre-puck-drop snapshot is what grades.
-- Every row is graded; is_official marks the model plays (public/lib/nhl-model.js
-- gateVerdict + public/lib/nhl-gates.json). The page reads it with the
-- publishable key (anon: select only).
create table if not exists public.nhl_picks (
  id            bigserial primary key,
  game_date     date        not null,
  game_id       bigint      not null,
  start_time    timestamptz,
  player_id     bigint      not null,
  player        text        not null,
  team          text        not null,
  opp           text        not null,
  is_home       boolean,
  position      text,
  market        text        not null check (market in ('points','goals','assists','sog')),
  line          numeric     not null,
  side          text        not null check (side in ('over','under')),
  lambda        numeric     not null,          -- model projection (mean count)
  prob_over     numeric     not null,
  prob_side     numeric,
  priced        boolean     not null default false,
  fair_over     numeric,                       -- no-vig market P(over) at `line`
  fair_side     numeric,
  lambda_market numeric,                       -- the market's projection, inverted from fair_over
  two_sided     boolean,
  n_books       int,
  price         int,                           -- best American price on `side`
  book          text,
  ev            numeric,                       -- prob_side × decimal(price) − 1
  score         numeric,                       -- ln(λ_model/λ_market) on `side` — gates live here
  qualifies     boolean     not null default false,
  is_official   boolean     not null default false,
  gate_status   text,                          -- official | probation (market's status at snapshot)
  gate_reason   text,
  gp            int,                           -- this-season GP before the game
  evidence_gp   int,                           -- NHL GP this season + last (gate floor)
  prior_weight  numeric,                       -- weight left on last season (1 → 0)
  toi_proj      numeric,                       -- projected minutes
  model_version text        not null,
  snapshot_at   timestamptz not null default now(),
  actual        int,
  hit           boolean,                       -- null = void (did not play)
  units         numeric,                       -- 1u flat at `price`; null when unpriced/void
  graded_at     timestamptz,
  created_at    timestamptz not null default now(),
  unique (game_date, player_id, market)
);

create index if not exists nhl_picks_date_idx on public.nhl_picks (game_date);
create index if not exists nhl_picks_ungraded_idx on public.nhl_picks (game_date) where graded_at is null;

alter table public.nhl_picks enable row level security;
drop policy if exists nhl_picks_anon_read on public.nhl_picks;
create policy nhl_picks_anon_read on public.nhl_picks for select to anon, authenticated using (true);
