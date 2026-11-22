// Dhaka Movie addon with search, for Vercel.
// It never touches your ISP server. It only reads the files you published on GitHub Pages
// (manifest, catalogs, meta, stream and search-index.json) and adds a search catalog on top.

const PAGES = (process.env.PAGES_URL || 'https://majed6222.github.io/isp-nuvio').replace(/\/$/, '');
const POSTER_PREFIX = 'https://image.tmdb.org/t/p/w342';

let cache = { at: 0, items: null };

async function loadIndex() {
  if (cache.items && Date.now() - cache.at < 10 * 60 * 1000) return cache.items;
  const r = await fetch(PAGES + '/search-index.json');
  if (!r.ok) throw new Error('search-index.json not found (' + r.status + ')');
  const rows = await r.json();
  cache = {
    at: Date.now(),
    items: rows.map((x) => ({ id: x[0], type: x[1], name: x[2], year: x[3], poster: x[4], cat: x[5], key: norm(x[2]) }))
  };
  return cache.items;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/['’`]/g, '').replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function toMeta(e) {
  return {
    id: e.id, type: e.type, name: e.name,
    poster: e.poster ? POSTER_PREFIX + e.poster : undefined,
    releaseInfo: e.year || undefined, genres: [e.cat]
  };
}

async function search(type, q) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return { metas: [] };
  const items = await loadIndex();
  const hits = items.filter((e) => e.type === type && words.every((w) => e.key.indexOf(w) >= 0));
  const text = words.join(' ');
  hits.sort((a, b) =>
    (b.key === text) - (a.key === text) ||
    (b.key.indexOf(text) === 0) - (a.key.indexOf(text) === 0) ||
    (b.year || '0').localeCompare(a.year || '0') ||
    a.name.localeCompare(b.name));
  return { metas: hits.slice(0, 60).map(toMeta) };
}

async function manifest() {
  const r = await fetch(PAGES + '/manifest.json');
  if (!r.ok) throw new Error('manifest.json not found (' + r.status + ')');
  const m = await r.json();
  m.version = '2.0.0';
  m.description = 'Every movie and series on server1.dhakamovie.com, with search.';
  m.catalogs = (m.catalogs || []).concat([
    { type: 'movie', id: 'dm-search-movie', name: 'Dhaka Search', extra: [{ name: 'search', isRequired: true }] },
    { type: 'series', id: 'dm-search-series', name: 'Dhaka Search', extra: [{ name: 'search', isRequired: true }] }
  ]);
  return m;
}

function parseExtra(s) {
  const o = {};
  String(s || '').replace(/\.json$/, '').split('&').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) {
      let v = kv.slice(i + 1).replace(/\+/g, ' ');
      try { v = decodeURIComponent(v); } catch (e) {}
      o[kv.slice(0, i)] = v;
    }
  });
  return o;
}

module.exports = async (req, res) => {
  const send = (code, body, cacheSeconds) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', cacheSeconds ? 'public, s-maxage=' + cacheSeconds + ', max-age=' + Math.min(cacheSeconds, 300) : 'no-store');
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    if (req.method === 'OPTIONS') return send(204, '');
    let p = req.query && req.query.p;
    if (Array.isArray(p)) p = p.join('/');
    if (p === undefined) {
      const u = new URL(String(req.url || '/'), 'http://x');
      p = u.searchParams.get('p');
      if (p === null) p = u.pathname.replace(/^\/api\/addon/, '').replace(/^\/dm(?=\/|$)/, '');
    }
    p = '/' + String(p).replace(/^\/+/, '');
    p = p.replace(/\.json$/, '');
    if (p === '/' || p === '') return send(200, { ok: true, message: 'Dhaka Movie addon is running. Add /manifest.json in Nuvio.' });
    if (p === '/manifest') return send(200, await manifest(), 300);

    const seg = p.split('/').filter(Boolean);
    // search catalogs
    if (seg[0] === 'catalog' && /^dm-search-/.test(seg[2] || '')) {
      const extra = parseExtra(seg.slice(3).join('/'));
      return send(200, await search(seg[1], extra.search || ''), 60);
    }
    // everything else is a ready-made file on GitHub Pages
    if (['catalog', 'meta', 'stream'].indexOf(seg[0]) >= 0) {
      const url = PAGES + '/' + seg.map(encodeURIComponent).join('/') + '.json';
      const r = await fetch(url);
      if (r.status === 404) {
        return send(200, seg[0] === 'catalog' ? { metas: [] } : seg[0] === 'meta' ? { meta: null } : { streams: [] }, 60);
      }
      return send(200, await r.text(), 3600);
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e && e.message ? e.message : e) });
  }
};
