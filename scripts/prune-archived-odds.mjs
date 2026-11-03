#!/usr/bin/env node
/**
 * prune-archived-odds.mjs — drop a slate's odds board from Supabase once its
 * copy is on Google Drive.
 *
 * The page and daily-predict.mjs read only today's board (game_date = today);
 * backup-to-drive.yml keeps every slate forever at
 * gdrive:nhl-props-lab-archive/odds/nhl_event_odds_<date>.json.gz. Until
 * 2026-10-13 pull_nhl_odds.mjs deleted boards older than 7 days on its own,
 * whether or not the backup had run. The shared free Nano (MLB/NFL/WNBA/NHL) is
 * short on memory and IO, so the hold is now one day, and the delete happens
 * here, in the backup job, AFTER the upload, and only for a date whose file is
 * on Drive at the size this run just wrote. The delete is addressed by the
 * event_ids in that file, so what leaves the table is what Drive holds.
 *
 *   node scripts/prune-archived-odds.mjs --out-dir backup-out --drive-list drive.txt          # dry run
 *   node scripts/prune-archived-odds.mjs --out-dir backup-out --drive-list drive.txt --write
 *
 * --drive-list is `rclone lsf --format ps --separator ';' <odds folder>`: one
 * "name;size" per line.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { sbDelete } from './lib/sb.mjs';

const TZ = 'America/New_York';
const FILE = /^nhl_event_odds_(\d{4}-\d{2}-\d{2})\.json\.gz$/;

const etDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Which dumped slates may leave the table: older than `keepDays` before today
 * (today and yesterday stay by default) AND on Drive at the same byte size as
 * the local dump. `local` and `drive` map file name → size.
 */
export function prunableDates(local, drive, today, keepDays = 1) {
  const cutoff = addDays(today, -keepDays);
  return [...local.entries()]
    .map(([name, size]) => ({ date: name.match(FILE)?.[1], name, size }))
    .filter((f) => f.date && f.date < cutoff && drive.get(f.name) === f.size)
    .map((f) => f.date)
    .sort();
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const oddsDir = path.join(arg('--out-dir', 'backup-out'), 'odds');
  const write = process.argv.includes('--write');
  const local = new Map(fs.readdirSync(oddsDir).filter((n) => FILE.test(n))
    .map((n) => [n, fs.statSync(path.join(oddsDir, n)).size]));
  const drive = new Map(fs.readFileSync(arg('--drive-list'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { const [n, s] = l.split(';'); return [n, Number(s)]; }));
  const today = etDate(new Date());
  const dates = prunableDates(local, drive, today);
  const notOnDrive = [...local.keys()].filter((n) => FILE.exec(n)?.[1] < addDays(today, -1) && drive.get(n) !== local.get(n));
  console.log(`[prune-odds] today ${today} · ${local.size} slates dumped · ${dates.length} archived and old enough`);
  if (notOnDrive.length) console.warn(`[prune-odds] NOT on Drive at this size, kept: ${notOnDrive.join(', ')}`);

  for (const date of dates) {
    const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(oddsDir, `nhl_event_odds_${date}.json.gz`))));
    const ids = rows.map((r) => r.event_id);
    if (!ids.length || ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))) throw new Error(`${date}: unexpected event_id in the dump`);
    if (!write) { console.log(`  ${date}: would delete ${ids.length} events`); continue; }
    const gone = await sbDelete('nhl_event_odds', `game_date=eq.${date}&event_id=in.(${ids.join(',')})`, 'event_id');
    console.log(`  ${date}: deleted ${gone.length}/${ids.length} events`);
  }
  if (!write && dates.length) console.log('[prune-odds] dry run — pass --write to delete');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[prune-odds] ${e.message}`); process.exit(1); });
}
