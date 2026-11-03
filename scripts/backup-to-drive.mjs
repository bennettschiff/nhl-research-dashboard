#!/usr/bin/env node
/**
 * backup-to-drive.mjs — dump the NHL lab's Supabase state to local files that
 * backup-to-drive.yml (or a laptop with rclone) copies to Google Drive.
 *
 *   <out>/nhl_picks.json.gz                   full ledger, every run
 *   <out>/odds/nhl_event_odds_<date>.json.gz  each slate's raw odds board, so the
 *                                             lines outlive the 7-day prune in
 *                                             pull_nhl_odds.mjs (closing-line and
 *                                             re-pricing work needs them later)
 *
 *   node --env-file=.env scripts/backup-to-drive.mjs --out-dir backup-out
 *   rclone copy backup-out/ledger gdrive:nhl-props-lab-backups/$(date -u +%F)
 *   rclone copy backup-out/odds   gdrive:nhl-props-lab-archive/odds
 *
 * Reads work with the publishable key (both tables are anon-readable), so this
 * also runs on a laptop with no secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sbGetAll } from './lib/sb.mjs';

const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = argOf('--out-dir') || 'backup-out';

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(data)));
  return fs.statSync(file).size;
}

const picks = await sbGetAll('nhl_picks?select=*&order=id');
const sz = write(path.join(OUT, 'ledger', 'nhl_picks.json.gz'), picks);
console.log(`nhl_picks: ${picks.length} rows → ${(sz / 1024).toFixed(1)} KB`);

const odds = await sbGetAll('nhl_event_odds?select=*&order=game_date');
const byDate = new Map();
for (const r of odds) {
  if (!byDate.has(r.game_date)) byDate.set(r.game_date, []);
  byDate.get(r.game_date).push(r);
}
for (const [d, rs] of byDate) {
  const s = write(path.join(OUT, 'odds', `nhl_event_odds_${d}.json.gz`), rs);
  console.log(`odds ${d}: ${rs.length} events → ${(s / 1024).toFixed(1)} KB`);
}
