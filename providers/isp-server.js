var CONFIG = {
  servers: [
    { name: 'Server1', base: 'http://server1.dhakamovie.com/', searchUrl: '',
      paths: { movie: ['Movies/'], tv: ['Tv_Shows/'] } }
  ],
  tmdbApiKey: '18c5a939865f2d093d1bcda9b234b58b',     // paste your TMDB key between the two quote marks
  authHeader: '',     // leave empty
  // Optional file in your GitHub repo for titles that cannot be found automatically.
  overridesUrl: 'https://raw.githubusercontent.com/majed6222/isp-nuvio/refs/heads/main/overrides.json',
  maxRequests: 200,   // page fetches per server, per title
  parallel: 6,        // pages fetched at the same time
  maxDepth: 6,        // how many folders deep to look
  timeoutMs: 8000,
  debug: true         // when nothing is found, show "ISP DEBUG" sources that say why
};

var VIDEO_RE = /\.(mkv|mp4|avi|webm|m3u8|ts|mov)(\?.*)?$/i;
var DBG = { tmdb: '', pages: 0, ok: 0, lastErr: '', seen: [], ov: false };

// Folder-name words that match the title's original language, so the likely folders are searched first.
var LANG_HINT = {
  en: 'english|hollywood', hi: 'hindi|bollywood', bn: 'bangla|bengali|dhallywood',
  ko: 'korean', tr: 'turkish', ja: 'anim|japan', zh: 'chinese', es: 'spanish', fr: 'french',
  de: 'german', ru: 'russian', th: 'thai', ta: 'south|tamil', te: 'south|telugu',
  ml: 'south|malayalam', kn: 'south|kannada'
};

function isArr(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

function debugStream(msg) {
  return String(msg).split(' | ').map(function (part, i) {
    return { name: 'ISP DEBUG ' + (i + 1) + ': ' + part, title: part, url: 'http://127.0.0.1/debug' + (i + 1), quality: 'Unknown', provider: 'isp-local' };
  });
}

function norm(s) {
  s = String(s || '');
  if (s.normalize) { try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {} }
  s = s.toLowerCase().replace(/['\u2019`]/g, '').replace(/&amp;|&/g, ' ').replace(/[^a-z0-9]+/g, ' ');
  // "and" is dropped everywhere, because folders often leave out "&" (Law & Order -> Law-Order)
  return s.split(' ').filter(function (w) { return w && w !== 'and'; }).join(' ');
}

function http(url) {
  var headers = { 'User-Agent': 'Mozilla/5.0' };
  if (CONFIG.authHeader) headers['Authorization'] = CONFIG.authHeader;
  DBG.pages++;
  var req = fetch(url, { headers: headers })
    .then(function (r) {
      if (!r.ok) { DBG.lastErr = 'HTTP ' + r.status; return null; }
      DBG.ok++;
      return r.text();
    })
    .catch(function (e) { DBG.lastErr = String(e && e.message ? e.message : e); return null; });
  // Nuvio's JS engine may not have setTimeout, so the timeout is only used when it exists
  if (typeof setTimeout !== 'function') return req;
  var timeout = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, CONFIG.timeoutMs);
  });
  return Promise.race([req, timeout]);
}

function loadOverrides() {
  if (!CONFIG.overridesUrl) return Promise.resolve({});
  var req = fetch(CONFIG.overridesUrl)
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (j) { return (j && typeof j === 'object') ? j : {}; });
  if (typeof setTimeout !== 'function') return req;
  var timeout = new Promise(function (resolve) {
    setTimeout(function () { resolve({}); }, 4000);
  });
  return Promise.race([req, timeout]);
}

function tmdbInfo(id, mediaType) {
  var key = (typeof TMDB_API_KEY !== 'undefined' && TMDB_API_KEY) || CONFIG.tmdbApiKey;
  if (!key) return Promise.reject(new Error('Set tmdbApiKey in CONFIG'));
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  return fetch('https://api.themoviedb.org/3/' + kind + '/' + id + '?api_key=' + key + '&append_to_response=alternative_titles')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || (!j.title && !j.name)) throw new Error('TMDB: ' + (j && j.status_message ? j.status_message : 'no data'));
      var titles = [];
      [j.title, j.name, j.original_title, j.original_name].forEach(function (t) {
        if (t && titles.indexOf(t) < 0) titles.push(t);
      });
      var alts = [];
      // other names TMDB knows for the same title (e.g. "Three Bags Full: A Sheep Detective Movie")
      var at = j.alternative_titles && (j.alternative_titles.titles || j.alternative_titles.results);
      if (isArr(at)) at.forEach(function (x) {
        var t = x && (x.title || x.name);
        if (t && t.length >= 4 && alts.length < 12 && titles.indexOf(t) < 0 && alts.indexOf(t) < 0) alts.push(t);
      });
      titles.concat(alts.slice()).forEach(function (t) {
        var h = String(t).split(/\s*[:\u2013\u2014]\s*|\s+-\s+/)[0];
        if (h && h !== t && h.length >= 4 && titles.indexOf(h) < 0 && alts.indexOf(h) < 0) alts.push(h);
      });
      var year = String(j.release_date || j.first_air_date || '').slice(0, 4);
      var hint = LANG_HINT[j.original_language] || '';
      var anim = (j.genres || []).some(function (g) { return g && g.id === 16; });
      if (anim) hint = hint ? hint + '|anim' : 'anim';
      DBG.tmdb = titles[0] + ' ' + year;
      return { titles: titles, alts: alts, year: year, isTv: kind === 'tv', hint: hint ? new RegExp(hint, 'i') : null };
    });
}

function resolveUrl(base, href) {
  if (/^https?:\/\//i.test(href)) return href;
  var m = base.match(/^(https?:\/\/[^\/]+)(\/[^?#]*)?/i);
  if (!m) return href;
  var origin = m[1];
  if (href.charAt(0) === '/') return origin + href;
  var path = m[2] || '/';
  var dir = path.charAt(path.length - 1) === '/' ? path : path.replace(/[^\/]*$/, '');
  return origin + dir + href;
}

function originOf(u) {
  var m = String(u).match(/^(https?:\/\/[^\/]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function decodeURIComponent_safe(u) {
  try { return decodeURIComponent(u); } catch (e) { return u; }
}

function extractLinks(html, base) {
  var out = [], seen = {};
  var re = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    var href = m[1].replace(/^\s+|\s+$/g, '');
    if (!href || href.charAt(0) === '#' || href.charAt(0) === '?' || href === '../' || href === '/') continue;
    if (/^(javascript|mailto):/i.test(href)) continue;
    var url = resolveUrl(base, href);
    if (seen[url]) continue;
    seen[url] = true;
    var text = m[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/^\s+|\s+$/g, '');
    if (!text) {
      var last = url.split('?')[0].split('/').filter(Boolean).pop() || url;
      try { text = decodeURIComponent(last); } catch (e) { text = last; }
    }
    out.push({
      url: url,
      text: text,
      isDir: /\/$/.test(url.split('?')[0]),
      isVideo: VIDEO_RE.test(url)
    });
  }
  return out;
}

// What may follow the title in a file or folder name. Anything else (e.g. "Eleven Minutes",
// "Oceans Eleven") means it is a different title.
var TAIL_OK = /^(19\d\d|20\d\d|s\d+e\d+|s\d+|e\d+|\d+x\d+|season|seasons|complete|tv|series|show|shows|movie|film|webseries|480p|576p|720p|1080p|2160p|4k|uhd|hd|hdr|bluray|bdrip|brrip|webrip|web|webdl|dl|hdrip|hdtv|dvdrip|dvdscr|hdcam|cam|hdts|x264|x265|hevc|h264|h265|10bit|amzn|nf|dsnp|hmax|hulu|atvp|zee5|hindi|english|bangla|bengali|tamil|telugu|malayalam|kannada|korean|turkish|urdu|dual|audio|dubbed|multi|org|orig|original|uncut|extended|mp4|mkv|avi|webm|mov|m3u8|ts)$/;

function stripLead(s) { return s.replace(/^(the|an|a) /, ''); }

function titleMatches(text, info) {
  var en = stripLead(norm(text));
  var all = info.titles.concat(info.alts || []);
  for (var i = 0; i < all.length; i++) {
    var isAlt = i >= info.titles.length;
    var tn = stripLead(norm(all[i]));
    if (!tn) continue;
    if (en !== tn && en.indexOf(tn + ' ') !== 0) continue;      // the name must START with the title
    var rest = en.slice(tn.length).replace(/^ /, '');
    var first = rest.split(' ')[0];
    if (first && !TAIL_OK.test(first)) continue;                  // e.g. "Eleven Minutes" is another film
    var y = (' ' + rest + ' ').match(/ (19\d\d|20\d\d) /);
    if (!info.isTv && info.year && y && y[1] !== info.year) continue;
    // a short form of the title (before the ":") must carry the right year, to avoid other films of a series
    if (isAlt && !info.isTv && !(y && y[1] === info.year)) continue;
    return true;
  }
  return false;
}

function episodeMatches(text, mediaType, season, episode, url) {
  if (mediaType !== 'tv') return true;
  var s = parseInt(season, 10), e = parseInt(episode, 10);
  var a = new RegExp('s0*' + s + '[ ._-]*e0*' + e + '(?![0-9])', 'i');
  var b = new RegExp('(^|[^0-9])0*' + s + 'x0*' + e + '(?![0-9])', 'i');
  if (a.test(text) || b.test(text)) return true;
  // files named only "E02" or "Episode 2" inside a "Season 1" folder
  var path = decodeURIComponent_safe(String(url || '')).split('?')[0];
  var inSeason = new RegExp('(^|[\\/ ._-])(season|s)[ ._-]*0*' + s + '([\\/ ._-]|$)', 'i').test(path);
  var file = path.split('/').pop();
  var ep = new RegExp('(^|[^a-z0-9])(e|ep|episode)[ ._-]*0*' + e + '(?![0-9])', 'i');
  return inSeason && ep.test(file);
}

function isOtherSeason(name, season) {
  var m = String(name).match(/^(?:season|s)[ ._-]*0*(\d+)(?![0-9])/i);
  return !!m && parseInt(m[1], 10) !== parseInt(season, 10);
}

function guessQuality(text) {
  var m = String(text).match(/2160p|4k|1080p|720p|480p/i);
  return m ? (m[0].toLowerCase() === '4k' ? '2160p' : m[0].toLowerCase()) : 'Unknown';
}

function similarNames(info) {
  var t = norm(info.titles[0] || '').split(' ');
  var first = (t[0] === 'the' || t[0] === 'a' || t[0] === 'an') && t.length > 1 ? t[1] : t[0];
  if (!first || first.length < 3) return [];
  var out = [], seen = {};
  for (var i = 0; i < DBG.seen.length && out.length < 3; i++) {
    var n = DBG.seen[i];
    if (!seen[n] && (' ' + norm(n) + ' ').indexOf(' ' + first + ' ') >= 0) {
      seen[n] = 1;
      out.push(n.length > 45 ? n.slice(0, 45) + '..' : n);
    }
  }
  return out;
}

function crawl(server, info, mediaType, season, episode, extraPaths) {
  var budget = CONFIG.maxRequests, found = [], visited = {}, queue = [];
  var base = server.base, baseOrigin = originOf(base);
  if (server.searchUrl) {
    for (var i = 0; i < info.titles.length && i < 2; i++) {
      queue.push({ url: server.searchUrl.replace('{q}', encodeURIComponent(info.titles[i])), depth: 0, inMatch: false });
    }
  }
  var starts = server.paths && server.paths[mediaType === 'tv' ? 'tv' : 'movie'];
  if (starts && starts.length) {
    for (var p = 0; p < starts.length; p++) queue.push({ url: resolveUrl(base, starts[p]), depth: 0, inMatch: false });
  } else {
    queue.push({ url: base, depth: 0, inMatch: false });
  }
  // folders you listed in overrides.json are searched first, and everything inside them counts as a match
  if (isArr(extraPaths)) {
    for (var x = extraPaths.length - 1; x >= 0; x--) {
      if (typeof extraPaths[x] !== 'string') continue;
      DBG.ov = true;
      queue.unshift({ url: resolveUrl(base, encodeURI(decodeURIComponent_safe(extraPaths[x]))), depth: 0, inMatch: true });
    }
  }

  function handle(html, job) {
    var links = extractLinks(html, job.url);
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if (originOf(l.url) !== baseOrigin) continue;
      // the real file/folder name from the link (the visible text can be cut short, e.g. "Name..>")
      var seg = decodeURIComponent_safe(l.url.split('?')[0].split('/').filter(Boolean).pop() || '').replace(/^\s+|\s+$/g, '');
      if (DBG.seen.length < 6000) DBG.seen.push(seg);
      if (l.isVideo) {
        var label = l.text + ' ' + l.url;
        if ((job.inMatch || titleMatches(l.text, info) || titleMatches(seg, info)) &&
            episodeMatches(label, mediaType, season, episode, l.url)) {
          l.file = seg;
          found.push(l);
        }
      } else if (job.depth < CONFIG.maxDepth) {
        var matched = titleMatches(l.text, info) || titleMatches(seg, info);
        var next = { url: l.url, depth: job.depth + 1, inMatch: job.inMatch || matched };
        // inside a matching folder: go in first, but skip the other seasons of a series
        if (matched || job.inMatch) {
          if (job.inMatch && !matched && mediaType === 'tv' && isOtherSeason(seg, season)) continue;
          queue.unshift(next);
          continue;
        }
        // year-range folders: "2011-2020", "2010--Before", "2021--Now"
        var rng = seg.match(/^((?:19|20)\d\d)\s*[-\u2013_ ]+\s*((?:19|20)\d\d|before|older|below|earlier|after|now|present|latest|newer|onwards?|up)$/i);
        if (rng && info.year) {
          var yr = parseInt(info.year, 10), a1 = parseInt(rng[1], 10), w2 = rng[2].toLowerCase(), inR;
          if (/^\d/.test(w2)) inR = yr >= a1 && yr <= parseInt(w2, 10);
          else if (/^(before|older|below|earlier)$/.test(w2)) inR = yr <= a1;
          else inR = yr >= a1;
          if (inR) queue.unshift(next);
          else if (info.isTv) queue.push(next);
          continue;
        }
        // movie year folders: go straight to the release year and skip other years (neighbouring years last)
        if (/^(19|20)\d\d$/.test(seg) && !info.isTv && info.year) {
          if (seg === info.year) queue.unshift(next);
          else if (Math.abs(parseInt(seg, 10) - parseInt(info.year, 10)) === 1) queue.push(next);
          continue;
        }
        // a folder named after another title, e.g. "Other Movie (2001)" or "Other-Show-(TV-Series-2014)"
        if (/\([^)]*\b(19|20)\d\d\)/.test(seg)) continue;
        // folders that fit the title's language (English, Hindi, Korean...) first
        if (info.hint && info.hint.test(seg)) { queue.unshift(next); continue; }
        queue.push(next);
      }
    }
  }

  function step() {
    if (!queue.length || budget <= 0 || found.length >= 10) return Promise.resolve(found);
    var batch = [];
    while (queue.length && batch.length < CONFIG.parallel && budget > 0) {
      var job = queue.shift();
      if (found.length && !job.inMatch) continue;
      if (visited[job.url]) continue;
      visited[job.url] = true;
      budget--;
      batch.push(job);
    }
    if (!batch.length) return step();
    return Promise.all(batch.map(function (j) {
      return http(j.url).then(function (html) { return { job: j, html: html }; });
    })).then(function (rs) {
      rs.forEach(function (r) { if (r.html) handle(r.html, r.job); });
      return step();
    });
  }
  return step();
}

function getStreams(tmdbId, mediaType, season, episode) {
  DBG = { tmdb: '', pages: 0, ok: 0, lastErr: '', seen: [], ov: false };
  return Promise.all([tmdbInfo(tmdbId, mediaType), loadOverrides()]).then(function (r) {
    var info = r[0], ov = r[1] || {};
    var entry = ov[(mediaType === 'tv' ? 'tv' : 'movie') + ':' + tmdbId] || null;
    var results = [], seen = {};
    var chain = Promise.resolve();
    CONFIG.servers.forEach(function (server) {
      chain = chain.then(function () {
        var extra = entry && entry[server.name] ? entry[server.name] : null;
        return crawl(server, info, mediaType, season, episode, extra).then(function (hits) {
          hits.forEach(function (h) {
            if (seen[h.url]) return;
            seen[h.url] = true;
            var stream = {
              name: server.name + ' | ' + (h.file || h.text),
              title: h.file || h.text,
              url: h.url,
              quality: guessQuality(h.text + ' ' + h.url),
              provider: 'isp-local'
            };
            if (CONFIG.authHeader) stream.headers = { Authorization: CONFIG.authHeader };
            results.push(stream);
          });
        });
      });
    });
    return chain.then(function () {
      if (!results.length && CONFIG.debug) {
        var sim = similarNames(info);
        return debugStream('Nothing found. TMDB: ' + DBG.tmdb +
          ' | server pages ok ' + DBG.ok + '/' + DBG.pages + (DBG.lastErr ? ' | last error: ' + DBG.lastErr : '') +
          (DBG.ov ? ' | override folder was searched' : '') +
          ' | ' + (sim.length ? 'Similar names seen: ' + sim.join(' ; ') : 'No similar names seen'));
      }
      return results.slice(0, 12);
    });
  }).catch(function (err) {
    if (typeof console !== 'undefined') console.log('[isp-local] ' + (err && err.message ? err.message : err));
    return CONFIG.debug ? debugStream('Error: ' + (err && err.message ? err.message : err)) : [];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else if (typeof global !== 'undefined') {
  global.getStreams = getStreams;
}
