'use strict';
// Server HTTP locale (solo 127.0.0.1): serve la webapp, gli endpoint dati e i file con le richieste Range.
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

// endpoint (stessi nomi del backend PHP, così app.js non cambia) -> funzione dell'API
const API_ROUTES = {
  '/routes.php': 'routes',
  '/routes-in-area.php': 'routesInArea',
  '/geojson.php': 'geojson',
  '/poi.php': 'poi',
  '/foto.php': 'foto',
  '/foto-file.php': 'fotoFile',
  '/voce-file.php': 'voceFile',
};

function sendJson(res, status, body, req) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req && req.method === 'HEAD' ? undefined : data);
}

function sendBuffer(req, res, data, mime) {
  res.writeHead(200, {
    'Content-Type': mime, 'Content-Length': data.length,
    'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function serveFile(req, res, file, mime, cache = 'no-cache') {
  let st;
  try { st = await fsp.stat(file); } catch { return sendJson(res, 404, { error: 'Non trovato' }, req); }
  if (!st.isFile()) return sendJson(res, 404, { error: 'Non trovato' }, req);

  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const headers = {
    'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': cache,
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (!mime.startsWith('audio/')) {
    headers['X-Content-Type-Options'] = 'nosniff';
  }

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    if (m[1] === '') start = Math.max(size - Number(m[2]), 0);          // bytes=-N (ultimi N byte)
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }

  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();

  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ctx: { status(): oggetto, api(): API o null, tilesDir(): string }
function createServer({ webRoot, ctx }) {
  const root = path.resolve(webRoot);
  const allowedHosts = new Set();

  async function handle(req, res) {
    // protegge dal "DNS rebinding": si accetta solo l'indirizzo locale
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Host non consentito' }, req);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Metodo non consentito' }, req);
    }

    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: 'Richiesta non valida' }, req); }
    if (pathname.includes('\0')) return sendJson(res, 400, { error: 'Richiesta non valida' }, req);

    if (pathname === '/api/status') return sendJson(res, 200, ctx.status(), req);

    const apiName = API_ROUTES[pathname];
    if (apiName) {
      const api = ctx.api();
      if (!api) return sendJson(res, 409, { error: 'Nessun database aperto', code: 'no-db' }, req);
      const out = await api[apiName](Object.fromEntries(url.searchParams));
      if (out.file) return serveFile(req, res, out.file.path, out.file.mime, 'private, max-age=86400');
      if (out.buffer) return sendBuffer(req, res, out.buffer.data, out.buffer.mime);
      return sendJson(res, out.status || 200, out.json, req);
    }

    if (pathname.startsWith('/tiles/')) {
      const name = path.basename(pathname);
      if (!/\.pmtiles$/i.test(name)) return sendJson(res, 404, { error: 'Non trovato' }, req);
      return serveFile(req, res, path.join(ctx.tilesDir(), name), 'application/octet-stream');
    }

    // file statici della webapp
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: 'Accesso negato' }, req);
    if (rel.split('/').some((part) => part.startsWith('.'))) return sendJson(res, 404, { error: 'Non trovato' }, req);
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return serveFile(req, res, file, mime);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('Errore nella richiesta', req.url, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Errore interno' }, req);
      else res.destroy();
    });
  });

  // Prova prima la porta preferita (così localStorage del browser resta lo stesso), poi una libera.
  server.listenLocal = (preferredPort = 0) => new Promise((resolve, reject) => {
    const attempt = (port) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && port !== 0) attempt(0);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const actual = server.address().port;
        allowedHosts.add(`127.0.0.1:${actual}`);
        allowedHosts.add(`localhost:${actual}`);
        resolve(actual);
      });
    };
    attempt(preferredPort);
  });

  return server;
}

module.exports = { createServer };
