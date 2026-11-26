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
  parallel: parseInt(process.env.PARALLEL || '16', 10),          // folder pages read at the same time
  maxDepth: 6,          // how many folders deep to look
  pageSize: 100,        // titles per catalog page
  refreshHours: 24      // rebuild the list when the saved one is older than this
};

const SUB_RE = /\.(srt|vtt)(\?.*)?$/i;
const VIDEO_RE = /\.(mkv|mp4|avi|webm|m3u8|ts|mov)(\?.*)?$/i;
const SEASON_DIR = /^(season|series|s)[ ._-]*0*\d+/i;

let index = [];            // all titles
let byId = {};
let state = { crawling: false, pages: 0, posters: 0, started: 0, finished: 0, error: '' };
const listCache = new Map();   // url -> { dirs, files }
const showCache = new Map();   // show id -> episodes
const sizeOf = new Map();      // video url -> bytes (when the folder page shows sizes)

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
  const out = { dirs: [], files: [], subs: [] };
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
    else if (VIDEO_RE.test(full)) {
      out.files.push({ name, url: full });
      // size shown on the folder page after the date, e.g. "12-Nov-2026 10:30  1503238553" or "... 1.4G"
      const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 300).split(/<a\s|\n|<\/tr>/i)[0]
        .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim();
      const sm = tail.match(/\d\d:\d\d(?::\d\d)?\s+(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?\s*$/i);
      if (sm) sizeOf.set(full, Math.round(parseFloat(sm[1]) * ({ '': 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 })[sm[2].toUpperCase()]));
    } else if (SUB_RE.test(full)) out.subs.push({ name, url: full });
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
  { const t = s.replace(/\s+(?:2160p|1080p|720p|480p|4k|hdcam|hdts|camrip|dvdscr|predvd|hdrip|webrip|web ?dl|bluray|brrip|bdrip|hevc|x264|x265|rip)\b.*$/i, '').trim(); if (t.length >= 2) s = t; }
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
async function crawlRoot(type, rootPath, add, known) {
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
      for (const d of dirs) {
        // update mode: a folder that is already a known title is not opened again
        const k = known && known[enc(d.url)];
        if (k && !k.isFile && k.type === type && job.depth > 0) { add(type, d.url, job.cat, false, k.files && k.files.map((f) => ({ name: f.file, url: f.url }))); continue; }
        queue.push({ url: d.url, depth: job.depth + 1, cat: job.depth === 0 ? d.name : job.cat, name: d.name });
      }
    }
  }
  // the queue can be empty for a moment while others work, so run workers in rounds
  while (true) {
    await Promise.all(Array.from({ length: CFG.parallel }, worker));
    if (!queue.length) break;
  }
}

// ---------- posters ----------
const normT = (t) => String(t || '').toLowerCase().replace(/['\u2019`]/g, '').replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ')
  .split(' ').filter((w) => w && w !== 'and' && w !== 'the').join(' ');
const TAGS = /\b(2160p|1080p|720p|480p|360p|4k|uhd|hdr|bluray|blu-ray|brrip|bdrip|webrip|web[ -]?dl|hdrip|hdtv|dvdrip|dvdscr|hdcam|hdts|hdtc|camrip|cam|predvd|pre-dvd|hq|rip|x264|x265|hevc|h264|h265|10bit|hindi|english|bangla|bengali|tamil|telugu|malayalam|kannada|korean|dual|multi|audio|dubbed|esubs?|subs?|amzn|nf|complete|season|uncut|unrated|proper|repack|extended|remastered|imax)\b.*$/i;

function searchName(e) {
  let n = String(e.name || '');
  // cut the junk tags, but never when the tag is the very first word (a title can start with "Cam" or "Rip")
  const m = TAGS.exec(n);
  if (m && m.index > 0) n = n.slice(0, m.index);
  n = n.replace(/[\[\(\{].*$/, ' ').trim();           // anything after an opening bracket
  const noYear = n.replace(/\b(19|20)\d\d\b.*$/, '').trim();
  if (noYear) n = noYear;
  return n.trim();
}
async function getJson(url) {
  try { const r = await fetch(url); return await r.json(); } catch (err) { return null; }
}
const yearNum = (d) => parseInt(String(d || '').slice(0, 4), 10) || 0;

// everything extra we keep for one title: rating, genres, cast with photos, trailers, franchise, seasons, original language
async function fetchDetails(e, kind, id) {
  const more = kind === 'tv' ? 'content_ratings' : 'release_dates';
  const d = await getJson('https://api.themoviedb.org/3/' + kind + '/' + id + '?api_key=' + CFG.tmdbKey + '&append_to_response=credits,videos,external_ids,recommendations,' + more);
  if (!d || d.status_code) return false;
  const crew = (d.credits && d.credits.crew) || [];
  const cast = (d.credits && d.credits.cast) || [];
  const title = d.title || d.name || '', orig = d.original_title || d.original_name || '';
  const seasons = {};
  (d.seasons || []).forEach((x) => { if (x.season_number > 0 && x.episode_count) seasons[x.season_number] = x.episode_count; });
  // videos: trailers first, then teasers, clips, featurettes, behind the scenes
  const ORDER = ['Trailer', 'Teaser', 'Clip', 'Featurette', 'Behind the Scenes', 'Bloopers'];
  const vids = ((d.videos && d.videos.results) || []).filter((v) => v.site === 'YouTube' && v.key && ORDER.indexOf(v.type) >= 0);
  vids.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || (b.official ? 1 : 0) - (a.official ? 1 : 0));
  // age certification
  let cert = '';
  const rs = kind === 'tv' ? ((d.content_ratings && d.content_ratings.results) || []) : ((d.release_dates && d.release_dates.results) || []);
  for (const cc of ['US', 'GB', 'IN']) {
    const r = rs.find((x) => x.iso_3166_1 === cc);
    if (!r) continue;
    cert = kind === 'tv' ? (r.rating || '') : ((r.release_dates || []).map((x) => x.certification).find(Boolean) || '');
    if (cert) break;
  }
  const dir = kind === 'tv' ? [] : crew.filter((c) => c.job === 'Director');
  const writers = [];
  crew.filter((c) => ['Writer', 'Screenplay', 'Story', 'Novel', 'Creator'].indexOf(c.job) >= 0).forEach((c) => { if (writers.indexOf(c.name) < 0) writers.push(c.name); });
  const byTv = (d.created_by || []);
  const prevOmdb = e.det && e.det.omdb;
  e.det = {
    v: 3,
    title,
    rating: d.vote_average ? d.vote_average.toFixed(1) : '',
    genres: (d.genres || []).map((g) => g.name).slice(0, 4),
    runtime: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || 0,
    tagline: d.tagline || '',
    cast: cast.slice(0, 8).map((c) => c.name),
    castFull: cast.slice(0, 10).map((c) => [c.name, c.character || '', c.profile_path || '']),
    director: (kind === 'tv' ? byTv.map((c) => c.name) : dir.map((c) => c.name)).slice(0, 2),
    directorFull: (kind === 'tv' ? byTv : dir).slice(0, 2).map((c) => [c.name, c.profile_path || '']),
    writers: writers.slice(0, 3),
    released: d.release_date || d.first_air_date || '',
    status: d.status || '',
    cert,
    countries: ((d.production_countries || []).map((c) => c.name)).concat(d.production_countries && d.production_countries.length ? [] : (d.origin_country || [])).slice(0, 3),
    studios: (d.production_companies || []).slice(0, 3).map((c) => c.name),
    networks: (d.networks || []).slice(0, 2).map((n) => n.name),
    lang: d.original_language || '',
    imdb: (d.external_ids && d.external_ids.imdb_id) || '',
    videos: vids.slice(0, 8).map((v) => [v.key, v.type, v.name || '']),
    trailers: vids.filter((v) => v.type === 'Trailer').slice(0, 2).map((v) => v.key),
    collection: d.belongs_to_collection ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name } : null,
    rec: ((d.recommendations && d.recommendations.results) || []).slice(0, 20).map((r) => r.id),
    alt: orig && orig !== title ? [orig] : [],      // for Bengali films this is the Bengali-script title
    seasons
  };
  if (prevOmdb) e.det.omdb = prevOmdb;
  if (d.overview) e.description = d.overview;
  return true;
}

// A poster is used only when the title matches and the year fits. No poster is better than a wrong one.
function loadFixes() {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(CFG.indexFile), 'dhaka-fixes.json'), 'utf8')); } catch (err) { return {}; }
}
function fixFor(e) {
  const f = loadFixes(), n = String(e.name || '').toLowerCase(), u = String(e.url || '').toLowerCase();
  for (const k of Object.keys(f)) { const kk = k.toLowerCase(); if (n === kk || n.indexOf(kk + ' ') === 0 || (kk.length > 3 && (n.indexOf(kk) >= 0 || u.indexOf(encodeURI(kk)) >= 0))) return f[k]; }
  return null;
}
const sim = (a, b) => { const x = a.split(' '), y = b.split(' '); const sy = new Set(y); const hit = x.filter((w) => sy.has(w)).length; return hit / Math.max(x.length, y.length); };
async function tmdbPoster(e) {
  e.posterTried = true;
  e.poster = ''; e.background = ''; e.description = ''; e.tid = 0; e.det = null;
  if (!CFG.tmdbKey) return;
  let kind = e.type === 'series' ? 'tv' : 'movie';
  const fx = fixFor(e);
  if (fx && fx.tmdb) {
    if (fx.kind) kind = fx.kind;
    const j = await getJson('https://api.themoviedb.org/3/' + kind + '/' + fx.tmdb + '?api_key=' + CFG.tmdbKey);
    if (j && j.id) {
      e.poster = j.poster_path ? 'https://image.tmdb.org/t/p/w342' + j.poster_path : '';
      e.background = j.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + j.backdrop_path : '';
      e.description = j.overview || '';
      e.tid = j.id;
      await fetchDetails(e, kind, j.id);
      return;
    }
  }
  const q = searchName(e), want = normT(q), wy = parseInt(e.year, 10) || 0;
  if (!want) return;
  // the name with its numbers kept ("Batwara 1947"), and the name without a trailing year
  let full = String(e.name || '');
  const m0 = TAGS.exec(full); if (m0 && m0.index > 0) full = full.slice(0, m0.index);
  full = full.replace(/[\[\(\{].*$/, ' ').replace(/\b(19|20)\d\d\s*$/, (x) => (wy && parseInt(x, 10) === wy ? '' : x)).trim();
  const queries = Array.from(new Set([full, q].filter((x) => x && normT(x))));
  async function search(query, withYear) {
    const yr = withYear && wy ? '&' + (kind === 'tv' ? 'first_air_date_year=' : 'year=') + wy : '';
    const j = await getJson('https://api.themoviedb.org/3/search/' + kind + '?api_key=' + CFG.tmdbKey + '&query=' + encodeURIComponent(query) + yr);
    const res = (j && j.results) || [];
    const w = normT(query);
    let best = null, bs = 0;
    for (const r of res.slice(0, 10)) {
      if (!r.poster_path) continue;
      const ry = yearNum(r.release_date || r.first_air_date);
      if (wy && ry && Math.abs(ry - wy) > 1) continue;
      const names = [r.title, r.name, r.original_title, r.original_name].map(normT).filter(Boolean);
      let sc = 0;
      if (names.some((t) => t === w)) sc = 1;
      else if (w.split(' ').length >= 2 && ry === wy && names.some((t) => t.indexOf(w + ' ') === 0 || w.indexOf(t + ' ') === 0)) sc = 0.9;
      else if (w.split(' ').length >= 2 && wy && ry && Math.abs(ry - wy) <= 1) { const s2 = Math.max.apply(null, names.map((t) => sim(w, t))); if (s2 >= 0.75) sc = 0.8 * s2; }
      if (sc > bs) { bs = sc; best = r; }
    }
    return best;
  }
  let h = null;
  for (const qq of queries) { h = await search(qq, true); if (h) break; }
  if (!h && wy) for (const qq of queries) { h = await search(qq, false); if (h) break; }
  if (h) {
    e.poster = 'https://image.tmdb.org/t/p/w342' + h.poster_path;
    e.background = h.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + h.backdrop_path : '';
    e.description = h.overview || '';
    e.tid = h.id;
    await fetchDetails(e, kind, h.id);
    return;
  }
  // second source for series: TVmaze (no key needed)
  if (e.type === 'series') {
    const j = await getJson('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q));
    for (const it of (j || []).slice(0, 5)) {
      const sh = it && it.show;
      if (!sh || !sh.image) continue;
      const ry = yearNum(sh.premiered);
      if (wy && ry && Math.abs(ry - wy) > 1) continue;
      if (normT(sh.name) === want) {
        e.poster = sh.image.original || sh.image.medium || '';
        e.description = String(sh.summary || '').replace(/<[^>]*>/g, '');
        return;
      }
    }
  }
}

function save() {
  try { fs.writeFileSync(CFG.indexFile, JSON.stringify({ at: Date.now(), items: index })); } catch (e) {}
}

async function buildIndex(incremental) {
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
    // when a title is first seen it gets a date (used by the "Recently Added" row); the very first build leaves it empty
    if (!old) { fresh[id].added = Object.keys(byId).length ? Date.now() : 0; state.newCount = (state.newCount || 0) + 1; }
    if (type === 'movie' && files && files.length) fresh[id].files = files.map((f) => ({ file: f.name, url: f.url }));
  };
  try {
    state.newCount = 0;
    await crawlRoot('movie', CFG.movies, add, incremental ? byId : null);
    await crawlRoot('series', CFG.series, add, incremental ? byId : null);
    const items = Object.values(fresh);
    if (items.length) { index = items; byId = fresh; save(); }
    // posters, a few at a time
    const todo = index.filter((e) => !e.posterTried);
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < todo.length) { const e = todo[i++]; await tmdbPoster(e); if (i % 200 === 0) save(); }
    }));
    save();
  } catch (e) { state.error = String(e.message || e); }
  state.crawling = false; state.finished = Date.now();
}

// real audio languages found by "probe": url -> ['Hindi','English'] (series: one entry per folder, key 'dir:<folder url>')
const AUDIO_FILE = process.env.AUDIO_FILE || path.join(__dirname, 'dhaka-audio.json');
let audioMap = {};
function loadAudio() { try { audioMap = JSON.parse(fs.readFileSync(AUDIO_FILE, 'utf8')); } catch (e) { audioMap = {}; } }
function saveAudio() { try { fs.writeFileSync(AUDIO_FILE, JSON.stringify(audioMap)); } catch (e) {} }
const audioFor = (url) => audioMap[url] || audioMap['dir:' + String(url).replace(/[^\/]*$/, '')] || null;

function loadIndex() {
  loadAudio();
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

// ---------- subtitles (.srt / .vtt found next to the videos) ----------
function subLang(name) {
  const n = ' ' + safeDecode(name).toLowerCase().replace(/[._()\[\]-]+/g, ' ') + ' ';
  if (/ (bn|ben|bangla|bengali) /.test(n)) return 'ben';
  if (/ (hi|hin|hindi) /.test(n)) return 'hin';
  if (/ (ar|ara|arabic) /.test(n)) return 'ara';
  if (/ (ko|kor|korean) /.test(n)) return 'kor';
  if (/ (tr|tur|turkish) /.test(n)) return 'tur';
  return 'eng';
}
const baseOf = (n) => safeDecode(n).toLowerCase().replace(/\.(mkv|mp4|avi|webm|m3u8|ts|mov|srt|vtt)$/, '').replace(/[^a-z0-9]+/g, '');
function pickSubs(subs, file, season, episode, isSeries, videoCount) {
  if (!subs.length) return [];
  const vb = baseOf(file);
  let hit = subs.filter((x) => { const sb = baseOf(x.name); return sb === vb || sb.indexOf(vb) === 0 || (vb.length > 8 && vb.indexOf(sb) === 0); });
  if (!hit.length && isSeries && episode !== null) {
    hit = subs.filter((x) => { const pe = parseEpisode(x.name, x.url); return pe.episode === episode && pe.season === season; });
  }
  if (!hit.length && !isSeries && videoCount <= 1) hit = subs;
  return hit.slice(0, 8).map((x, i) => ({ id: 'dm-' + i + '-' + safeDecode(x.name), url: x.url, lang: subLang(x.name) }));
}

async function showEpisodes(entry) {
  if (showCache.has(entry.id)) return showCache.get(entry.id);
  const eps = [];
  const allSubs = [];
  async function walk(url, depth) {
    const { dirs, files, subs } = await list(url);
    subs.forEach((x) => allSubs.push(x));
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
  eps.forEach((x) => { x.subs = pickSubs(allSubs, x.file, x.season, x.episode, true, 0); });
  showCache.set(entry.id, eps);
  return eps;
}

async function movieSubs(entry) {
  const found = [];
  try {
    const top = await list(entry.url);
    top.subs.forEach((x) => found.push(x));
    for (const d of top.dirs.filter((d) => /sub|srt|caption/i.test(d.name)).slice(0, 3)) (await list(d.url)).subs.forEach((x) => found.push(x));
  } catch (e) {}
  return found;
}

async function movieFiles(entry) {
  if (entry.isFile) return [{ file: lastSeg(entry.url), url: entry.url }];
  if (entry.files && entry.files.length) {
    const subs = await movieSubs(entry);
    return entry.files.map((f) => Object.assign({}, f, { subs: pickSubs(subs, f.file, null, null, false, entry.files.length) }));
  }
  const out = [];
  async function walk(url, depth) {
    const { dirs, files } = await list(url);
    files.forEach((f) => out.push({ file: f.name, url: f.url }));
    if (depth < 2) await Promise.all(dirs.map((d) => walk(d.url, depth + 1)));
  }
  await walk(entry.url, 0);
  const subs = await movieSubs(entry);
  out.forEach((f) => { f.subs = pickSubs(subs, f.file, null, null, false, out.length); });
  return out;
}

// ---------- probe: real audio tracks with ffprobe ----------
const { execFile } = require('child_process');
const ISO3 = { hin: 'Hindi', eng: 'English', ben: 'Bengali', bng: 'Bengali', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', kan: 'Kannada', kor: 'Korean', tur: 'Turkish', jpn: 'Japanese', zho: 'Chinese', chi: 'Chinese', urd: 'Urdu', pan: 'Punjabi', mar: 'Marathi', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', rus: 'Russian', tha: 'Thai', ara: 'Arabic', ind: 'Indonesian', por: 'Portuguese' };
function haveFfprobe() { return new Promise((r) => execFile('ffprobe', ['-version'], { timeout: 10000 }, (err) => r(!err))); }
const probeFail = { n: 0, last: '' };
function probeFile(url) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-rw_timeout', '20000000', '-select_streams', 'a', '-show_entries', 'stream=index:stream_tags=language,title', '-of', 'json', url],
      { timeout: 60000, maxBuffer: 2000000 }, (err, out, stderr) => {
        if (err) { probeFail.n++; probeFail.last = String((stderr || err.message || err)).split('\n')[0].slice(0, 160); return resolve(null); }
        try {
          const langs = [];
          (JSON.parse(out).streams || []).forEach((st) => {
            const t = st.tags || {};
            let name = ISO3[String(t.language || '').toLowerCase()];
            if (!name && t.title) { const w = safeDecode(t.title).toLowerCase(); const hit = AUDIO_WORDS.find(([, re]) => new RegExp('\\b(?:' + re + ')\\b').test(w)); if (hit) name = hit[0]; }
            if (name && langs.indexOf(name) < 0) langs.push(name);
          });
          resolve(langs);
        } catch (e) { resolve(null); }
      });
  });
}
async function probeTitles(titles) {
  // 1. collect the video links (movies: every file; series: two episodes of each folder)
  const jobs = [];   // { url, dir }
  let ti = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (ti < titles.length) {
      const e = titles[ti++];
      try {
        if (e.type === 'movie') (await movieFiles(e)).forEach((f) => { if (!(f.url in audioMap)) jobs.push({ url: f.url }); });
        else {
          const byDir = {};
          (await showEpisodes(e)).forEach((x) => { const d = x.url.replace(/[^\/]*$/, ''); (byDir[d] = byDir[d] || []).push(x.url); });
          Object.keys(byDir).forEach((d) => { if (!(('dir:' + d) in audioMap)) jobs.push({ dir: d, urls: byDir[d].sort() }); });
        }
      } catch (err) {}
    }
  }));
  console.log('Files to check: ' + jobs.length);
  let i = 0, done = 0; const t0 = Date.now();
  await Promise.all(Array.from({ length: parseInt(process.env.PROBE_PARALLEL || '4', 10) }, async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      if (j.dir) {
        // one folder of episodes: check the first and the last; if they agree, the folder gets one answer, otherwise every episode is checked
        const a = await probeFile(j.urls[0]);
        const b = j.urls.length > 1 ? await probeFile(j.urls[j.urls.length - 1]) : a;
        if (a && b && a.join() === b.join()) audioMap['dir:' + j.dir] = a;
        else for (const u of j.urls) { const r = await probeFile(u); if (r) audioMap[u] = r; }
      } else {
        const r = await probeFile(j.url);
        if (r) audioMap[j.url] = r;
      }
      done++;
      if (done % 20 === 0) {
        saveAudio();
        const el = (Date.now() - t0) / 1000;
        console.log(done + ' / ' + jobs.length + ' checked, about ' + Math.round((jobs.length - done) * el / done / 60) + ' minutes left');
      }
    }
  }));
  saveAudio();
  console.log('Saved audio info for ' + Object.keys(audioMap).length + ' entries in ' + AUDIO_FILE);
  if (probeFail.n) console.log('Could not read ' + probeFail.n + ' files. Last problem: ' + probeFail.last);
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
    if (index.some((e) => e.type === type && e.added > 0)) catalogs.push({ type, id: catalogId(type, '_new'), name: 'Dhaka Recently Added', extra: [] });
    cats(type).forEach((c) => {
      catalogs.push({ type, id: catalogId(type, c), name: 'Dhaka ' + catLabel(c), extra: [{ name: 'skip', isRequired: false }] });
    });
  });
  return {
    id: 'org.ispserver.dhakamovie',
    version: '1.3.0',
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

let tidMap = null;
function similarOf(e) {
  if (!e.det || !e.det.rec || !e.det.rec.length) return [];
  if (!tidMap) { tidMap = new Map(); index.forEach((x) => { if (x.tid) tidMap.set(x.type + ':' + x.tid, x); }); }
  const out = [];
  e.det.rec.forEach((t) => { const x = tidMap.get(e.type + ':' + t); if (x && x.id !== e.id && out.length < 8) out.push(x); });
  return out;
}
const fmtDate = (d) => { const t = new Date(d); return isNaN(t) ? d : t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const srch = (q) => 'stremio:///search?search=' + encodeURIComponent(q);

function toMeta(e, full) {
  const d = e.det || null;
  const junk = d && d.title && searchName(e) !== e.name;      // the folder name has tags like HDCAM: show the real title instead
  const m = {
    id: e.id, type: e.type, name: junk ? d.title : e.name,
    poster: e.poster || undefined, background: e.background || undefined,
    description: e.description || ('Folder: ' + e.cat), releaseInfo: e.year || undefined,
    genres: (d && d.genres.length ? d.genres : []).concat([catLabel(e.cat)]),
    imdbRating: d && d.rating ? d.rating : undefined
  };
  // lets Nuvio tie this title to TMDB / IMDb and use its own rich page (certification, networks, more like this...)
  if (full && d && d.imdb) m.imdb_id = d.imdb;
  if (full && e.tid) { m.moviedb_id = e.tid; m.tmdbId = e.tid; }
  if (full && d) {
    if (d.runtime) m.runtime = d.runtime + ' min';
    if (d.cast.length) m.cast = d.cast;
    if (d.director.length) m.director = d.director;
    if (d.writers && d.writers.length) m.writer = d.writers;
    if (d.released) m.released = new Date(d.released).toISOString();
    if (d.tagline) m.slogan = d.tagline;
    if (d.countries && d.countries.length) m.country = d.countries.join(', ');
    const langName = ISO_LANG[d.lang] || '';
    if (langName) m.language = langName;
    const om = d.omdb || {};
    if (om.awards) m.awards = om.awards;
    // facts line (always visible in the description)
    const cert = d.cert || om.rated || '';
    const f = [];
    if (cert) f.push('Rated ' + cert);
    if (d.status && d.status !== 'Released') f.push(d.status);
    if (d.released) f.push((e.type === 'series' ? 'First aired ' : 'Released ') + fmtDate(d.released));
    if (d.countries && d.countries.length) f.push(d.countries.slice(0, 2).join(', '));
    if (langName) f.push('Language: ' + langName);
    if (d.runtime) f.push(d.runtime + ' min');
    if (om.rt) f.push('Rotten Tomatoes ' + om.rt);
    if (om.mc) f.push('Metacritic ' + om.mc);
    const extra = [];
    if (f.length) extra.push(f.join(' · '));
    if (om.awards) extra.push('Awards: ' + om.awards);
    if (d.studios && d.studios.length) extra.push('Studio: ' + d.studios.join(', ') + (d.networks && d.networks.length ? ' · Network: ' + d.networks.join(', ') : ''));
    if (extra.length) m.description = (m.description || '') + '\n\n' + extra.join('\n');
    // cast row: the director comes first
    const castRow = [];
    (d.directorFull || []).slice(0, 1).forEach((c) => castRow.push({ name: c[0], character: 'Director', photo: c[1] ? 'https://image.tmdb.org/t/p/w185' + c[1] : undefined }));
    (d.castFull || []).forEach((c) => castRow.push({ name: c[0], character: c[1] || undefined, photo: c[2] ? 'https://image.tmdb.org/t/p/w185' + c[2] : undefined }));
    if (castRow.length) m.app_extras = { cast: castRow };
    // trailers, teasers, clips, featurettes
    if (d.videos && d.videos.length) {
      m.trailers = d.videos.map((v) => ({ source: v[0], type: v[1] === 'Trailer' ? 'Trailer' : 'Clip' }));
      m.trailerStreams = d.videos.map((v) => ({ title: v[1] + (v[2] ? ': ' + v[2] : ''), ytId: v[0] }));
    } else if (d.trailers && d.trailers.length) {
      m.trailers = d.trailers.map((k) => ({ source: k, type: 'Trailer' }));
      m.trailerStreams = d.trailers.map((k) => ({ title: 'Trailer', ytId: k }));
    }
    // clickable tags: each opens a search in your library
    const links = [];
    d.cast.slice(0, 8).forEach((n) => links.push({ name: n, category: 'Cast', url: srch(n) }));
    d.director.forEach((n) => links.push({ name: n, category: 'Director', url: srch(n) }));
    (d.writers || []).forEach((n) => links.push({ name: n, category: 'Writer', url: srch(n) }));
    d.genres.forEach((n) => links.push({ name: n, category: 'Genres', url: srch(n) }));
    (d.studios || []).forEach((n) => links.push({ name: n, category: 'Studio', url: srch(n) }));
    if (d.collection) links.push({ name: d.collection.name, category: 'Collection', url: srch(d.collection.name) });
    similarOf(e).forEach((x) => links.push({ name: x.name, category: 'More like this', url: 'stremio:///detail/' + x.type + '/' + x.id }));
    if (links.length) m.links = links;
  }
  return m;
}

// titles of one row; "_new" is the Recently Added row
function catItems(type, cat) {
  if (cat === '_new') return index.filter((e) => e.type === type && e.added > 0).sort((a, b) => b.added - a.added).slice(0, CFG.pageSize);
  return index.filter((e) => e.type === type && e.cat === cat)
    .sort((a, b) => (b.year || '0').localeCompare(a.year || '0') || a.name.localeCompare(b.name));
}

function catalog(type, id, extra) {
  const cat = String(id).replace('dm-' + type + '-', '');
  const items = catItems(type, cat);
  const skip = parseInt(extra.skip || '0', 10) || 0;
  return { metas: items.slice(skip, skip + CFG.pageSize).map((e) => toMeta(e)) };
}

// which episodes of each season are on the server, compared with TMDB
function availability(e, videos) {
  const want = e && e.det && e.det.seasons;
  if (!want || !videos || !videos.length) return null;
  const have = {};
  videos.forEach((v) => { (have[v.season] = have[v.season] || {})[v.episode] = 1; });
  const parts = []; let complete = true;
  Object.keys(want).map(Number).sort((a, b) => a - b).forEach((sn) => {
    const n = want[sn], h = have[sn] || {};
    const miss = [];
    for (let k = 1; k <= Math.min(n, 300); k++) if (!h[k]) miss.push(k);
    if (miss.length) complete = false;
    const got = n - miss.length;
    let t = 'S' + sn + ' ' + got + '/' + n;
    if (miss.length && miss.length < n) {
      const r = []; let a = miss[0], b = a;
      for (let q = 1; q <= miss.length; q++) { if (miss[q] === b + 1) { b = miss[q]; continue; } r.push(a === b ? 'E' + a : 'E' + a + '-' + b); a = miss[q]; b = a; }
      t += ' (missing ' + r.slice(0, 4).join(', ') + (r.length > 4 ? '...' : '') + ')';
    } else if (miss.length === n) t = 'S' + sn + ' not on server';
    parts.push(t);
  });
  if (!parts.length) return null;
  return { complete, text: (complete ? 'Complete series. ' : 'Not complete. ') + 'On your server: ' + parts.slice(0, 8).join(' | ') + (parts.length > 8 ? ' ...' : '') };
}

// episode names, descriptions and pictures from TMDB
const seasonCache = new Map();
// which audio languages and subtitle files exist on the server for this title (read from the stream files already exported)
function serverSummary(outDir, e, videos) {
  try {
    const files = [];
    if (e.type === 'movie') files.push(path.join(outDir, 'stream', 'movie', e.id + '.json'));
    else {
      const seen = {};
      (videos || []).forEach((v) => { if (!seen[v.season] && Object.keys(seen).length < 4) { seen[v.season] = 1; files.push(path.join(outDir, 'stream', 'series', v.id + '.json')); } });
    }
    const aud = [], subs = []; let named = false;
    files.forEach((f) => {
      if (!fs.existsSync(f)) return;
      (JSON.parse(fs.readFileSync(f, 'utf8')).streams || []).forEach((st) => {
        const lines = String(st.name || '').split('\n');
        const a = lines[lines.length - 1];
        if (a && a !== 'Original audio' && lines.length > 1) {
          if (/\(per name\)/.test(a)) named = true;
          a.replace(/\((?:dub|per name)\)/g, '').split('+').map((x) => x.trim()).filter(Boolean).forEach((l) => { if (aud.indexOf(l) < 0) aud.push(l); });
        }
        (st.subtitles || []).forEach((sb) => { const n = ISO3[sb.lang] || sb.lang; if (subs.indexOf(n) < 0) subs.push(n); });
      });
    });
    const parts = [];
    if (aud.length) parts.push('Audio: ' + aud.join(', ') + (named ? ' (from file names)' : ''));
    if (subs.length) parts.push('Subtitle files: ' + subs.join(', '));
    return parts.length ? 'On your server — ' + parts.join(' · ') : '';
  } catch (err) { return ''; }
}

async function enrichVideos(m, e) {
  if (!e.tid || !CFG.tmdbKey || !m.videos || !m.videos.length) return;
  const seasons = Array.from(new Set(m.videos.map((v) => v.season)));
  for (const sn of seasons) {
    const k = e.tid + ':' + sn;
    if (!seasonCache.has(k)) {
      const j = await getJson('https://api.themoviedb.org/3/tv/' + e.tid + '/season/' + sn + '?api_key=' + CFG.tmdbKey);
      seasonCache.set(k, j && j.episodes ? j.episodes : []);
      if (seasonCache.size > 500) seasonCache.delete(seasonCache.keys().next().value);
    }
    const eps = seasonCache.get(k);
    m.videos.forEach((v) => {
      if (v.season !== sn) return;
      const x = eps.find((y) => y.episode_number === v.episode);
      if (!x) return;
      if (x.name) v.title = x.name;
      if (x.overview) v.overview = x.overview;
      if (x.still_path) v.thumbnail = 'https://image.tmdb.org/t/p/w300' + x.still_path;
      if (x.air_date) v.released = new Date(x.air_date).toISOString();
    });
  }
}

async function meta(type, id) {
  const e = byId[id] || (dec(id).indexOf(CFG.base) === 0 ? { id, type, url: dec(id), name: cleanName(lastSeg(dec(id))), cat: '' } : null);
  if (!e) return { meta: null };
  const m = toMeta(e, true);
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
    await enrichVideos(m, e);
    const av = availability(e, m.videos);
    if (av) { e.complete = av.complete ? 1 : 0; m.description = (m.description || '') + '\n\n' + av.text; }
  }
  return { meta: m };
}

function fmtSize(b) {
  if (!b) return '';
  return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB';
}
function fileInfo(file) {
  const f = safeDecode(file);
  const res = (f.match(/2160p|4k|1080p|720p|480p/i) || [''])[0].toLowerCase().replace('4k', '2160p');
  let src = '';
  if (/blu[ ._-]?ray|brrip|bdrip/i.test(f)) src = 'BluRay';
  else if (/web[ ._-]?dl/i.test(f)) src = 'WEB-DL';
  else if (/webrip/i.test(f)) src = 'WEBRip';
  else if (/hdrip/i.test(f)) src = 'HDRip';
  else if (/hdtv/i.test(f)) src = 'HDTV';
  else if (/dvdrip/i.test(f)) src = 'DVDRip';
  else if (/hdcam|(^|[^a-z])cam([^a-z]|$)/i.test(f)) src = 'CAM';
  const codec = /x265|hevc|h[ .]?265/i.test(f) ? 'HEVC' : /x264|h[ .]?264|avc/i.test(f) ? 'x264' : '';
  const hdrList = [];
  if (/dolby[ ._-]?vision|(^|[^a-z])dv([^a-z]|$)|dovi/i.test(f)) hdrList.push('Dolby Vision');
  if (/hdr10\+|hdr10plus/i.test(f)) hdrList.push('HDR10+'); else if (/hdr/i.test(f)) hdrList.push('HDR');
  if (/atmos/i.test(f)) hdrList.push('Atmos');
  if (/imax/i.test(f)) hdrList.push('IMAX');
  const hdr = hdrList.join(' · ');
  return { res, src, codec, hdr, rank: { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 }[res] || 0 };
}

// ---------- audio language of each file ----------
const ISO_LANG = { en: 'English', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', ko: 'Korean', tr: 'Turkish', ja: 'Japanese', zh: 'Chinese', ur: 'Urdu', pa: 'Punjabi', mr: 'Marathi', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', ru: 'Russian', th: 'Thai', ar: 'Arabic', id: 'Indonesian', pt: 'Portuguese' };
const FOLDER_LANG = { Hollywood: 'English', English: 'English', Animation: 'English', Bollywood: 'Hindi', Hindi: 'Hindi', Indian_Bangla: 'Bengali', Korean: 'Korean', Turkish: 'Turkish', Animes: 'Japanese' };
const AUDIO_WORDS = [['Hindi', 'hindi|hin'], ['English', 'english|eng'], ['Bengali', 'bengali|bangla|bangali'], ['Tamil', 'tamil'], ['Telugu', 'telugu'], ['Malayalam', 'malayalam'], ['Kannada', 'kannada'], ['Korean', 'korean'], ['Urdu', 'urdu'], ['Turkish', 'turkish'], ['Japanese', 'japanese'], ['Chinese', 'chinese|mandarin'], ['Spanish', 'spanish'], ['French', 'french'], ['Punjabi', 'punjabi']];
function originLang(e) {
  const l = e && e.det && e.det.lang;
  return (l && ISO_LANG[l]) || (e && FOLDER_LANG[e.cat]) || '';
}
function audioInfo(file, e, known) {
  let f = ' ' + safeDecode(file).replace(/\.(mkv|mp4|avi|webm|ts|mov)$/i, '').replace(/[._\-+,&()\[\]{}]+/g, ' ').toLowerCase() + ' ';
  f = f.replace(/\b(?:(?:english|eng|hindi|hin|bangla|bengali|arabic|multi)\s+)?(?:e\s?)?subs?(?:titles?)?\b/g, ' ');   // "English ESubs" are subtitles, not audio
  const tags = [];
  AUDIO_WORDS.forEach(([n, re]) => { if (new RegExp('\\b(?:' + re + ')\\b').test(f)) tags.push(n); });
  const origin = originLang(e);
  const audio = tags.slice();
  if (/\b(?:dual|multi)\b/.test(f)) [origin, 'Hindi'].forEach((l) => { if (l && audio.indexOf(l) < 0) audio.push(l); });
  const named = audio.length > 0;                            // the file name claims a language
  if (known && known.length) { audio.length = 0; known.forEach((l) => audio.push(l)); }   // real tracks found by "probe" win
  else if (!audio.length && origin) audio.push(origin);     // no language in the name: the original audio
  const dub = /\bdub(?:bed)?\b/.test(f) || (!!origin && audio.length > 0 && audio.indexOf(origin) < 0);
  return { audio, origin, dub, named: named && !(known && known.length) };
}
function labelStream(file, sizeText, e, url) {
  const i = fileInfo(file), a = audioInfo(file, e, url ? audioFor(url) : null);
  const top = [i.res, sizeText].filter(Boolean).join(' \u00b7 ');
  const au = a.audio.length ? a.audio.join(' + ') + (a.dub ? ' (dub)' : '') + (a.named ? ' (per name)' : '') : 'Original audio';
  const note = [a.origin && a.audio.length && a.audio.indexOf(a.origin) < 0 ? 'Original: ' + a.origin : '', i.src, i.codec, i.hdr].filter(Boolean).join(' \u00b7 ');
  const om = (e && e.det && e.det.omdb) || {};
  const score = [om.rt ? 'Rotten Tomatoes ' + om.rt : '', om.mc ? 'Metacritic ' + om.mc : ''].filter(Boolean).join(' \u00b7 ');
  const award = om.awards ? String(om.awards).slice(0, 70) : '';
  const extra = [score, award].filter(Boolean).join('\n');
  return { name: 'ISP Server' + (top ? '\n' + top : '') + '\n' + au, title: file + (note ? '\n' + note : '') + (extra ? '\n' + extra : '') };
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
  const rows = list2.map((x) => ({ x, i: fileInfo(x.file), size: sizeOf.get(x.url) || 0 }));
  rows.sort((a, b) => b.i.rank - a.i.rank || b.size - a.size);   // best quality first
  return {
    streams: rows.slice(0, 15).map(({ x, i, size }) => {
      const st = Object.assign({}, labelStream(x.file, fmtSize(size), e, x.url), { url: x.url });
      if (x.subs && x.subs.length) st.subtitles = x.subs;
      return st;
    })
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
  tidMap = null;
  const fullIndex = index;   // the whole list, even when only some folders or years are exported
  // optional: CATS="Hollywood,Korean" exports only those folders (smaller, faster)
  const only = (process.env.CATS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (only.length) { index = index.filter((e) => only.indexOf(e.cat) >= 0); console.log('Only these folders: ' + only.join(', ') + ' (' + index.length + ' titles)'); }
  // optional: MIN_YEAR=2018 handles only titles from that year on (much faster)
  const minYear = parseInt(process.env.MIN_YEAR || '0', 10);
  const allIndex = index;
  const maxYear = parseInt(process.env.MAX_YEAR || '0', 10);   // optional: MAX_YEAR=2024 stops at that year
  const inRange = (e) => { const y = parseInt(e.year, 10) || 0; return y >= minYear && (!maxYear || y <= maxYear); };
  const todoSet = (minYear || maxYear) ? new Set(index.filter(inRange).map((e) => e.id)) : null;
  if (todoSet) console.log('Only titles from ' + (minYear || 'the start') + (maxYear ? ' to ' + maxYear : ' on') + ': ' + todoSet.size + ' of ' + index.length);
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
    const items = catItems(c.type, cat);
    const pages = Math.max(1, Math.ceil(items.length / CFG.pageSize));
    for (let n = 0; n < pages; n++) {
      const metas = items.slice(n * CFG.pageSize, (n + 1) * CFG.pageSize).map((e) => toMeta(e));
      const rel = n === 0 ? 'catalog/' + c.type + '/' + c.id + '.json' : 'catalog/' + c.type + '/' + c.id + '/skip=' + (n * CFG.pageSize) + '.json';
      w(rel, { metas });
    }
  }
  // list of every title, for the search service on Vercel
  const writeSearch = () => w('search-index.json', fullIndex.map((e) => [
    e.id, e.type, e.name, e.year || '', String(e.poster || '').replace('https://image.tmdb.org/t/p/w342', ''), e.cat,
    e.det && e.det.rating ? +e.det.rating : 0, e.det ? e.det.genres.join('|') : '', e.tid || 0, e.added || 0,
    e.det ? (e.det.alt || []).concat(e.det.title && searchName(e) !== e.name ? [e.det.title] : []).join(' | ') : '', e.det && e.det.collection ? e.det.collection.name : '', e.det ? e.det.runtime || 0 : 0,
    e.complete === undefined ? '' : e.complete,
    e.det ? (e.det.directorFull || []).map((c) => c[0]).concat((e.det.castFull || []).slice(0, 5).map((c) => c[0])).join(' | ') : '',
    e.det && e.det.imdb ? e.det.imdb : ''
  ]));
  writeSearch();
  console.log('Catalog pages written. Now reading every title for episodes and files...');
  let i = 0, done = 0;
  const total = todoSet ? todoSet.size : index.length, t0 = Date.now();
  async function one() {
    while (i < index.length) {
      const e = index[i++];
      if (todoSet && !todoSet.has(e.id)) continue;
      const mf = path.join(outDir, 'meta', e.type, e.id + '.json');
      if (process.env.SUBS && fs.existsSync(mf)) {
        // streams-only pass: rewrite the stream files (subtitles, quality, size)
        try {
          const wr = (rel, o) => { if (o.streams.length) w(rel, o); };
          if (e.type === 'movie') wr('stream/movie/' + e.id + '.json', await streams('movie', e.id));
          else {
            const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
            for (const v of ((j.meta && j.meta.videos) || [])) wr('stream/series/' + v.id + '.json', await streams('series', v.id));
            showCache.delete(e.id);
          }
        } catch (err) {}
        done++;
        if (done % 25 === 0) { const el = (Date.now() - t0) / 1000; console.log(done + ' / ' + total + ' titles done, about ' + Math.round((total - done) * el / done / 60) + ' minutes left'); }
        continue;
      }
      if (!process.env.REFRESH && fs.existsSync(mf)) {
        // already exported: only refresh the picture and description
        try {
          const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
          if (j && j.meta) {
            Object.assign(j.meta, toMeta(e, true));
            if (e.type === 'series' && e.tid && j.meta.videos && !j.meta.videos.some((v) => v.thumbnail || v.overview)) await enrichVideos(j.meta, e);
            if (e.type === 'series') {
              const av = availability(e, j.meta.videos);
              if (av) { e.complete = av.complete ? 1 : 0; j.meta.description = (j.meta.description || '') + '\n\n' + av.text; }
            }
            const ss = serverSummary(outDir, e, j.meta.videos);
            if (ss) j.meta.description = (j.meta.description || '') + '\n\n' + ss;
            fs.writeFileSync(mf, JSON.stringify(j));
          }
        } catch (err) {}
        done++; continue;
      }
      try {
        const m = await meta(e.type, e.id);
        w('meta/' + e.type + '/' + e.id + '.json', m);
        if (e.type === 'movie') w('stream/movie/' + e.id + '.json', await streams('movie', e.id));
        else {
          for (const v of (m.meta.videos || [])) w('stream/series/' + v.id + '.json', await streams('series', v.id));
          showCache.delete(e.id);
        }
        const ss2 = serverSummary(outDir, e, m.meta.videos);
        if (ss2) { m.meta.description = (m.meta.description || '') + '\n\n' + ss2; w('meta/' + e.type + '/' + e.id + '.json', m); }
      } catch (err) { console.log('skipped ' + e.name + ': ' + (err.message || err)); }
      done++;
      if (done % 25 === 0) { const el = (Date.now() - t0) / 1000; console.log(done + ' / ' + total + ' titles done, about ' + Math.round((total - done) * el / done / 60) + ' minutes left'); }
    }
  }
  await Promise.all(Array.from({ length: CFG.parallel }, one));
  writeSearch();
  index = fullIndex; save();
  console.log('Finished. ' + total + ' titles written to ' + outDir);
}

if (process.argv[2] === 'fix') {
  loadIndex();
  const key = process.argv[3], id = parseInt(process.argv[4], 10), kd = process.argv[5] === 'tv' ? 'tv' : (process.argv[5] === 'movie' ? 'movie' : '');
  if (!key || !id) { console.log('Use: node dhaka-addon.js fix "part of folder name" TMDB-number [tv]'); process.exit(0); }
  const f = loadFixes(); f[key] = { tmdb: id }; if (kd) f[key].kind = kd;
  fs.writeFileSync(path.join(path.dirname(CFG.indexFile), 'dhaka-fixes.json'), JSON.stringify(f, null, 1));
  (async () => {
    const hits = index.filter((e) => fixFor(e));
    for (const e of hits) { await tmdbPoster(e); console.log((e.poster ? 'OK   ' : 'FAIL ') + e.name); }
    save(); process.exit(0);
  })();
} else if (process.argv[2] === 'posters') {
  loadIndex();
  (async () => {
    const todo = process.argv[3] === 'missing' ? index.filter((e) => !e.poster) : index;
    console.log('Checking posters for ' + todo.length + ' titles...');
    let i = 0, done = 0, found = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < todo.length) {
        const e = todo[i++];
        e.name = cleanName(lastSeg(e.url));
        await tmdbPoster(e);
        if (e.poster) found++;
        done++;
        if (done % 500 === 0) { console.log(done + ' / ' + todo.length + ' (' + found + ' posters found)'); save(); }
      }
    }));
    save();
    console.log('Finished. Posters found: ' + found + ' of ' + todo.length);
    process.exit(0);
  })();
} else if (process.argv[2] === 'stats') {
  // how many titles still have no poster / no details, and which ones
  loadIndex();
  const noPoster = index.filter((e) => !e.poster);
  const noDet = index.filter((e) => e.poster && (!e.det || e.det.v !== 3));
  console.log('Titles: ' + index.length);
  console.log('Without a poster: ' + noPoster.length);
  console.log('With a poster but without full details: ' + noDet.length);
  try { fs.writeFileSync(path.join(path.dirname(CFG.indexFile), 'dhaka-unmatched.txt'), noPoster.map((e) => e.cat + ' | ' + e.year + ' | ' + e.name).join('\n')); console.log('Full list saved in dhaka-unmatched.txt'); } catch (err) {}
  console.log('First 25 without a poster:');
  noPoster.slice(0, 25).forEach((e) => console.log('  ' + e.cat + ' | ' + e.year + ' | ' + e.name));
  process.exit(0);
} else if (process.argv[2] === 'omdb') {
  // Rotten Tomatoes, Metacritic, awards and age rating from OMDb. Needs a free key from omdbapi.com (about 1000 titles a day).
  const key = process.env.OMDB_KEY;
  if (!key) { console.log('Put your key first, like this:  OMDB_KEY=yourkey node dhaka-addon.js omdb'); process.exit(1); }
  loadIndex();
  const limit = parseInt(process.env.LIMIT || '900', 10);
  const todo = index.filter((e) => e.det && e.det.imdb && !e.det.omdb)
    .sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0)).slice(0, limit);
  (async () => {
    console.log('Titles to look up today: ' + todo.length);
    let i = 0, done = 0, stop = false;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < todo.length && !stop) {
        const e = todo[i++];
        const j = await getJson('https://www.omdbapi.com/?apikey=' + key + '&i=' + e.det.imdb);
        if (!j) continue;
        if (j.Response === 'False') {
          if (/limit|invalid api key/i.test(j.Error || '')) { stop = true; console.log('OMDb says: ' + j.Error); break; }
          e.det.omdb = {}; continue;
        }
        const rt = (j.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
        e.det.omdb = {
          rt: rt ? rt.Value : '',
          mc: j.Metascore && j.Metascore !== 'N/A' ? j.Metascore : '',
          awards: j.Awards && j.Awards !== 'N/A' ? j.Awards : '',
          rated: j.Rated && !/N\/A|Not Rated|Unrated/i.test(j.Rated) ? j.Rated : ''
        };
        done++;
        if (done % 100 === 0) { save(); console.log(done + ' done'); }
      }
    }));
    save();
    console.log('Saved ' + done + ' titles.' + (stop ? ' The daily limit was reached. Run it again tomorrow to continue.' : '') + ' Now run the export.');
    process.exit(0);
  })();
} else if (process.argv[2] === 'probe') {
  // reads the real audio tracks of the videos (needs ffprobe: pkg install ffmpeg). MIN_YEAR / MAX_YEAR choose the titles.
  loadIndex();
  const minY = parseInt(process.env.MIN_YEAR || '0', 10), maxY = parseInt(process.env.MAX_YEAR || '0', 10);
  const titles = index.filter((e) => { const y = parseInt(e.year, 10) || 0; return y >= minY && (!maxY || y <= maxY); });
  (async () => {
    if (!(await haveFfprobe())) { console.log('ffprobe was not found. Run:  pkg install ffmpeg   and then try again.'); process.exit(1); }
    console.log('Titles in range: ' + titles.length + ' of ' + index.length);
    await probeTitles(titles);
    console.log('Finished. Now run the relabel command.');
    process.exit(0);
  })();
} else if (process.argv[2] === 'details') {
  // fills in cast photos, trailers, franchise, seasons and original language for titles that already have a TMDB match
  loadIndex();
  (async () => {
    const todo = index.filter((e) => e.tid && (process.env.FORCE || !e.det || e.det.v !== 3));
    console.log('Titles to fill in: ' + todo.length + ' of ' + index.length);
    let i = 0, done = 0; const t0 = Date.now();
    await Promise.all(Array.from({ length: 10 }, async () => {
      while (i < todo.length) {
        const e = todo[i++];
        await fetchDetails(e, e.type === 'series' ? 'tv' : 'movie', e.tid);
        done++;
        if (done % 250 === 0) {
          save();
          const el = (Date.now() - t0) / 1000;
          console.log(done + ' / ' + todo.length + ' done, about ' + Math.round((todo.length - done) * el / done / 60) + ' minutes left');
        }
      }
    }));
    save();
    console.log('Finished. Now run the export.');
    process.exit(0);
  })();
} else if (process.argv[2] === 'relabel') {
  // rewrites the audio / quality text of every stream file, using only the files already exported (no server needed)
  const out = process.argv[3] || 'site';
  loadIndex();
  let n = 0, changed = 0;
  for (const kind of ['movie', 'series']) {
    const dir = path.join(out, 'stream', kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const parts = f.replace(/\.json$/, '').split('.');
      const e = byId[parts[0] + '.' + parts[1]];
      try {
        const fp = path.join(dir, f);
        const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        let c = false;
        (j.streams || []).forEach((st) => {
          const file = String(st.title || '').split('\n')[0];
          const size = (String(st.name || '').match(/\d+(?:\.\d+)? (?:GB|MB)/) || [''])[0];
          const lab = labelStream(file, size, e, st.url);
          if (lab.name !== st.name || lab.title !== st.title) { st.name = lab.name; st.title = lab.title; c = true; }
        });
        if (c) { fs.writeFileSync(fp, JSON.stringify(j)); changed++; }
      } catch (err) {}
      n++;
      if (n % 5000 === 0) console.log(n + ' stream files checked');
    }
  }
  console.log('Finished. ' + n + ' stream files checked, ' + changed + ' changed.');
  process.exit(0);
} else if (process.argv[2] === 'update') {
  // one command: look for new titles, export them, and upload to GitHub
  const out = process.argv[3] || 'site';
  loadIndex();
  (async () => {
    console.log('Looking for new titles on the server...');
    await buildIndex(true);
    console.log('Titles in list: ' + index.length + '. New since last time: ' + (state.newCount || 0));
    if (state.error) console.log('Note: ' + state.error);
    if (state.newCount && await haveFfprobe()) {
      console.log('Checking the audio tracks of the new titles...');
      await probeTitles(index.filter((e) => e.added && Date.now() - e.added < 6 * 3600 * 1000));
    }
    await exportSite(out);
    if (process.argv[4] !== 'nopush') {
      const { execSync } = require('child_process');
      const run = (c, cwd) => { try { console.log('> ' + c); execSync(c, { cwd, stdio: 'inherit' }); return true; } catch (err) { return false; } };
      let top;
      try { top = execSync('git rev-parse --show-toplevel', { cwd: path.resolve(out) }).toString().trim(); } catch (err) { console.log('The folder ' + out + ' is not inside a git repository, so nothing was uploaded.'); process.exit(0); }
      run('git add -A', top);
      run('git commit -m "update titles"', top);
      run('git pull --no-rebase --no-edit', top);
      console.log(run('git push', top) ? 'Uploaded. Wait about a minute, then open Nuvio.' : 'Upload failed. Run: cd ' + top + ' and then git push');
    }
    process.exit(0);
  })();
} else if (process.argv[2] === 'export') {
  const out = process.argv[3] || 'site';
  const at = loadIndex();
  (async () => {
    if (process.argv[4] === 'streams' || process.argv[4] === 'subs') process.env.SUBS = '1';
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
