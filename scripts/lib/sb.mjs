/**
 * sb.mjs — minimal Supabase REST client for the NHL scripts.
 *
 * Reads fall back to the publishable key (anon may SELECT nhl_picks and
 * nhl_event_odds), so --dry-run works on a laptop with no secrets at all.
 * Writes require SUPABASE_SERVICE_ROLE_KEY.
 */
export const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
export const PUBLISHABLE = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const canWrite = !!SERVICE;

function headers(write) {
  const key = write ? SERVICE : (SERVICE || PUBLISHABLE);
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ') || write) h.Authorization = `Bearer ${key}`;
  return h;
}

async function req(method, pathq, body, prefer) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${pathq}`, {
      method, headers: { ...headers(method !== 'GET'), ...(prefer ? { Prefer: prefer } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.ok) return method === 'GET' || prefer === 'return=representation' ? r.json() : null;
    const text = await r.text();
    if (r.status >= 500 && i < 3) { await new Promise((res) => setTimeout(res, 1000 * (i + 1))); continue; }
    throw new Error(`${method} ${pathq.split('?')[0]} → ${r.status} ${text.slice(0, 300)}`);
  }
}

// PostgREST silently caps a response at 1000 rows — always page.
export async function sbGetAll(pathq) {
  const out = [];
  const sep = pathq.includes('?') ? '&' : '?';
  for (let off = 0; ; off += 1000) {
    const page = await req('GET', `${pathq}${sep}limit=1000&offset=${off}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export async function sbUpsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    await req('POST', `${table}?on_conflict=${onConflict}`, rows.slice(i, i + 500), 'resolution=merge-duplicates,return=minimal');
  }
}

export async function sbPatch(table, filter, patch) {
  await req('PATCH', `${table}?${filter}`, patch, 'return=minimal');
}

/** DELETE matching rows and return what was removed, `select`ed columns only. */
export async function sbDelete(table, filter, select) {
  return req('DELETE', `${table}?${filter}&select=${select}`, undefined, 'return=representation');
}
