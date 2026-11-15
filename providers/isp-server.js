var CONFIG = {
  servers: [
    { name: 'Server1', base: 'http://server1.dhakamovie.com/', searchUrl: '',
      paths: { movie: ['Movies/'], tv: ['Tv_Shows/'] } }
  ],
  tmdbApiKey: '18c5a939865f2d093d1bcda9b234b58b',
  authHeader: '',    
  maxRequests: 60,
  maxDepth: 4,
  timeoutMs: 8000,
  debug: true         // when nothing is found, show an "ISP DEBUG" source that says why
};

var VIDEO_RE = /\.(mkv|mp4|avi|webm|m3u8|ts|mov)(\?.*)?$/i;
var DBG = { tmdb: '', pages: 0, ok: 0, lastErr: '' };

function debugStream(msg) {
  return [{ name: 'ISP DEBUG', title: msg, url: 'http://127.0.0.1/debug', quality: 'Unknown', provider: 'isp-local' }];
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/&amp;|&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '');
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
  var timeout = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, CONFIG.timeoutMs);
  });
  return Promise.race([req, timeout]);
}

function tmdbInfo(id, mediaType) {
  var key = (typeof TMDB_API_KEY !== 'undefined' && TMDB_API_KEY) || CONFIG.tmdbApiKey;
  if (!key) return Promise.reject(new Error('Set tmdbApiKey in CONFIG'));
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  return fetch('https://api.themoviedb.org/3/' + kind + '/' + id + '?api_key=' + key)
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || (!j.title && !j.name)) throw new Error('TMDB: ' + (j && j.status_message ? j.status_message : 'no data'));
      var titles = [];
      [j.title, j.name, j.original_title, j.original_name].forEach(function (t) {
        if (t && titles.indexOf(t) < 0) titles.push(t);
      });
      var year = String(j.release_date || j.first_air_date || '').slice(0, 4);
      DBG.tmdb = titles[0] + ' ' + year;
      return { titles: titles, year: year, isTv: kind === 'tv' };
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

function titleMatches(text, info) {
  var en = ' ' + norm(text) + ' ';
  for (var i = 0; i < info.titles.length; i++) {
    var tn = norm(info.titles[i]);
    if (tn && en.indexOf(' ' + tn + ' ') >= 0) {
      var y = en.match(/ (19\d\d|20\d\d) /);
      if (!info.isTv && info.year && y && y[1] !== info.year) return false;
      return true;
    }
  }
  return false;
}

function episodeMatches(text, mediaType, season, episode) {
  if (mediaType !== 'tv') return true;
  var s = parseInt(season, 10), e = parseInt(episode, 10);
  var a = new RegExp('s0*' + s + '[ ._-]*e0*' + e + '(?![0-9])', 'i');
  var b = new RegExp('(^|[^0-9])0*' + s + 'x0*' + e + '(?![0-9])', 'i');
  return a.test(text) || b.test(text);
}

function guessQuality(text) {
  var m = String(text).match(/2160p|4k|1080p|720p|480p/i);
  return m ? (m[0].toLowerCase() === '4k' ? '2160p' : m[0].toLowerCase()) : 'Unknown';
}

function crawl(server, info, mediaType, season, episode) {
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

  function handle(html, job) {
    var links = extractLinks(html, job.url);
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if (originOf(l.url) !== baseOrigin) continue;
      if (l.isVideo) {
        var label = l.text + ' ' + l.url;
        if ((job.inMatch || titleMatches(l.text, info) || titleMatches(decodeURIComponent_safe(l.url), info)) &&
            episodeMatches(label, mediaType, season, episode)) {
          found.push(l);
        }
      } else if (job.depth < CONFIG.maxDepth) {
        var matched = titleMatches(l.text, info) || titleMatches(decodeURIComponent_safe(l.url.split('?')[0].split('/').filter(Boolean).pop() || ''), info);
        var next = { url: l.url, depth: job.depth + 1, inMatch: job.inMatch || matched };
        var yearHit = !info.isTv && info.year && norm(l.text) === info.year;
        if (matched) queue.unshift(next); else if (yearHit) queue.unshift(next); else queue.push(next);
      }
    }
  }

  function step() {
    if (!queue.length || budget <= 0 || found.length >= 10) return Promise.resolve(found);
    var job = queue.shift();
    if (visited[job.url]) return step();
    visited[job.url] = true;
    budget--;
    return http(job.url).then(function (html) {
      if (html) handle(html, job);
      return step();
    });
  }
  return step();
}

function decodeURIComponent_safe(u) {
  try { return decodeURIComponent(u); } catch (e) { return u; }
}

function getStreams(tmdbId, mediaType, season, episode) {
  DBG = { tmdb: '', pages: 0, ok: 0, lastErr: '' };
  return tmdbInfo(tmdbId, mediaType).then(function (info) {
    var results = [], seen = {};
    var chain = Promise.resolve();
    CONFIG.servers.forEach(function (server) {
      chain = chain.then(function () {
        return crawl(server, info, mediaType, season, episode).then(function (hits) {
          hits.forEach(function (h) {
            if (seen[h.url]) return;
            seen[h.url] = true;
            var stream = {
              name: 'ISP - ' + server.name,
              title: h.text,
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
        return debugStream('Nothing found. TMDB: ' + DBG.tmdb + ' | server pages ok ' + DBG.ok + '/' + DBG.pages + (DBG.lastErr ? ' | last error: ' + DBG.lastErr : ''));
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
