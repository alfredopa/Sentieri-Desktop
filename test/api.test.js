'use strict';
// Prova endpoint, server e preparazione del database con un database di esempio.
// Si esegue con:  npm test   (richiede Node 22.13 o successivo, per node:sqlite)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const { prepareDatabase } = require('../src/dbprep');
const { createApi } = require('../src/api');
const { createServer } = require('../src/server');

const SCHEMA = `
CREATE TABLE Sentieri (id INTEGER PRIMARY KEY AUTOINCREMENT, Nome TEXT, Descrizione TEXT, DataOra TEXT, DataFine TEXT,
  Lunghezza REAL, TempoTot INTEGER, TempoInMov INTEGER, Dislivello REAL, Discesa REAL, MediaVel REAL, HrMed INTEGER, HrMax INTEGER,
  uuid TEXT, lastUpdate INTEGER);
CREATE TABLE Track (id INTEGER PRIMARY KEY AUTOINCREMENT, Trackid INTEGER, Lat REAL, Lon REAL, Ele REAL, Time TEXT, trackUuid TEXT,
  batteryPercent INTEGER, cadence INTEGER, assistLevel INTEGER, power INTEGER, heartRate INTEGER);
CREATE TABLE PoiDB (id INTEGER PRIMARY KEY AUTOINCREMENT, Trackid INTEGER, Lat REAL, Lon REAL, Ele REAL, NomePOI TEXT, DescrPOI TEXT,
  UriPath TEXT, Time TEXT, uuid TEXT, trackUuid TEXT, lastUpdate INTEGER);
CREATE TABLE FotoPoi (id INTEGER PRIMARY KEY AUTOINCREMENT, Trackid INTEGER, UriPath TEXT, NomeFoto TEXT, uuid TEXT, trackUuid TEXT, lastUpdate INTEGER);
`;

function fillDatabase(file) {
  const d = new DatabaseSync(file);
  d.exec(SCHEMA);
  d.prepare(`INSERT INTO Sentieri (Nome, Descrizione, DataOra, Lunghezza, TempoTot, TempoInMov, Dislivello, Discesa, MediaVel, HrMed, HrMax, uuid)
             VALUES ('Giro di prova', 'Descrizione', '2026-10-30T08:00:00Z', 54550, 28020, 25000, 820.4, 815, 7.0, 128, 171, 'u1')`).run();
  d.prepare(`INSERT INTO Sentieri (Nome, DataOra, uuid) VALUES ('Senza sensori', '2026-01-01T08:00:00Z', 'u2')`).run();

  const ins = d.prepare(`INSERT INTO Track (Trackid, Lat, Lon, Ele, Time, trackUuid, batteryPercent, assistLevel, power, heartRate)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 300; i++) {
    const ebike = i % 7 !== 0;
    ins.run(1, 39 + 0.0003 * i, 9 + 0.0004 * i, 100 + 30 * Math.sin(i / 20),
      `2026-10-30T08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, 'u1',
      ebike ? 100 - Math.floor(i / 10) : null, ebike ? Math.floor(i / 80) % 4 : null, ebike ? 100 + i : null, i > 20 ? 120 + (i % 30) : null);
  }
  for (let i = 0; i < 50; i++) {
    ins.run(2, 40 + 0.0003 * i, 12, 50, `2026-01-01T09:00:${String(i).padStart(2, '0')}Z`, 'u2', null, null, null, null);
  }

  const poi = d.prepare(`INSERT INTO PoiDB (Trackid, Lat, Lon, Ele, NomePOI, DescrPOI, UriPath, Time, uuid, trackUuid, lastUpdate)
                         VALUES (1, 39.01, 9.01, 110, ?, ?, ?, ?, ?, 'u1', 1)`);
  poi.run('Fontana', 'Acqua', 'AUD_prova.m4a', '2026-10-30 08:10:00.000', 'p1');
  poi.run('Senza audio', '', 'AUD_manca.m4a', '2026-10-30 08:20:00.000', 'p2');
  poi.run('Percorso strano', '', '../fuori.m4a', '2026-10-30 08:30:00.000', 'p3');

  const foto = d.prepare(`INSERT INTO FotoPoi (Trackid, UriPath, NomeFoto, uuid, trackUuid, lastUpdate) VALUES (1, '', ?, ?, 'u1', 1)`);
  foto.run('1761811200000.jpg', 'f1');
  foto.run('../segreto.txt', 'f2');       // tentativo di uscire dalla cartella
  d.close();
}

const ctx = {};
const get = (p, headers = {}) => fetch(ctx.base + p, { headers });

test.before(async () => {
  ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentieri-test-'));
  const t = ctx.tmp;
  for (const d of ['web', 'foto', 'voce', 'tiles']) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, 'web', 'index.html'), '<h1>Sentieri</h1>');
  fs.writeFileSync(path.join(t, 'web', '.nascosto'), 'x');
  fs.writeFileSync(path.join(t, 'segreto.txt'), 'dati riservati');
  fs.writeFileSync(path.join(t, 'foto', '1761811200000.jpg'), Buffer.from('FOTO-ORIGINALE'));
  ctx.voce = Buffer.alloc(5000, 7);
  fs.writeFileSync(path.join(t, 'voce', 'AUD_prova.m4a'), ctx.voce);
  fs.writeFileSync(path.join(t, 'tiles', 'prova.pmtiles'), Buffer.alloc(1000, 1));

  const src = path.join(t, 'sentieri.db');
  fillDatabase(src);
  ctx.progress = [];
  const work = prepareDatabase({ src, workDir: path.join(t, 'work'), progress: (m) => ctx.progress.push(m) });
  ctx.db = new DatabaseSync(work, { readOnly: true });
  ctx.src = src;

  ctx.apiOn = true;
  const api = createApi({
    db: ctx.db,
    fotoDir: () => path.join(t, 'foto'),
    voceDir: () => path.join(t, 'voce'),
    makeThumb: async () => Buffer.from('MINIATURA'),
  });
  ctx.server = createServer({
    webRoot: path.join(t, 'web'),
    ctx: { status: () => ({ state: 'ready', message: '', dbName: 'sentieri.db' }), api: () => (ctx.apiOn ? api : null), tilesDir: () => path.join(t, 'tiles') },
  });
  ctx.port = await ctx.server.listenLocal(0);
  ctx.base = `http://127.0.0.1:${ctx.port}`;
});

test.after(() => {
  ctx.server.close();
  ctx.db.close();
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
});

test('la preparazione crea gli indici e il server resta in ascolto solo in locale', async () => {
  assert.ok(ctx.progress.some((m) => m.includes('indici')));
  assert.equal(ctx.server.address().address, '127.0.0.1');
  const idx = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_desk%'").all();
  assert.equal(idx.length, 4);
});

test('senza database gli endpoint rispondono 409', async () => {
  ctx.apiOn = false;
  const r = await get('/routes.php');
  ctx.apiOn = true;
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'no-db');
});

test('routes.php: campi convertiti come nel backend PHP', async () => {
  const rows = await (await get('/routes.php')).json();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Giro di prova');          // più recente per primo
  assert.deepEqual(rows[0], {
    id: '1', name: 'Giro di prova', description: 'Descrizione', date: '2026-10-30T08:00:00Z',
    distance_km: 54.55, duration_min: 467, duration_moving_min: 417,
    elevation_gain_m: 820, elevation_loss_m: 815, avg_speed_kmh: 7, hr_avg: 128, hr_max: 171,
  });
  assert.equal(rows[1].distance_km, null);
  const found = await (await get('/routes.php?q=SENZA')).json();
  assert.deepEqual(found.map((r) => r.id), ['2']);
});

test('routes-in-area.php: filtra per rettangolo e valida i parametri', async () => {
  const q = 'minLon=8.9&maxLon=9.2&minLat=38.9&maxLat=39.2';
  const rows = await (await get(`/routes-in-area.php?${q}`)).json();
  assert.deepEqual(rows.map((r) => r.id), ['1']);
  assert.equal((await get('/routes-in-area.php?minLon=1')).status, 400);
});

test('geojson.php: geometria e serie dei sensori allineate ai punti', async () => {
  const f = await (await get('/geojson.php?id=1')).json();
  assert.equal(f.geometry.coordinates.length, 300);
  assert.equal(f.properties.name, 'Giro di prova');
  assert.deepEqual(Object.keys(f.metrics).sort(), ['assist', 'battery', 'hr', 'power']);
  for (const serie of Object.values(f.metrics)) assert.equal(serie.length, 300);
  assert.equal(f.metrics.battery[0], null);              // i = 0 senza e-bike
  assert.equal(f.metrics.battery[1], 100);
  assert.equal(f.properties.metrics, undefined);          // niente dati pesanti dentro "properties"

  const g = await (await get('/geojson.php?id=2')).json();
  assert.equal('metrics' in g, false);
  assert.equal((await get('/geojson.php?id=99')).status, 404);
  assert.equal((await get('/geojson.php?id=abc')).status, 400);
});

test('poi.php: indica se c’è l’audio senza mostrare nomi di file', async () => {
  const poi = await (await get('/poi.php?id=1')).json();
  assert.deepEqual(poi.map((p) => [p.name, p.audio]), [['Fontana', true], ['Senza audio', false], ['Percorso strano', false]]);
  assert.ok(!JSON.stringify(poi).includes('m4a'));
});

test('foto.php, foto-file.php: elenco, originale, miniatura, percorsi esterni bloccati', async () => {
  const list = await (await get('/foto.php?id=1')).json();
  assert.equal(list.find((f) => f.name === '1761811200000.jpg').taken_ms, 1761811200000);

  const orig = await get('/foto-file.php?id=1');
  assert.equal(orig.status, 200);
  assert.equal(orig.headers.get('content-type'), 'image/jpeg');
  assert.equal(await orig.text(), 'FOTO-ORIGINALE');

  assert.equal(await (await get('/foto-file.php?id=1&thumb=1')).text(), 'MINIATURA');
  assert.equal((await get('/foto-file.php?id=2')).status, 404);   // "../segreto.txt" resta dentro la cartella foto
  assert.equal((await get('/foto-file.php?id=1%27')).status, 400);
});

test('voce-file.php: file intero, Range, fuori intervallo, audio mancante', async () => {
  const full = await get('/voce-file.php?id=1');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal((await full.arrayBuffer()).byteLength, 5000);

  const part = await get('/voce-file.php?id=1', { Range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/5000');
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  assert.equal((await get('/voce-file.php?id=1', { Range: 'bytes=99999-' })).status, 416);
  assert.equal((await get('/voce-file.php?id=2')).status, 404);
  assert.equal((await get('/voce-file.php?id=3')).status, 404);
});

test('mappe PMTiles: richieste Range', async () => {
  const part = await get('/tiles/prova.pmtiles', { Range: 'bytes=0-126' });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 127);
  assert.equal((await get('/tiles/segreto.txt')).status, 404);
  assert.equal((await get('/tiles/mancante.pmtiles')).status, 404);
});

test('file statici: solo dentro la cartella web, niente file nascosti', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Sentieri/);
  assert.equal((await get('/..%2fsegreto.txt')).status, 403);      // barra codificata: esce dalla cartella web
  assert.equal((await get('/%2e%2e/segreto.txt')).status, 404);    // l'URL viene normalizzato a /segreto.txt, che non esiste in web
  assert.equal((await get('/.nascosto')).status, 404);
  assert.equal((await get('/nonesiste.js')).status, 404);
});

test('richieste con Host diverso o metodi di scrittura vengono rifiutate', async () => {
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ctx.port, path: '/routes.php', headers: { Host: 'sito-malevolo.example' } },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await fetch(ctx.base + '/routes.php', { method: 'POST' })).status, 405);
});

test('preparazione: riusa la copia se il file non è cambiato, rifiuta database non validi', () => {
  const messages = [];
  prepareDatabase({ src: ctx.src, workDir: path.join(ctx.tmp, 'work'), progress: (m) => messages.push(m) });
  assert.ok(!messages.some((m) => m.startsWith('Copia')), 'non deve copiare di nuovo');

  const vuoto = path.join(ctx.tmp, 'vuoto.db');
  const d = new DatabaseSync(vuoto);
  d.exec('CREATE TABLE altro (a)');
  d.close();
  assert.throws(() => prepareDatabase({ src: vuoto, workDir: path.join(ctx.tmp, 'work2') }), /mancano le tabelle/);
});

test('preparazione: include i dati ancora nel file WAL (copia da telefono)', () => {
  const src = path.join(ctx.tmp, 'wal.db');
  const live = new DatabaseSync(src);
  live.exec('PRAGMA journal_mode = WAL');
  live.exec(SCHEMA);
  live.exec("INSERT INTO Sentieri (Nome, uuid) VALUES ('Solo nel WAL', 'w1')");
  assert.ok(fs.existsSync(src + '-wal'), 'il WAL deve esistere accanto al file');

  const work = prepareDatabase({ src, workDir: path.join(ctx.tmp, 'work-wal') });
  live.close();
  const d = new DatabaseSync(work, { readOnly: true });
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM Sentieri').get().n, 1);
  d.close();
});
