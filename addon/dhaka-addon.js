// Dhaka Movie addon for Nuvio (Stremio-style addon).
// Runs on YOUR phone (Termux) because the server only opens on your ISP network.
// It reads the folder lists of server1.dhakamovie.com, builds a catalog of every movie and series,
// and serves them to Nuvio with direct stream links. No passwords, no other sources.
//
// Start:  node dhaka-addon.js
// Add in Nuvio (Addons):  http://127.0.0.1:7000/manifest.json   (on the TV use the phone's Wi-Fi IP instead of 127.0.0.1)

const http = require('http');
const fs = require('fs');
const path = require('path');

const CFG = {
  base: process.env.BASE || 'http://server1.dhakamovie.com/',
  movies: process.env.MOVIES || 'Movies/',
  series: process.env.SERIES || 'Tv_Shows/',
  port: parseInt(process.env.PORT || '7000', 10),
  tmdbKey: process.env.TMDB_KEY || '18c5a939865f2d093d1bcda9b234b58b', // used only for posters and descriptions; '' to turn off
  indexFile: process.env.INDEX_FILE || path.join(__dirname, 'dhaka-index.json'),
  parallel: 6,          // folder pages read at the same time
  maxDepth: 6,          // how many folders deep to look
  pageSize: 100,        // titles per catalog page
  refreshHours: 24      // rebuild the list when the saved one is older than this
};

const VIDEO_RE = /\.(mkv|mp4|avi|webm|m3u8|ts|mov)(\?.*)?$/i;
const SEASON_DIR = /^(season|series|s)[ ._-]*0*\d+/i;

let index = [];            // all titles
let byId = {};
let state = { crawling: false, pages: 0, posters: 0, started: 0, finished: 0, error: '' };
const listCache = new Map();   // url -> { dirs, files }
const showCache = new Map();   // show id -> episodes

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (url) => 'dm.' + Buffer.from(url).toString('base64url');
function dec(id) {
  try { return Buffer.from(String(id).replace(/^dm\./, ''), 'base64url').toString(); } catch (e) { return ''; }
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function lastSeg(u) { return safeDecode(u.split('?')[0].split('/').filter(Boolean).pop() || ''); }

async function getText(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(t);
      state.pages++;
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { state.error = String(e.message || e); await sleep(300); }
  }
  return null;
}

// read one folder page -> { dirs:[{name,url}], files:[{name,url}] }
async function list(url) {
  if (listCache.has(url)) return listCache.get(url);
  const html = await getText(url);
  const out = { dirs: [], files: [] };
  if (!html) return out;
  const seen = new Set();
  const re = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    if (!href || href[0] === '#' || href[0] === '?' || href === '../' || href === '/') continue;
    let full;
    try { full = new URL(href, url).href; } catch (e) { continue; }
    if (!full.startsWith(url) || full === url || seen.has(full)) continue;   // only children of this folder
    seen.add(full);
    const name = lastSeg(full);
    if (/\/$/.test(full.split('?')[0])) out.dirs.push({ name, url: full });
    else if (VIDEO_RE.test(full)) out.files.push({ name, url: full });
  }
  if (listCache.size > 3000) listCache.clear();
  listCache.set(url, out);
  return out;
}

function cleanName(raw) {
  let s = safeDecode(raw).replace(/\.(mkv|mp4|avi|webm|m3u8|ts|mov)$/i, '');
  s = s.replace(/\(\s*(?:TV[ -]?Series|Series|Movie)?[ -]*(?:19|20)\d\d[^)]*\)/ig, ' ');
  s = s.replace(/[._]+/g, ' ').replace(/-{2,}/g, ' ').replace(/\s-\s/g, ' - ');
  s = s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  // a year stuck on the end of the folder name ("... Unit 1999") is shown separately
  const m = s.match(/^(.+\s)((?:19|20)\d\d)$/);
  if (m && +m[2] <= new Date().getFullYear() && m[1].trim().split(' ').length > 1) s = m[1].trim();
  return s;
}
function yearOf(raw) {
  const m = safeDecode(raw).match(/(?:^|[^0-9])((?:19|20)\d\d)(?![0-9])(?!.*(?:19|20)\d\d(?![0-9]))/);
  return m ? m[1] : '';
}
function quality(t) {
  const m = String(t).match(/2160p|4k|1080p|720p|480p/i);
  return m ? m[0].toLowerCase() : '';
}

// ---------- crawl everything into the index ----------
async function crawlRoot(type, rootPath, add) {
  const root = new URL(rootPath, CFG.base).href;
  const queue = [{ url: root, depth: 0, cat: '', name: '' }];
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      const { dirs, files } = await list(job.url);
      // category / year / year-range folders only hold other folders; anything else with videos is a title
      const container = job.depth <= 1 || /^(19|20)\d\d$/.test(job.name) || /^(19|20)\d\d\s*[-_ ]+\s*((19|20)\d\d|\D+)$/.test(job.name);
      const isTitleFolder =
        job.depth > 0 && !container &&
        (files.length > 0 || (type === 'series' && dirs.some((d) => SEASON_DIR.test(d.name))));
      if (isTitleFolder) {
        add(type, job.url, job.cat, false, files);
        continue;
      }
      // loose video files sitting in a year / category folder: each file is a title
      for (const f of files) add(type, f.url, job.cat, true);
      if (job.depth >= CFG.maxDepth) continue;
      for (const d of dirs) queue.push({ url: d.url, depth: job.depth + 1, cat: job.depth === 0 ? d.name : job.cat, name: d.name });
    }
  }
  // the queue can be empty for a moment while others work, so run workers in rounds
  while (true) {
    await Promise.all(Array.from({ length: CFG.parallel }, worker));
    if (!queue.length) break;
  }
}

async function tmdbPoster(e) {
  if (!CFG.tmdbKey) return;
  try {
    const kind = e.type === 'series' ? 'tv' : 'movie';
    const q = encodeURIComponent(e.name);
    const yr = e.year ? '&' + (kind === 'tv' ? 'first_air_date_year=' : 'year=') + e.year : '';
    const r = await fetch('https://api.themoviedb.org/3/search/' + kind + '?api_key=' + CFG.tmdbKey + '&query=' + q + yr);
    const j = await r.json();
    const h = j && j.results && j.results[0];
    if (h) {
      e.poster = h.poster_path ? 'https://image.tmdb.org/t/p/w342' + h.poster_path : '';
      e.background = h.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + h.backdrop_path : '';
      e.description = h.overview || '';
    }
    e.posterTried = true;
    state.posters++;
  } catch (err) { /* try again next rebuild */ }
}

function save() {
  try { fs.writeFileSync(CFG.indexFile, JSON.stringify({ at: Date.now(), items: index })); } catch (e) {}
}

async function buildIndex() {
  if (state.crawling) return;
  state.crawling = true; state.started = Date.now(); state.error = '';
  const fresh = {};
  const add = (type, url, cat, isFile, files) => {
    const id = enc(url);
    if (fresh[id]) return;
    const seg = lastSeg(url);
    const old = byId[id];
    fresh[id] = Object.assign({}, old || {}, {
      id, type, url, cat: cat || 'Other', name: cleanName(seg), year: yearOf(seg), isFile: !!isFile
    });
    if (type === 'movie' && files && files.length) fresh[id].files = files.map((f) => ({ file: f.name, url: f.url }));
  };
  try {
    await crawlRoot('movie', CFG.movies, add);
    await crawlRoot('series', CFG.series, add);
    const items = Object.values(fresh);
    if (items.length) { index = items; byId = fresh; save(); }
    // posters, a few at a time
    const todo = index.filter((e) => !e.posterTried);
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < todo.length) { const e = todo[i++]; await tmdbPoster(e); if (i % 200 === 0) save(); }
    }));
    save();
  } catch (e) { state.error = String(e.message || e); }
  state.crawling = false; state.finished = Date.now();
}

function loadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG.indexFile, 'utf8'));
    index = j.items || []; byId = {};
    index.forEach((e) => { e.id = enc(e.url); byId[e.id] = e; });
    return j.at || 0;
  } catch (e) { return 0; }
}

// ---------- series episodes ----------
function parseEpisode(file, url) {
  const p = safeDecode(url.split('?')[0]);
  let s = null, e = null, m;
  if ((m = file.match(/s0*(\d+)[ ._-]*e0*(\d+)/i))) { s = +m[1]; e = +m[2]; }
  else if ((m = file.match(/(?:^|[^0-9])0*(\d+)x0*(\d+)(?![0-9])/i))) { s = +m[1]; e = +m[2]; }
  if (s === null) {
    const sm = p.match(/(?:^|[\/ ._-])(?:season|s)[ ._-]*0*(\d+)(?=[\/ ._-]|$)/i);
    s = sm ? +sm[1] : 1;
    const em = file.match(/(?:^|[^a-z0-9])(?:e|ep|episode)[ ._-]*0*(\d+)(?![0-9])/i) || file.match(/^0*(\d{1,3})(?=[ ._-])/);
    e = em ? +em[1] : null;
  }
  return { season: s, episode: e };
}

async function showEpisodes(entry) {
  if (showCache.has(entry.id)) return showCache.get(entry.id);
  const eps = [];
  async function walk(url, depth) {
    const { dirs, files } = await list(url);
    for (const f of files) {
      const pe = parseEpisode(f.name, f.url);
      eps.push({ file: f.name, url: f.url, season: pe.season, episode: pe.episode });
    }
    if (depth < 3) await Promise.all(dirs.map((d) => walk(d.url, depth + 1)));
  }
  if (entry.isFile) {
    const pe = parseEpisode(entry.name, entry.url);
    eps.push({ file: lastSeg(entry.url), url: entry.url, season: pe.season, episode: pe.episode });
  } else await walk(entry.url, 0);
  // files without an episode number get numbered in order inside their season
  const bySeason = {};
  eps.sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true }));
  eps.forEach((x) => { (bySeason[x.season] = bySeason[x.season] || []).push(x); });
  Object.keys(bySeason).forEach((k) => {
    let n = 0;
    bySeason[k].forEach((x) => { n++; if (x.episode === null) x.episode = n; });
  });
  showCache.set(entry.id, eps);
  return eps;
}

async function movieFiles(entry) {
  if (entry.isFile) return [{ file: lastSeg(entry.url), url: entry.url }];
  if (entry.files && entry.files.length) return entry.files;
  const out = [];
  async function walk(url, depth) {
    const { dirs, files } = await list(url);
    files.forEach((f) => out.push({ file: f.name, url: f.url }));
    if (depth < 2) await Promise.all(dirs.map((d) => walk(d.url, depth + 1)));
  }
  await walk(entry.url, 0);
  return out;
}

// ---------- Stremio endpoints ----------
const CAT_ORDER = ['Hollywood', 'Bollywood', 'Korean', 'Indian_Bangla', 'South_Indian', 'English', 'Hindi', 'Animation', 'Animes', 'Turkish', 'IMDB_TOP_250', 'Others_Language'];
const CAT_LABEL = { Indian_Bangla: 'Bengali', Others_Language: 'Others', IMDB_TOP_250: 'IMDb Top 250', South_Indian: 'South Indian' };
const catLabel = (c) => CAT_LABEL[c] || String(c).replace(/_/g, ' ');
const catalogId = (type, c) => 'dm-' + type + '-' + c;

function manifest() {
  // one catalog (one row in Nuvio) per folder, for movies and for series
  const cats = (type) => {
    const set = {};
    index.filter((e) => e.type === type).forEach((e) => { set[e.cat] = 1; });
    const all = Object.keys(set);
    const first = CAT_ORDER.filter((c) => set[c]);
    return first.concat(all.filter((c) => first.indexOf(c) < 0).sort());
  };
  const catalogs = [];
  [['movie', 'Movies'], ['series', 'Series']].forEach(([type, word]) => {
    cats(type).forEach((c) => {
      catalogs.push({ type, id: catalogId(type, c), name: catLabel(c) + ' ' + word, extra: [{ name: 'skip', isRequired: false }] });
    });
  });
  return {
    id: 'org.ispserver.dhakamovie',
    version: '1.1.0',
    name: 'Dhaka Movie (ISP)',
    description: 'Every movie and series on server1.dhakamovie.com, straight from your ISP network.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['dm.'],
    catalogs
  };
}

function parseExtra(s) {
  const o = {};
  String(s || '').split('&').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) o[safeDecode(kv.slice(0, i))] = safeDecode(kv.slice(i + 1).replace(/\+/g, ' '));
  });
  return o;
}

function toMeta(e) {
  return {
    id: e.id, type: e.type, name: e.name + (e.year && !/(19|20)\d\d/.test(e.name) ? '' : ''),
    poster: e.poster || undefined, background: e.background || undefined,
    description: e.description || ('Folder: ' + e.cat), releaseInfo: e.year || undefined, genres: [e.cat]
  };
}

function catalog(type, id, extra) {
  const cat = String(id).replace('dm-' + type + '-', '');
  let items = index.filter((e) => e.type === type && e.cat === cat);
  items.sort((a, b) => (b.year || '0').localeCompare(a.year || '0') || a.name.localeCompare(b.name));
  const skip = parseInt(extra.skip || '0', 10) || 0;
  return { metas: items.slice(skip, skip + CFG.pageSize).map(toMeta) };
}

async function meta(type, id) {
  const e = byId[id] || (dec(id).indexOf(CFG.base) === 0 ? { id, type, url: dec(id), name: cleanName(lastSeg(dec(id))), cat: '' } : null);
  if (!e) return { meta: null };
  const m = toMeta(e);
  if (type === 'series') {
    const eps = await showEpisodes(e);
    const seen = {};
    m.videos = [];
    eps.forEach((x) => {
      const k = x.season + ':' + x.episode;
      if (seen[k]) return;
      seen[k] = 1;
      m.videos.push({
        id: id + '.' + x.season + '.' + x.episode, title: 'Episode ' + x.episode, season: x.season, episode: x.episode,
        released: new Date(Date.UTC(2000, 0, 1) + (x.season * 1000 + x.episode) * 86400000).toISOString()
      });
    });
    m.videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
  }
  return { meta: m };
}

async function streams(type, rawId) {
  const parts = String(rawId).split('.');   // dm.<code>[.season.episode]
  const id = parts[0] + '.' + parts[1];
  const e = byId[id] || (dec(id).indexOf(CFG.base) === 0 ? { id, type, url: dec(id), isFile: VIDEO_RE.test(dec(id)), name: '' } : null);
  if (!e) return { streams: [] };
  let list2;
  if (type === 'series' && parts.length >= 4) {
    const s = parseInt(parts[2], 10), ep = parseInt(parts[3], 10);
    list2 = (await showEpisodes(e)).filter((x) => x.season === s && x.episode === ep);
  } else list2 = await movieFiles(e);
  return {
    streams: list2.slice(0, 15).map((x) => ({
      name: 'ISP Server' + (quality(x.file) ? '\n' + quality(x.file) : ''),
      title: x.file,
      url: x.url
    }))
  };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  try {
    if (req.method === 'OPTIONS') return send(204, '');
    const u = safeDecode(req.url.split('?')[0]).replace(/\.json$/, '');
    if (u === '/' || u === '') {
      return send(200, 'Dhaka Movie addon is running.\nTitles in list: ' + index.length + '\nBuilding the list: ' + (state.crawling ? 'yes (pages read: ' + state.pages + ')' : 'no') +
        (state.error ? '\nLast error: ' + state.error : '') + '\n\nAdd this in Nuvio:  http://<this address>/manifest', 'text/plain; charset=utf-8');
    }
    if (u === '/manifest') return send(200, manifest());
    const seg = u.split('/').filter(Boolean);
    if (seg[0] === 'catalog') return send(200, catalog(seg[1], seg[2], parseExtra(seg[3])));
    if (seg[0] === 'meta') return send(200, await meta(seg[1], seg.slice(2).join('/')));
    if (seg[0] === 'stream') return send(200, await streams(seg[1], seg.slice(2).join('/')));
    send(404, { error: 'not found' });
  } catch (e) { send(500, { error: String(e.message || e) }); }
});

async function exportSite(outDir) {
  // optional: CATS="Hollywood,Korean" exports only those folders (smaller, faster)
  const only = (process.env.CATS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (only.length) { index = index.filter((e) => only.indexOf(e.cat) >= 0); console.log('Only these folders: ' + only.join(', ') + ' (' + index.length + ' titles)'); }
  const w = (rel, obj) => {
    const f = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj));
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  const man = manifest();
  man.catalogs.forEach((c) => { c.extra = c.extra.filter((x) => x.name !== 'search'); });   // a static site cannot search
  w('manifest.json', man);
  // catalog pages
  for (const c of man.catalogs) {
    const cat = c.id.replace('dm-' + c.type + '-', '');
    const items = index.filter((e) => e.type === c.type && e.cat === cat)
      .sort((a, b) => (b.year || '0').localeCompare(a.year || '0') || a.name.localeCompare(b.name));
    const pages = Math.max(1, Math.ceil(items.length / CFG.pageSize));
    for (let n = 0; n < pages; n++) {
      const metas = items.slice(n * CFG.pageSize, (n + 1) * CFG.pageSize).map(toMeta);
      const rel = n === 0 ? 'catalog/' + c.type + '/' + c.id + '.json' : 'catalog/' + c.type + '/' + c.id + '/skip=' + (n * CFG.pageSize) + '.json';
      w(rel, { metas });
    }
  }
  console.log('Catalog pages written. Now reading every title for episodes and files...');
  let i = 0, done = 0;
  const total = index.length;
  async function one() {
    while (i < total) {
      const e = index[i++];
      if (!process.env.REFRESH && fs.existsSync(path.join(outDir, 'meta', e.type, e.id + '.json'))) { done++; continue; }
      try {
        const m = await meta(e.type, e.id);
        w('meta/' + e.type + '/' + e.id + '.json', m);
        if (e.type === 'movie') w('stream/movie/' + e.id + '.json', await streams('movie', e.id));
        else {
          for (const v of (m.meta.videos || [])) w('stream/series/' + v.id + '.json', await streams('series', v.id));
          showCache.delete(e.id);
        }
      } catch (err) { console.log('skipped ' + e.name + ': ' + (err.message || err)); }
      done++;
      if (done % 100 === 0) console.log(done + ' / ' + total + ' titles done');
    }
  }
  await Promise.all(Array.from({ length: CFG.parallel }, one));
  console.log('Finished. ' + total + ' titles written to ' + outDir);
}

if (process.argv[2] === 'export') {
  const out = process.argv[3] || 'site';
  const at = loadIndex();
  (async () => {
    if (!index.length || process.argv[4] === 'refresh') {
      console.log('Reading the server to build the list first...');
      await buildIndex();
    }
    console.log('Titles in list: ' + index.length);
    await exportSite(out);
    process.exit(0);
  })();
} else {
  server.listen(CFG.port, '0.0.0.0', () => {
    console.log('Dhaka Movie addon on port ' + CFG.port);
    console.log('Nuvio address: http://127.0.0.1:' + CFG.port + '/manifest.json');
    const at = loadIndex();
    console.log('Saved list: ' + index.length + ' titles');
    if (!at || Date.now() - at > CFG.refreshHours * 3600 * 1000) {
      console.log('Reading the server to build the list. This can take a while the first time...');
      buildIndex().then(() => console.log('List ready: ' + index.length + ' titles'));
    }
  });
}

module.exports = { buildIndex, CFG };
