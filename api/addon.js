// Dhaka Movie addon on Vercel.
// It never touches your ISP server. It reads the files you published on GitHub Pages
// (manifest, catalogs, meta, stream and search-index.json) and adds smart features on top:
// search (with typo tolerance), Trending, Top Rated, Random Picks and an "All" list with genre filter.

const PAGES = (process.env.PAGES_URL || 'https://majed6222.github.io/isp-nuvio').replace(/\/$/, '');
const TMDB_KEY = process.env.TMDB_KEY || '18c5a939865f2d093d1bcda9b234b58b';
const POSTER_PREFIX = 'https://image.tmdb.org/t/p/w342';
const PAGE = 100;

let cache = { at: 0, items: null };

const LABEL = { Indian_Bangla: 'Bengali', Others_Language: 'Others', IMDB_TOP_250: 'IMDb Top 250', South_Indian: 'South Indian' };
const catLabel = (c) => LABEL[c] || String(c || '').replace(/_/g, ' ');

function norm(s) {
  return String(s || '').toLowerCase().replace(/['’`]/g, '').replace(/&/g, ' ').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

async function loadIndex() {
  if (cache.items && Date.now() - cache.at < 10 * 60 * 1000) return cache.items;
  const r = await fetch(PAGES + '/search-index.json');
  if (!r.ok) throw new Error('search-index.json not found (' + r.status + ')');
  const rows = await r.json();
  const items = rows.map((x) => {
    const genres = x[7] ? String(x[7]).split('|') : [];
    const nameKey = norm(x[2]);
    return {
      id: x[0], type: x[1], name: x[2], year: x[3], poster: x[4], cat: x[5],
      rating: x[6] || 0, genres, tid: x[8] || 0, added: x[9] || 0,
      alt: x[10] || '', coll: x[11] || '', runtime: x[12] || 0, complete: x[13],
      key: nameKey, nameTokens: nameKey.split(' ').concat(norm(x[10] || '').split(' ')).filter(Boolean),
      full: norm(x[2] + ' ' + x[3] + ' ' + genres.join(' ') + ' ' + catLabel(x[5]) + ' ' + (x[10] || '') + ' ' + (x[11] || ''))
    };
  });
  cache = { at: Date.now(), items };
  return items;
}

function toMeta(e) {
  return {
    id: e.id, type: e.type, name: e.name,
    poster: e.poster ? POSTER_PREFIX + e.poster : undefined,
    releaseInfo: e.year || undefined,
    genres: e.genres.concat([catLabel(e.cat)]),
    imdbRating: e.rating ? String(e.rating.toFixed ? e.rating.toFixed(1) : e.rating) : undefined
  };
}

// ---------- search with typo tolerance ----------
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

async function search(type, q) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return { metas: [] };
  const items = (await loadIndex()).filter((e) => e.type === type);
  const text = words.join(' ');
  let hits = items.filter((e) => words.every((w) => e.full.indexOf(w) >= 0));
  if (hits.length < 5) {
    // typos: every word must be inside the title/year/genre text, or be one or two letters away from a title word
    const fuzzy = items.filter((e) => hits.indexOf(e) < 0 && words.every((w) =>
      e.full.indexOf(w) >= 0 || (w.length >= 4 && e.nameTokens.some((t) => lev(w, t, w.length >= 7 ? 2 : 1) <= (w.length >= 7 ? 2 : 1)))));
    hits = hits.concat(fuzzy);
  }
  hits.sort((a, b) =>
    (b.key === text) - (a.key === text) ||
    (b.key.indexOf(text) === 0) - (a.key.indexOf(text) === 0) ||
    (b.key.indexOf(text) >= 0) - (a.key.indexOf(text) >= 0) ||
    (b.year || '0').localeCompare(a.year || '0') ||
    a.name.localeCompare(b.name));
  return { metas: hits.slice(0, 60).map(toMeta) };
}

// ---------- smart rows ----------
let trendCache = {};
async function trending(type) {
  const kind = type === 'series' ? 'tv' : 'movie';
  const c = trendCache[kind];
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.ids;
  const ids = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const r = await fetch('https://api.themoviedb.org/3/trending/' + kind + '/week?api_key=' + TMDB_KEY + '&page=' + page);
      const j = await r.json();
      (j.results || []).forEach((x) => ids.push(x.id));
    } catch (e) {}
  }
  trendCache[kind] = { at: Date.now(), ids };
  return ids;
}

function collectionList(items) {
  const n = {};
  items.forEach((e) => { if (e.type === 'movie' && e.coll) n[e.coll] = (n[e.coll] || 0) + 1; });
  return Object.keys(n).filter((k) => n[k] >= 2).sort((a, b) => n[b] - n[a] || a.localeCompare(b)).slice(0, 120);
}

function genreList(items) {
  const n = {};
  items.forEach((e) => e.genres.forEach((g) => { n[g] = (n[g] || 0) + 1; }));
  return Object.keys(n).sort((a, b) => n[b] - n[a]).slice(0, 24);
}

async function smart(kind, type, extra) {
  let items = (await loadIndex()).filter((e) => e.type === type);
  if (extra.genre && kind !== 'coll') items = items.filter((e) => e.genres.indexOf(extra.genre) >= 0);
  const skip = parseInt(extra.skip || '0', 10) || 0;
  let list;
  if (kind === 'top') {
    list = items.filter((e) => e.rating > 0 && e.poster).sort((a, b) => b.rating - a.rating || (b.year || '0').localeCompare(a.year || '0'));
  } else if (kind === 'trend') {
    const ids = await trending(type);
    const byTid = {};
    items.forEach((e) => { if (e.tid) byTid[e.tid] = e; });
    list = ids.map((i) => byTid[i]).filter(Boolean);
  } else if (kind === 'pick') {
    const pool = items.filter((e) => e.poster);
    list = [];
    for (let i = 0; i < 40 && pool.length; i++) list.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  } else if (kind === 'coll') {   // franchises: films grouped by collection, optional collection name as "genre"
    list = items.filter((e) => e.coll && (!extra.genre || e.coll === extra.genre))
      .sort((a, b) => a.coll.localeCompare(b.coll) || (a.year || '0').localeCompare(b.year || '0'));
    return { metas: list.slice(skip, skip + PAGE).map((e) => { const m = toMeta(e); m.genres = [e.coll].concat(m.genres); return m; }) };
  } else if (kind === 'complete') {
    list = items.filter((e) => e.complete === 1).sort((a, b) => b.rating - a.rating || (b.year || '0').localeCompare(a.year || '0'));
  } else {   // all
    list = items.slice().sort((a, b) => (b.year || '0').localeCompare(a.year || '0') || a.name.localeCompare(b.name));
  }
  return { metas: list.slice(skip, skip + PAGE).map(toMeta) };
}

// ---------- subtitles from OpenSubtitles (needs the IMDb id, which comes from TMDB) ----------
const imdbCache = new Map();
async function imdbOf(type, tid) {
  const k = type + ':' + tid;
  if (imdbCache.has(k)) return imdbCache.get(k);
  let id = '';
  try {
    const r = await fetch('https://api.themoviedb.org/3/' + (type === 'series' ? 'tv' : 'movie') + '/' + tid + '/external_ids?api_key=' + TMDB_KEY);
    const j = await r.json();
    id = (j && j.imdb_id) || '';
  } catch (e) {}
  if (id) imdbCache.set(k, id);
  return id;
}

async function subtitles(type, rawId) {
  const parts = String(rawId).split('.');          // dm.<code>[.season.episode]
  const base = parts[0] + '.' + parts[1];
  const item = (await loadIndex()).find((e) => e.id === base);
  if (!item || !item.tid) return { subtitles: [] };
  const imdb = await imdbOf(type, item.tid);
  if (!imdb) return { subtitles: [] };
  const vid = type === 'series' && parts.length >= 4 ? imdb + ':' + parts[2] + ':' + parts[3] : imdb;
  try {
    const r = await fetch('https://opensubtitles-v3.strem.io/subtitles/' + type + '/' + vid + '.json');
    const j = await r.json();
    return { subtitles: ((j && j.subtitles) || []).slice(0, 30) };
  } catch (e) { return { subtitles: [] }; }
}

async function manifest() {
  const r = await fetch(PAGES + '/manifest.json');
  if (!r.ok) throw new Error('manifest.json not found (' + r.status + ')');
  const m = await r.json();
  let genres = [], colls = [];
  try { const all = await loadIndex(); genres = genreList(all); colls = collectionList(all); } catch (e) {}
  const skip = { name: 'skip', isRequired: false };
  const gen = genres.length ? [{ name: 'genre', options: genres, isRequired: false }, skip] : [skip];
  const mk = (id, name, extra) => ['movie', 'series'].map((t) => ({ type: t, id: 'dm-' + id + '-' + t, name, extra }));
  const old = m.catalogs || [];
  const isNew = (c) => /_new$/.test(c.id);
  m.catalogs = old.filter(isNew)
    .concat(mk('trend', 'Dhaka Trending', [skip]))
    .concat(mk('top', 'Dhaka Top Rated', gen))
    .concat(mk('pick', 'Dhaka Random Picks', []))
    .concat([{ type: 'movie', id: 'dm-coll-movie', name: 'Dhaka Franchises', extra: colls.length ? [{ name: 'genre', options: colls, isRequired: false }, skip] : [skip] }])
    .concat([{ type: 'series', id: 'dm-complete-series', name: 'Dhaka Complete Series', extra: [skip] }])
    .concat(old.filter((c) => !isNew(c)))
    .concat(mk('all', 'Dhaka All', gen))
    .concat([
      { type: 'movie', id: 'dm-search-movie', name: 'Dhaka Search', extra: [{ name: 'search', isRequired: true }] },
      { type: 'series', id: 'dm-search-series', name: 'Dhaka Search', extra: [{ name: 'search', isRequired: true }] }
    ]);
  m.resources = ['catalog', 'meta', 'stream', 'subtitles'];
  m.version = '3.2.0';
  m.description = 'Every movie and series on server1.dhakamovie.com, with search, trending, top rated and genres.';
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
    if (p === '/' || p === '') return send(200, { ok: true, message: 'Dhaka Movie addon is running. Add /dm/manifest.json in Nuvio.' });
    if (p === '/manifest') return send(200, await manifest(), 300);

    const seg = p.split('/').filter(Boolean);
    if (seg[0] === 'catalog') {
      const extra = parseExtra(seg.slice(3).join('/'));
      if (/^dm-search-/.test(seg[2] || '')) return send(200, await search(seg[1], extra.search || ''), 60);
      const m = /^dm-(top|trend|pick|all|coll|complete)-(movie|series)$/.exec(seg[2] || '');
      if (m) return send(200, await smart(m[1], seg[1], extra), m[1] === 'pick' ? 0 : 600);
    }
    if (seg[0] === 'subtitles') return send(200, await subtitles(seg[1], (seg[2] || '').replace(/\.json$/, '')), 86400);
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
