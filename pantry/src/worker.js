/* Iron Hub pantry drop box (his choice, 2026-10-09).

   The family pantry check used to need two links: his list going out, and a reply link coming back that,
   on an iPhone, opened in Safari rather than the home-screen app and had to be pasted by hand. This Worker
   holds ONE reply per box until his app picks it up, so the family page can just Submit.

   It is deliberately tiny and deliberately separate from discord/, which must stay read-only.
   - A box is a 128-bit random id the app made, carried in the family link's #fragment. Holding the id is
     the whole permission: whoever has the link can leave or clear a pantry update, which is no more than a
     crafted reply link could always do. The app treats a drop as untrusted (famValid()), it can only set
     stock on foods already in his list, and nothing applies without his tap.
   - One key per box, overwritten, with a 30-day TTL, so storage is bounded per box and in total.
   - Every route is a CORS "simple" request (GET, or POST with a text/plain body), so there is no preflight.
   - Bodies are never logged. */

export const BOX_RE = /^[A-Za-z0-9_-]{22,43}$/;
export const ID_RE = BOX_RE;
export const MAX_BODY = 16384;
export const TTL_S = 30 * 86400;
export const ORIGINS = ['https://markwx18.github.io', 'http://localhost:8731'];

function cors(origin) {
  return ORIGINS.indexOf(origin) >= 0 ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : { 'Vary': 'Origin' };
}
function reply(status, body, origin) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, cors(origin));
  if (body === null) return new Response(null, { status, headers: h });
  h['Content-Type'] = 'application/json';
  return new Response(JSON.stringify(body), { status, headers: h });
}

/* The shape the app's famValid(o,'r') starts from. The app validates fully again; this only keeps
   obvious junk out of storage. */
export function dropShapeOk(o) {
  return !!(o && typeof o === 'object' && !Array.isArray(o) && o.v === 1 && o.k === 'r' &&
    typeof o.id === 'string' && ID_RE.test(o.id) && Array.isArray(o.f) && o.f.length > 0 && o.f.length <= 300);
}

export async function handle(request, env, now) {
  const origin = request.headers.get('Origin') || '';
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/box\/([^/]+)(\/clear)?$/);
  if (request.method === 'OPTIONS') return reply(204, null, origin);
  if (!m) return reply(404, { ok: false, error: 'not found' }, origin);
  const box = m[1], clear = !!m[2];
  if (!BOX_RE.test(box)) return reply(400, { ok: false, error: 'bad box' }, origin);
  const key = 'box:' + box;

  if (request.method === 'GET' && !clear) {
    const v = await env.DROPS.get(key);
    if (!v) return reply(204, null, origin);
    let o = null;
    try { o = JSON.parse(v); } catch (e) { /* treat as empty */ }
    return o ? reply(200, o, origin) : reply(204, null, origin);
  }
  if (request.method !== 'POST') return reply(405, { ok: false, error: 'method' }, origin);

  if (clear) {
    // Only the drop he reviewed is cleared. A newer one, sent while he was looking, stays for him.
    const id = url.searchParams.get('id') || '';
    if (!ID_RE.test(id)) return reply(400, { ok: false, error: 'bad id' }, origin);
    const v = await env.DROPS.get(key);
    let cur = null;
    try { cur = v ? JSON.parse(v) : null; } catch (e) { cur = null; }
    if (cur && cur.drop && cur.drop.id === id) { await env.DROPS.delete(key); return reply(200, { ok: true, cleared: true }, origin); }
    return reply(200, { ok: true, cleared: false }, origin);
  }

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return reply(413, { ok: false, error: 'too big' }, origin);
  const text = await request.text();
  if (text.length > MAX_BODY) return reply(413, { ok: false, error: 'too big' }, origin);
  let o = null;
  try { o = JSON.parse(text); } catch (e) { return reply(400, { ok: false, error: 'not json' }, origin); }
  if (!dropShapeOk(o)) return reply(400, { ok: false, error: 'bad shape' }, origin);
  await env.DROPS.put(key, JSON.stringify({ drop: o, receivedAt: new Date(now()).toISOString() }), { expirationTtl: TTL_S });
  return reply(200, { ok: true }, origin);
}

export default {
  fetch(request, env) {
    return handle(request, env, () => Date.now()).catch(() => reply(500, { ok: false, error: 'server' }, request.headers.get('Origin') || ''));
  },
};
