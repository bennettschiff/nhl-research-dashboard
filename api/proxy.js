// Serverless replacement for the old Express proxy (server.js). The NHL api-web
// endpoints 307-redirect their `/now` paths to dated URLs; a plain Vercel rewrite
// passes the 307 to the browser, which then hits NHL cross-origin and gets
// CORS-blocked. fetch() here follows redirects server-side (as Express did) and
// returns the final JSON same-origin.
//
// Routed via vercel.json:
//   /api/:path*        -> /api/proxy?base=modern&path=:path*
//   /legacy-api/:path* -> /api/proxy?base=legacy&path=:path*
//   /espn-api/:path*   -> /api/proxy?base=espn&path=:path*  (team depth charts:
//                         ESPN sends CORS headers on some cached copies only)
// Original query params (e.g. cayenneExp) are preserved and forwarded upstream.
//
// Odds are intentionally NOT proxied. The page reads tonight's board from
// Supabase (public.nhl_event_odds), which .github/workflows/odds-pull.yml fills
// on a schedule — so page views never spend Odds API credits. The /odds-api
// fallback in fetchOddsData only runs on localhost (server.js).

const BASES = {
  modern: 'https://api-web.nhle.com/v1',
  legacy: 'https://api.nhle.com/stats/rest/en',
  espn: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl',
};

module.exports = async (req, res) => {
  const { base = 'modern', path = '', ...rest } = req.query || {};
  const root = BASES[base];
  if (!root) {
    res.status(400).json({ error: `unknown base "${base}"` });
    return;
  }

  // rebuild the upstream query string from the leftover params
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) {
    if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
    else qs.append(k, v);
  }
  const suffix = qs.toString();
  const url = `${root}/${Array.isArray(path) ? path.join('/') : path}${suffix ? '?' + suffix : ''}`;

  try {
    const upstream = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'NHL-Dashboard/1.0' },
      // fetch follows 3xx by default — that's the whole point
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `${base} API ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    // brief edge cache: NHL data moves slowly within a day
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
