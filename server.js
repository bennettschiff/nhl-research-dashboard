const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const NHL_API = 'https://api-web.nhle.com/v1';
const NHL_LEGACY_API = 'https://api.nhle.com/stats/rest/en';
const ODDS_API_BASE = 'https://api.the-odds-api.com';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';

// In-memory cache (resets on restart)
const cache = new Map();
const CACHE_TTL = 60000;
const LONG_CACHE_TTL = 300000;

// File-based odds cache — survives server restarts
const ODDS_CACHE_FILE = path.join(__dirname, '.odds-cache.json');
const ODDS_FILE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function todayDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loadOddsFileCache() {
  try {
    if (!fs.existsSync(ODDS_CACHE_FILE)) return;
    const raw = fs.readFileSync(ODDS_CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    const today = todayDateStr();
    let loaded = 0, skipped = 0;
    Object.keys(entries).forEach(function(key) {
      const entry = entries[key];
      const age = Date.now() - entry.timestamp;
      if (entry.date === today && age < ODDS_FILE_TTL_MS) {
        cache.set(key, entry);
        loaded++;
      } else {
        skipped++;
      }
    });
    if (loaded > 0) console.log(`Odds file cache: loaded ${loaded} entries (${skipped} stale/skipped) — no API calls needed`);
  } catch (e) {
    console.warn('Could not load odds file cache:', e.message);
  }
}

function saveOddsFileCache() {
  try {
    const entries = {};
    cache.forEach(function(val, key) {
      if (key.startsWith('odds:')) entries[key] = val;
    });
    fs.writeFileSync(ODDS_CACHE_FILE, JSON.stringify(entries), 'utf8');
  } catch (e) {
    console.warn('Could not save odds file cache:', e.message);
  }
}

// Load persisted odds cache on startup
loadOddsFileCache();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// NHL API proxy
app.get('/api/*', async (req, res) => {
  const endpoint = req.path.replace('/api', '');
  const url = `${NHL_API}${endpoint}`;

  const ttl = endpoint.includes('standings') || endpoint.includes('club-stats')
    ? LONG_CACHE_TTL
    : CACHE_TTL;

  const cached = cache.get(url);
  if (cached && Date.now() - cached.timestamp < ttl) {
    return res.json(cached.data);
  }

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'NHL-Dashboard/1.0' }
    });
    if (!response.ok) throw new Error(`NHL API returned ${response.status}`);
    const data = await response.json();
    cache.set(url, { data, timestamp: Date.now() });
    res.json(data);
  } catch (error) {
    console.error(`Error fetching ${url}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Legacy NHL stats API proxy (hits, blocks, realtime stats)
app.get('/legacy-api/*', async (req, res) => {
  const endpoint = req.path.replace('/legacy-api', '');
  const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const url = `${NHL_LEGACY_API}${endpoint}${queryString}`;

  const cached = cache.get(url);
  if (cached && Date.now() - cached.timestamp < LONG_CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'NHL-Dashboard/1.0' }
    });
    if (!response.ok) throw new Error(`NHL Legacy API returned ${response.status}`);
    const data = await response.json();
    cache.set(url, { data, timestamp: Date.now() });
    res.json(data);
  } catch (error) {
    console.error(`Error fetching ${url}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ESPN site API proxy (team depth charts → line combos). ESPN's CDN sends the
// CORS header on some cached copies and not others, so the page goes same-origin.
app.get('/espn-api/*', async (req, res) => {
  const url = `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl${req.path.replace('/espn-api', '')}`;
  const cached = cache.get(url);
  if (cached && Date.now() - cached.timestamp < LONG_CACHE_TTL) return res.json(cached.data);
  try {
    const response = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'NHL-Dashboard/1.0' } });
    if (!response.ok) throw new Error(`ESPN API returned ${response.status}`);
    const data = await response.json();
    cache.set(url, { data, timestamp: Date.now() });
    res.json(data);
  } catch (error) {
    console.error(`Error fetching ${url}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// The Odds API proxy — key stays server-side, never exposed to client
app.get('/odds-api/*', async (req, res) => {
  if (!ODDS_API_KEY) return res.status(503).json({ error: 'ODDS_API_KEY not configured on server' });
  const endpoint = req.path.replace('/odds-api', '');
  const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const sep = queryString ? '&' : '?';
  const url = `${ODDS_API_BASE}${endpoint}${queryString}${sep}apiKey=${ODDS_API_KEY}`;
  const cacheKey = 'odds:' + endpoint + queryString; // no API key in cache key

  // Check in-memory cache first (already loaded from file on startup)
  const cached = cache.get(cacheKey);
  if (cached && cached.date === todayDateStr() && Date.now() - cached.timestamp < ODDS_FILE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`Odds API returned ${response.status}`);
    const data = await response.json();

    const entry = { data, timestamp: Date.now(), date: todayDateStr() };
    cache.set(cacheKey, entry);
    saveOddsFileCache(); // persist to disk immediately

    const remaining = response.headers.get('x-requests-remaining');
    if (remaining) console.log(`Odds API credits remaining: ${remaining}`);
    res.json(data);
  } catch (error) {
    console.error(`Odds API error ${url}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Debug: discover available markets for NHL — hit /debug-odds in browser
app.get('/debug-odds', async (req, res) => {
  if (!ODDS_API_KEY) return res.status(503).send('ODDS_API_KEY not set');
  try {
    const evRes = await fetch(`${ODDS_API_BASE}/v4/sports/icehockey_nhl/events?apiKey=${ODDS_API_KEY}`);
    const events = await evRes.json();
    if (!events || !events.length) return res.send('No NHL events found');
    const ev = events[0];
    const mRes = await fetch(
      `${ODDS_API_BASE}/v4/sports/icehockey_nhl/events/${ev.id}/odds?oddsFormat=american&bookmakers=draftkings,fanduel&apiKey=${ODDS_API_KEY}`
    );
    const mData = await mRes.json();
    const remaining = mRes.headers.get('x-requests-remaining');
    if (remaining) console.log(`Credits remaining: ${remaining}`);
    res.json({ event: { id: ev.id, home: ev.home_team, away: ev.away_team }, status: mRes.status, data: mData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  if (ODDS_API_KEY) {
    console.log(`Odds API key loaded: ...${ODDS_API_KEY.slice(-6)}`);
  } else {
    console.warn('WARNING: ODDS_API_KEY not set — odds features disabled');
  }
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║   🏒 NHL RESEARCH DASHBOARD                                       ║
║                                                                   ║
║   Dashboard running at: http://localhost:${PORT}                     ║
║                                                                   ║
║   Features:                                                       ║
║   • Player Projections with Confidence Scores                     ║
║   • Home/Road & Back-to-Back Splits                              ║
║   • Power Play Specialists Detection                              ║
║   • Period-by-Period Analysis                                     ║
║   • Matchup-Based Adjustments                                     ║
║   • Hot/Cold Streak Detection                                     ║
║   • Goalie Form Analysis                                          ║
║                                                                   ║
║   Press Ctrl+C to stop the server                                 ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
});
