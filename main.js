'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session, protocol, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { Bonjour } = require('bonjour-service');

const { createSettings } = require('./src/settings');
const { createServer } = require('./src/server');
const { createApi } = require('./src/api');

const PREFERRED_PORT = 38765;
const DB_EXT = /\.(db|sqlite|sqlite3)$/i;

let win = null;
let server = null;
let port = 0;
let settings = null;
let bonjour = null;
let activeMbtilesFilePath = null;

let db = null;
let api = null;
let worker = null;
let openToken = 0;
let currentSrc = null;
let status = { state: 'none', message: '', dbName: '' };

// ---- Discovery mDNS (Bonjour) e verifica HTTP ----
function getBonjour() {
  if (!bonjour) bonjour = new Bonjour();
  return bonjour;
}

function cercaDispositivoAndroid(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    console.log('[Sync] Ricerca mDNS del dispositivo Sentieri in corso...');
    const instance = getBonjour();
    const browser = instance.find({ type: 'sentieri-sync', protocol: 'tcp' });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { browser.stop(); } catch {}
      reject(new Error('Smartphone non trovato nella rete Wi-Fi entro il timeout. Assicurati che lo smartphone sia connesso al Wi-Fi e che la schermata "Sincronizza PC" sia aperta.'));
    }, timeoutMs);

    browser.on('up', (service) => {
      if (settled) return;
      console.log('[Sync] Dispositivo mDNS trovato:', service.name, service.addresses, service.port);

      const addresses = Array.isArray(service.addresses) ? service.addresses : [];
      const ipv4 = addresses.find((addr) => net.isIPv4(addr) && !addr.startsWith('127.'));

      if (ipv4) {
        settled = true;
        clearTimeout(timer);
        try { browser.stop(); } catch {}

        resolve({
          name: service.name,
          ip: ipv4,
          port: service.port,
          baseUrl: `http://${ipv4}:${service.port}`,
        });
      }
    });
  });
}

async function verificaConnessioneDispositivo(baseUrl, healthPath = '/api/v1/info', timeoutMs = 3000) {
  const targetUrl = `${baseUrl}${healthPath}`;
  const res = await fetch(targetUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Il dispositivo ha risposto con stato HTTP ${res.status}`);
  }
  return res.json().catch(() => ({ status: 'ok' }));
}

async function scansionaReteSubnet(healthPath = '/api/v1/info', port = 8080) {
  const interfaces = os.networkInterfaces();
  const localIps = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIps.push(iface.address);
      }
    }
  }

  if (localIps.length === 0) return null;

  for (const localIp of localIps) {
    const subnetPrefix = localIp.substring(0, localIp.lastIndexOf('.'));
    console.log(`[Sync] Scansione veloce subnet IP: ${subnetPrefix}.1-254 sulla porta ${port}...`);

    const probes = [];
    for (let i = 1; i <= 254; i++) {
      const targetIp = `${subnetPrefix}.${i}`;
      if (targetIp === localIp) continue;
      const url = `http://${targetIp}:${port}${healthPath}`;

      probes.push(
        fetch(url, { method: 'GET', signal: AbortSignal.timeout(400) })
          .then(async (res) => {
            if (res.ok) {
              const data = await res.json().catch(() => null);
              if (data && data.app === 'Sentieri') {
                console.log(`[Sync] Smartphone trovato via scansione IP diretta: http://${targetIp}:${port}`);
                return { name: 'Smartphone Android', ip: targetIp, port, baseUrl: `http://${targetIp}:${port}` };
              }
            }
            return null;
          })
          .catch(() => null)
      );
    }

    const results = await Promise.all(probes);
    const found = results.find((r) => r !== null);
    if (found) return found;
  }
  return null;
}

async function trovaEVerificaAndroid(timeoutMs = 5000, healthPath = '/api/v1/info') {
  try {
    const devScan = await scansionaReteSubnet(healthPath, 8080);
    if (devScan) {
      const info = await verificaConnessioneDispositivo(devScan.baseUrl, healthPath);
      return { ...devScan, info };
    }
  } catch (errScan) {
    console.warn('[Sync] Scansione IP veloce fallita, proseguo con mDNS:', errScan.message);
  }

  const dispositivo = await cercaDispositivoAndroid(timeoutMs);
  const info = await verificaConnessioneDispositivo(dispositivo.baseUrl, healthPath);
  return { ...dispositivo, info };
}

function chiudiBonjour() {
  if (bonjour) {
    try { bonjour.destroy(); } catch { /* già chiuso */ }
    bonjour = null;
  }
}

// ---- Salvataggio dei dati ricevuti da Android nel DB SQLite locale ----
function salvaDatiAndroidNelDb(sentieriArray) {
  const dbPathToSave = currentSrc || path.join(app.getPath('userData'), 'sentieri-local.db');
  currentSrc = dbPathToSave;

  console.log(`[Sync] Salvataggio di ${sentieriArray.length} sentieri nel database: ${dbPathToSave}`);

  // Apriamo una connessione dedicata in SCRITTURA (readOnly: false)
  const writeDb = new DatabaseSync(dbPathToSave, { readOnly: false });

  // 1. Assicura la presenza delle tabelle
  writeDb.exec(`
    CREATE TABLE IF NOT EXISTS Sentieri (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      Nome TEXT, Descrizione TEXT, Lunghezza REAL, Dislivello INTEGER, Discesa INTEGER,
      HrMed INTEGER, HrMax INTEGER, DataOra TEXT, TempMedia REAL, TempMax REAL, TempMin REAL,
      DataFine TEXT, TempoTot REAL, TempoInMov REAL, MediaVel REAL, uuid TEXT, lastUpdate INTEGER
    );
    CREATE TABLE IF NOT EXISTS Track (
      Id INTEGER PRIMARY KEY AUTOINCREMENT, Trackid INTEGER, Lat REAL, Lon REAL, Ele REAL, Time TEXT,
      trackUuid TEXT, batteryPercent INTEGER, cadence INTEGER, assistLevel INTEGER, power INTEGER, heartRate INTEGER
    );
    CREATE TABLE IF NOT EXISTS PoiDB (
      id INTEGER PRIMARY KEY AUTOINCREMENT, Trackid INTEGER, trackUuid TEXT, Lat REAL, Lon REAL, Ele REAL,
      NomePOI TEXT, DescrPOI TEXT, Time TEXT, UriPath TEXT, uuid TEXT, lastUpdate INTEGER
    );
    CREATE TABLE IF NOT EXISTS FotoPoi (
      id INTEGER PRIMARY KEY AUTOINCREMENT, Trackid INTEGER, trackUuid TEXT, NomeFoto TEXT, UriPath TEXT, uuid TEXT, lastUpdate INTEGER
    );
  `);

  // 2. Assicura la presenza delle colonne uuid, trackUuid e lastUpdate nei file di DB pre-esistenti
  const sentieriCols = new Set(writeDb.prepare('PRAGMA table_info("Sentieri")').all().map(c => c.name.toLowerCase()));
  if (!sentieriCols.has('uuid')) try { writeDb.exec('ALTER TABLE Sentieri ADD COLUMN uuid TEXT'); } catch {}
  if (!sentieriCols.has('lastupdate')) try { writeDb.exec('ALTER TABLE Sentieri ADD COLUMN lastUpdate INTEGER'); } catch {}

  const trackCols = new Set(writeDb.prepare('PRAGMA table_info("Track")').all().map(c => c.name.toLowerCase()));
  if (!trackCols.has('trackuuid')) try { writeDb.exec('ALTER TABLE Track ADD COLUMN trackUuid TEXT'); } catch {}

  const poiCols = new Set(writeDb.prepare('PRAGMA table_info("PoiDB")').all().map(c => c.name.toLowerCase()));
  if (!poiCols.has('trackuuid')) try { writeDb.exec('ALTER TABLE PoiDB ADD COLUMN trackUuid TEXT'); } catch {}
  if (!poiCols.has('uuid')) try { writeDb.exec('ALTER TABLE PoiDB ADD COLUMN uuid TEXT'); } catch {}
  if (!poiCols.has('lastupdate')) try { writeDb.exec('ALTER TABLE PoiDB ADD COLUMN lastUpdate INTEGER'); } catch {}

  const fotoCols = new Set(writeDb.prepare('PRAGMA table_info("FotoPoi")').all().map(c => c.name.toLowerCase()));
  if (!fotoCols.has('trackuuid')) try { writeDb.exec('ALTER TABLE FotoPoi ADD COLUMN trackUuid TEXT'); } catch {}
  if (!fotoCols.has('uuid')) try { writeDb.exec('ALTER TABLE FotoPoi ADD COLUMN uuid TEXT'); } catch {}
  if (!fotoCols.has('lastupdate')) try { writeDb.exec('ALTER TABLE FotoPoi ADD COLUMN lastUpdate INTEGER'); } catch {}

  // 3. Crea gli indici
  try { writeDb.exec('CREATE INDEX IF NOT EXISTS idx_sentieri_uuid ON Sentieri(uuid)'); } catch {}
  try { writeDb.exec('CREATE INDEX IF NOT EXISTS idx_track_uuid ON Track(trackUuid)'); } catch {}
  try { writeDb.exec('CREATE INDEX IF NOT EXISTS idx_poi_uuid ON PoiDB(uuid)'); } catch {}
  try { writeDb.exec('CREATE INDEX IF NOT EXISTS idx_foto_uuid ON FotoPoi(uuid)'); } catch {}

  const stmtSelect = writeDb.prepare(`SELECT id FROM Sentieri WHERE uuid = ?`);
  const stmtUpdate = writeDb.prepare(`
    UPDATE Sentieri SET
      Nome=?, Descrizione=?, Lunghezza=?, Dislivello=?, Discesa=?, HrMed=?, HrMax=?,
      DataOra=?, TempMedia=?, TempMax=?, TempMin=?, DataFine=?, TempoTot=?, TempoInMov=?,
      MediaVel=?, lastUpdate=?
    WHERE uuid = ?
  `);
  const stmtInsert = writeDb.prepare(`
    INSERT INTO Sentieri (Nome, Descrizione, Lunghezza, Dislivello, Discesa, HrMed, HrMax, DataOra, TempMedia, TempMax, TempMin, DataFine, TempoTot, TempoInMov, MediaVel, uuid, lastUpdate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const trackLatCol = trackCols.has('latit') ? 'Latit' : 'Lat';
  const trackLonCol = trackCols.has('longit') ? 'Longit' : 'Lon';

  const stmtDeletePunti = writeDb.prepare(`DELETE FROM Track WHERE trackUuid = ?`);
  const stmtInsertPunto = writeDb.prepare(`
    INSERT INTO Track (Trackid, "${trackLatCol}", "${trackLonCol}", Ele, Time, trackUuid, batteryPercent, cadence, assistLevel, power, heartRate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const poiLatCol = poiCols.has('latit') ? 'Latit' : 'Lat';
  const poiLonCol = poiCols.has('longit') ? 'Longit' : 'Lon';

  const stmtDeletePois = writeDb.prepare(`DELETE FROM PoiDB WHERE trackUuid = ?`);
  const stmtSelectPoi = writeDb.prepare(`SELECT id FROM PoiDB WHERE uuid = ?`);
  const stmtUpdatePoi = writeDb.prepare(`
    UPDATE PoiDB SET Trackid=?, trackUuid=?, "${poiLatCol}"=?, "${poiLonCol}"=?, Ele=?, NomePOI=?, DescrPOI=?, Time=?, UriPath=?, lastUpdate=? WHERE uuid=?
  `);
  const stmtInsertPoi = writeDb.prepare(`
    INSERT INTO PoiDB (Trackid, trackUuid, "${poiLatCol}", "${poiLonCol}", Ele, NomePOI, DescrPOI, Time, UriPath, uuid, lastUpdate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtDeleteFotos = writeDb.prepare(`DELETE FROM FotoPoi WHERE trackUuid = ?`);
  const stmtSelectFoto = writeDb.prepare(`SELECT id FROM FotoPoi WHERE uuid = ?`);
  const stmtUpdateFoto = writeDb.prepare(`
    UPDATE FotoPoi SET Trackid=?, trackUuid=?, NomeFoto=?, UriPath=?, lastUpdate=? WHERE uuid=?
  `);
  const stmtInsertFoto = writeDb.prepare(`
    INSERT INTO FotoPoi (Trackid, trackUuid, NomeFoto, UriPath, uuid, lastUpdate)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let countSentieri = 0;
  let countPunti = 0;
  let countPois = 0;
  let countFotos = 0;

  writeDb.exec('BEGIN TRANSACTION');
  try {
    for (const s of sentieriArray) {
      const uuid = s.uuid || s.uuidStr || String(s.id || Date.now());
      const existing = stmtSelect.get(uuid);

      let trackId = 0;
      if (existing) {
        stmtUpdate.run(
          s.Nome || s.nome || '',
          s.Descrizione || s.descrizione || '',
          s.Lunghezza || s.lunghezza || 0,
          s.Dislivello || s.dislivello || 0,
          s.Discesa || s.discesa || 0,
          s.HrMed || s.hrMed || 0,
          s.HrMax || s.hrMax || 0,
          s.DataOra || s.dataOra || '',
          s.TempMedia || s.tempMedia || 0,
          s.TempMax || s.tempMax || 0,
          s.TempMin || s.tempMin || 0,
          s.DataFine || s.dataFine || '',
          s.TempoTot || s.tempoTot || 0,
          s.TempoInMov || s.tempoInMov || 0,
          s.MediaVel || s.mediaVel || 0,
          s.lastUpdate || Date.now(),
          uuid
        );
        trackId = existing.id;
      } else {
        const info = stmtInsert.run(
          s.Nome || s.nome || '',
          s.Descrizione || s.descrizione || '',
          s.Lunghezza || s.lunghezza || 0,
          s.Dislivello || s.dislivello || 0,
          s.Discesa || s.discesa || 0,
          s.HrMed || s.hrMed || 0,
          s.HrMax || s.hrMax || 0,
          s.DataOra || s.dataOra || '',
          s.TempMedia || s.tempMedia || 0,
          s.TempMax || s.tempMax || 0,
          s.TempMin || s.tempMin || 0,
          s.DataFine || s.dataFine || '',
          s.TempoTot || s.tempoTot || 0,
          s.TempoInMov || s.tempoInMov || 0,
          s.MediaVel || s.mediaVel || 0,
          uuid,
          s.lastUpdate || Date.now()
        );
        trackId = Number(info.lastInsertRowid || 0);
      }
      countSentieri++;

      // 1. Punti GPS (Track)
      if (Array.isArray(s.punti) && s.punti.length > 0) {
        stmtDeletePunti.run(uuid);
        for (const p of s.punti) {
          stmtInsertPunto.run(
            trackId,
            p.Lat || p.lat || 0,
            p.Lon || p.lon || 0,
            p.Ele || p.ele || 0,
            p.Time || p.time || '',
            uuid,
            p.batteryPercent ?? null,
            p.cadence ?? null,
            p.assistLevel ?? null,
            p.power ?? null,
            p.heartRate ?? null
          );
          countPunti++;
        }
      }

      // 2. Waypoint / POI (PoiDB)
      if (Array.isArray(s.pois) && s.pois.length > 0) {
        for (const poi of s.pois) {
          const poiUuid = poi.uuid || poi.uuidStr || String(Date.now() + Math.random());
          let cleanUriPath = poi.UriPath || poi.uriPath || '';
          if (cleanUriPath) {
            try { cleanUriPath = decodeURIComponent(cleanUriPath); } catch {}
            cleanUriPath = cleanUriPath.split('?')[0].split('#')[0].split('/').pop() || '';
          }

          const existingPoi = stmtSelectPoi.get(poiUuid);
          if (existingPoi) {
            stmtUpdatePoi.run(
              trackId, uuid,
              poi.Lat || poi.lat || 0, poi.Lon || poi.lon || 0, poi.Ele || poi.ele || 0,
              poi.NomePOI || poi.nome || '', poi.DescrPOI || poi.descr || '',
              poi.Time || poi.time || '', cleanUriPath,
              poi.lastUpdate || Date.now(),
              poiUuid
            );
          } else {
            stmtInsertPoi.run(
              trackId, uuid,
              poi.Lat || poi.lat || 0, poi.Lon || poi.lon || 0, poi.Ele || poi.ele || 0,
              poi.NomePOI || poi.nome || '', poi.DescrPOI || poi.descr || '',
              poi.Time || poi.time || '', cleanUriPath,
              poiUuid, poi.lastUpdate || Date.now()
            );
          }
          countPois++;
        }
      }

      // 3. Foto (FotoPoi)
      if (Array.isArray(s.fotos) && s.fotos.length > 0) {
        for (const foto of s.fotos) {
          const fotoUuid = foto.uuid || foto.uuidStr || String(Date.now() + Math.random());
          const existingFoto = stmtSelectFoto.get(fotoUuid);
          if (existingFoto) {
            stmtUpdateFoto.run(
              trackId, uuid,
              foto.NomeFoto || foto.nomeFoto || '', foto.UriPath || foto.uriPath || '',
              foto.lastUpdate || Date.now(),
              fotoUuid
            );
          } else {
            stmtInsertFoto.run(
              trackId, uuid,
              foto.NomeFoto || foto.nomeFoto || '', foto.UriPath || foto.uriPath || '',
              fotoUuid, foto.lastUpdate || Date.now()
            );
          }
          countFotos++;
        }
      }
    }
    writeDb.exec('COMMIT');
    console.log(`[Sync] Salvataggio completato! Sentieri: ${countSentieri}, Punti: ${countPunti}, POI: ${countPois}, Foto: ${countFotos}`);
  } catch (err) {
    writeDb.exec('ROLLBACK');
    console.error('[Sync] Errore salvataggio DB:', err);
    throw err;
  } finally {
    try { writeDb.close(); } catch {}
  }

  // Ricarica il database nell'app desktop per aggiornare l'interfaccia utente
  openDatabase(dbPathToSave);

  return { countSentieri, countPunti, countPois, countFotos };
}

// ---- miniature delle foto (sharp è facoltativo: senza, si usano le foto originali) ----
let sharp = null;
try { sharp = require('sharp'); sharp.cache(false); } catch (err) { console.warn('sharp non disponibile:', err.message); }
async function makeThumb(file) {
  if (!sharp) return null;
  try {
    return await sharp(file).rotate()
      .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 }).toBuffer();
  } catch { return null; }
}

// ---- cartelle: gestite automaticamente accanto al file del database ----
const nextToDb = (name) => (currentSrc ? path.join(path.dirname(currentSrc), name) : path.join(app.getPath('userData'), name));
const fotoDir = () => nextToDb('Foto');
const voceDir = () => nextToDb('VoceWaypoint');
const tilesDir = () => settings.get('tilesDir') || nextToDb('tiles') || path.join(app.getPath('userData'), 'tiles');

function setStatus(next) {
  status = next;
  if (win && !win.isDestroyed()) {
    win.setTitle(next.dbName ? `Sentieri — ${next.dbName}` : 'Sentieri');
  }
}

function closeDatabase() {
  openToken++;
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  api = null;
  if (db) { try { db.close(); } catch { /* già chiuso */ } db = null; }
}

function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return buf.toString('latin1', 0, 15) === 'SQLite format 3';
  } catch { return false; }
}

function openDatabase(src) {
  closeDatabase();
  const token = openToken;
  currentSrc = src;
  const dbName = path.basename(src);
  setStatus({ state: 'preparing', message: 'Preparazione del database…', dbName });

  const w = new Worker(path.join(__dirname, 'src', 'dbprep-worker.js'), {
    workerData: { src, workDir: path.join(app.getPath('userData'), 'work') },
  });
  worker = w;

  const fail = (message) => {
    if (token !== openToken) return;
    api = null;
    setStatus({ state: 'error', message, dbName: '' });
  };

  w.on('message', (m) => {
    if (token !== openToken) return;
    if (m.type === 'progress') setStatus({ state: 'preparing', message: m.message, dbName });
    else if (m.type === 'error') fail(m.message);
    else if (m.type === 'done') {
      try {
        db = new DatabaseSync(m.work, { readOnly: true });
        api = createApi({ db, fotoDir, voceDir, makeThumb });
        settings.set('lastDb', src);
        setStatus({ state: 'ready', message: '', dbName });
      } catch (err) {
        fail(`Impossibile aprire il database: ${err.message}`);
      }
    }
  });
  w.on('error', (err) => fail(`Errore nella preparazione del database: ${err.message}`));
}

// ---- dialoghi ----
async function askOpenDb() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Apri il database di Sentieri',
    properties: ['openFile'],
    filters: [{ name: 'Database SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'Tutti i file', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return openDatabasePath(r.filePaths[0]);
}

function openDatabasePath(file) {
  if (typeof file !== 'string' || !fs.existsSync(file)) return { error: 'File non trovato.' };
  if (!isSqliteFile(file)) return { error: 'Il file scelto non è un database SQLite.' };
  openDatabase(file);
  return { ok: true };
}

async function chooseFolder(settingKey, title) {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return;
  settings.set(settingKey, r.filePaths[0]);
  if (win) win.webContents.reloadIgnoringCache();
}

async function loadLocalGpx() {
  const targetWin = win || BrowserWindow.getAllWindows()[0];
  if (!targetWin) return;

  const result = await dialog.showOpenDialog(targetWin, {
    title: 'Seleziona una traccia GPX',
    filters: [{ name: 'Traccia GPX', extensions: ['gpx', 'xml'] }],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return;
  const filePath = result.filePaths[0];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fileName = path.basename(filePath);
    console.log(`[GPX] Traccia letta con successo da ${filePath} (${content.length} byte)`);

    if (targetWin.webContents) {
      targetWin.webContents.send('gpx:load-data', { fileName, content });
    }
  } catch (err) {
    console.error('[GPX] Errore lettura file GPX:', err.message);
  }
}

async function loadLocalMbtiles() {
  const targetWin = win || BrowserWindow.getAllWindows()[0];
  if (!targetWin) return;

  const result = await dialog.showOpenDialog(targetWin, {
    title: 'Seleziona una mappa MBTiles',
    filters: [{ name: 'MBTiles', extensions: ['mbtiles', 'sqlite', 'db'] }],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return;
  const filePath = result.filePaths[0];

  activeMbtilesFilePath = filePath;
  console.log(`[MBTiles] Mappa attiva impostata su: ${filePath}`);

  if (targetWin.webContents) {
    targetWin.webContents.send('mbtiles:load-file', filePath);
    targetWin.webContents.send('mbtiles:load', filePath);
  }
}


function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Informazioni su Sentieri',
    message: `Sentieri ${app.getVersion()}`,
    detail: [
      'Visualizza i percorsi del file SQLite scaricato dall’app Android.',
      '',
      `Database: ${currentSrc || '—'}`,
      `Cartella foto: ${fotoDir() || '—'}`,
      `Cartella audio: ${voceDir() || '—'}`,
      `Cartella mappe: ${tilesDir()}`,
      '',
      `Electron ${process.versions.electron} · SQLite ${process.versions.sqlite ?? ''}`.trim(),
    ].join('\n'),
  });
}

function openMapDownloadModal() {
  const targetWin = win || BrowserWindow.getAllWindows()[0];
  if (targetWin && targetWin.webContents) {
    targetWin.webContents.send('map-download:open');
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Apri database…', accelerator: 'CmdOrCtrl+O', click: () => askOpenDb() },
        { type: 'separator' },
        { label: 'Apri traccia GPX…', accelerator: 'CmdOrCtrl+G', click: () => loadLocalGpx() },
        { type: 'separator' },
        { label: 'Cartella mappe (MbTiles)…', click: () => chooseFolder('tilesDir', 'Cartella con i file .mbtiles') },
        { label: 'Apre mappa (MbTiles)…', click: () => loadLocalMbtiles() },
        { label: 'Download Mappe dal Server…', click: () => openMapDownloadModal() },
        { type: 'separator' },
        { label: 'Esci', role: 'quit' },
      ],
    },
    {
      label: 'Visualizza',
      submenu: [
        { label: 'Ricarica', role: 'reload' },
        { label: 'Schermo intero', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Zoom normale', role: 'resetZoom' },
        { label: 'Ingrandisci', role: 'zoomIn' },
        { label: 'Riduci', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Strumenti per sviluppatori', role: 'toggleDevTools' },
      ],
    },
    { label: '?', submenu: [{ label: 'Informazioni su Sentieri…', click: showAbout }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#141d19', show: false, title: 'Sentieri',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });

  const origin = `http://127.0.0.1:${port}/`;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.loadURL(origin);
  setStatus(status);
}

function dbFromArgv(argv) {
  return argv.slice(1).find((a) => DB_EXT.test(a) && fs.existsSync(a));
}

const mbtilesCache = new Map();
function getMbtilesDb(targetPath) {
  if (!targetPath) return null;
  let fullPath = targetPath;
  if (!path.isAbsolute(fullPath)) {
    fullPath = path.join(tilesDir(), targetPath);
  }
  console.log('Cerco file MBTiles in:', fullPath);
  if (mbtilesCache.has(fullPath)) return mbtilesCache.get(fullPath);
  if (!fs.existsSync(fullPath)) {
    console.error('FILE NON TROVATO:', fullPath);
    return null;
  }
  try {
    const mdb = new DatabaseSync(fullPath, { readOnly: true });
    mbtilesCache.set(fullPath, mdb);
    return mdb;
  } catch (err) {
    console.error('ERRORE APERTURA SQLITE:', err.message);
    return null;
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mbtiles',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    const file = dbFromArgv(argv);
    if (file) openDatabasePath(file);
  });

  app.whenReady().then(async () => {
    settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));

    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setUserAgent(`${session.defaultSession.getUserAgent()} SentieriDesktop/${app.getVersion()}`);
    app.on('web-contents-created', (_e, contents) => contents.on('will-attach-webview', (ev) => ev.preventDefault()));

    // Handler IPC esistenti
    ipcMain.handle('open-db-dialog', () => askOpenDb());
    ipcMain.handle('open-db-path', (_e, file) => openDatabasePath(file));

    // ---- Gestione Token Cifrato NAS e Download Mappe ----
    function saveNasToken(token) {
      if (!token) {
        settings.set('nasTokenEncrypted', null);
        settings.set('nasToken', null);
        return;
      }
      try {
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
          const encrypted = safeStorage.encryptString(token);
          settings.set('nasTokenEncrypted', encrypted.toString('base64'));
          settings.set('nasToken', null);
        } else {
          settings.set('nasToken', token);
        }
      } catch (err) {
        console.error('[NAS] Errore salvataggio token cifrato:', err.message);
        settings.set('nasToken', token);
      }
    }

    function getNasToken() {
      const encBase64 = settings.get('nasTokenEncrypted');
      if (encBase64 && safeStorage && safeStorage.isEncryptionAvailable()) {
        try {
          const buffer = Buffer.from(encBase64, 'base64');
          return safeStorage.decryptString(buffer);
        } catch (err) {
          console.error('[NAS] Errore decifratura token safeStorage:', err.message);
        }
      }
      return settings.get('nasToken', '');
    }

    ipcMain.handle('nas-get-token', () => getNasToken());
    ipcMain.handle('nas-save-token', (_e, token) => {
      saveNasToken(token);
      return { ok: true };
    });

    ipcMain.handle('nas-list-maps', async () => {
      try {
        const token = getNasToken();
        if (!token) throw new Error('Token NAS mancante. Inserisci e salva il token prima di richiedere l’elenco delle mappe.');

        const nasUrl = 'https://sentieriap.duckdns.org/files/api/list?path=Cloud';
        console.log('[NAS] Richiesta lista mappe a:', nasUrl);

        const res = await fetch(nasUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });

        if (!res.ok) {
          if (res.status === 401) throw new Error('Autenticazione fallita (401): verifica il token inserito.');
          throw new Error(`Errore HTTP server NAS: ${res.status}`);
        }

        const data = await res.json();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        const files = entries
          .filter(e => !e.isDir && e.name && /\.(mbtiles|map|zip|sqlite|db)$/i.test(e.name))
          .map(e => ({
            name: e.name,
            size: e.size || 0,
            sizeMb: e.size ? (e.size / (1024 * 1024)).toFixed(1) : '?'
          }));

        return { ok: true, files };
      } catch (err) {
        console.error('[NAS] Errore lista mappe:', err.message);
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('nas-download-map', async (event, { fileName }) => {
      try {
        const token = getNasToken();
        if (!token) throw new Error('Token NAS mancante.');

        const encodedName = encodeURIComponent(fileName);
        const fileUrl = `https://sentieriap.duckdns.org/files/api/file?path=Cloud/${encodedName}`;
        const targetDir = tilesDir();

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const targetFilePath = path.join(targetDir, fileName);
        console.log(`[NAS] Inizio download mappa "${fileName}" in: ${targetFilePath}`);

        const res = await fetch(fileUrl, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!res.ok) throw new Error(`Errore HTTP download ${res.status}`);

        const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
        let downloadedBytes = 0;

        const fileStream = fs.createWriteStream(targetFilePath);
        const reader = res.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          fileStream.write(Buffer.from(value));
          downloadedBytes += value.length;

          const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : -1;
          event.sender.send('map-download:progress', {
            fileName,
            progress,
            downloadedBytes,
            totalBytes
          });
        }

        fileStream.end();
        console.log(`[NAS] Download completato per ${fileName} (${downloadedBytes} byte)`);

        return { ok: true, filePath: targetFilePath };
      } catch (err) {
        console.error('[NAS] Errore download mappa:', err.message);
        return { ok: false, error: err.message };
      }
    });

    // Handler IPC per la ricerca, verifica e sincronizzazione del dispositivo Android via Bonjour / REST API
    ipcMain.handle('find-android-device', async (_e, { timeoutMs = 8000, healthPath = '/api/v1/info', baseUrl = null } = {}) => {
      try {
        if (baseUrl) {
          const info = await verificaConnessioneDispositivo(baseUrl, healthPath);
          return { ok: true, device: { name: 'Smartphone Android', baseUrl, info } };
        }
        const device = await trovaEVerificaAndroid(timeoutMs, healthPath);
        return { ok: true, device };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('sync-fetch-android-data', async (_e, { baseUrl } = {}) => {
      try {
        let targetUrl = baseUrl;
        if (!targetUrl) {
          console.log('[Sync] Ricerca dello smartphone Android via mDNS...');
          const device = await trovaEVerificaAndroid(5000, '/api/v1/info');
          targetUrl = device.baseUrl;
        }

        console.log(`[Sync] Connessione a ${targetUrl}. Richiesta elenco sentieri...`);

        // 1. Scarica i metadata di tutti i sentieri (senza scaricare milioni di punti in RAM in una sola volta)
        const resSentieri = await fetch(`${targetUrl}/api/v1/sentieri`);
        if (!resSentieri.ok) throw new Error(`Errore risposta sentieri: HTTP ${resSentieri.status}`);
        const sentieri = await resSentieri.json();

        console.log(`[Sync] Ricevuti metadata per ${sentieri.length} sentieri dallo smartphone.`);

        // 2. Confronto Delta-Sync Bidirezionale (Android -> PC e PC -> Android)
        let localMap = new Map();
        let localKeySet = new Set();
        let localSentieriList = [];

        const activeDbPath = currentSrc || path.join(app.getPath('userData'), 'sentieri-local.db');

        if (fs.existsSync(activeDbPath)) {
          try {
            const checkDb = new DatabaseSync(activeDbPath, { readOnly: true });
            try {
              const poiCols = new Set(checkDb.prepare('PRAGMA table_info("PoiDB")').all().map(c => c.name.toLowerCase()));
              const poiLatCol = poiCols.has('latit') ? 'Latit' : 'Lat';
              const poiLonCol = poiCols.has('longit') ? 'Longit' : 'Lon';
              const trackCols = new Set(checkDb.prepare('PRAGMA table_info("Track")').all().map(c => c.name.toLowerCase()));
              const trackLatCol = trackCols.has('latit') ? 'Latit' : 'Lat';
              const trackLonCol = trackCols.has('longit') ? 'Longit' : 'Lon';

              localSentieriList = checkDb.prepare(`
                SELECT id, uuid, Nome, Descrizione, Lunghezza, Dislivello, Discesa, HrMed, HrMax,
                       DataOra, TempMedia, TempMax, TempMin, DataFine, TempoTot, TempoInMov, MediaVel, lastUpdate
                FROM Sentieri
              `).all();

              localSentieriList.forEach(r => {
                if (r.uuid) localMap.set(r.uuid, r.lastUpdate || 0);
                const key = `${(r.Nome || '').trim().toLowerCase()}|${(r.DataOra || '').trim()}`;
                if (key !== '|') localKeySet.add(key);

                // Carica punti e POI per eventuale invio (push) ad Android
                r.punti = checkDb.prepare(`SELECT "${trackLonCol}" AS Lon, "${trackLatCol}" AS Lat, Ele, Time, batteryPercent, cadence, assistLevel, power, heartRate FROM Track WHERE Trackid = ? OR trackUuid = ? ORDER BY Time`).all(r.id, r.uuid || '');
                r.pois = checkDb.prepare(`SELECT uuid, trackUuid, "${poiLatCol}" AS Lat, "${poiLonCol}" AS Lon, Ele, NomePOI, DescrPOI, Time, UriPath, lastUpdate FROM PoiDB WHERE Trackid = ? OR trackUuid = ? ORDER BY Time`).all(r.id, r.uuid || '');
              });

            } finally {
              checkDb.close();
            }
          } catch (errDb) {
            console.warn('[Sync] Impossibile leggere indice locale per sync bidirezionale:', errDb.message);
          }
        }

        // A. Sentieri da Android da SCARICARE sul PC
        const sentieriDaAggiornare = sentieri.filter(s => {
          const uuid = s.uuid || s.uuidStr || '';
          const nameDateKey = `${(s.Nome || s.nome || '').trim().toLowerCase()}|${(s.DataOra || s.dataOra || '').trim()}`;

          if (uuid && localMap.has(uuid)) {
            const localLastUpdate = localMap.get(uuid);
            const remoteLastUpdate = s.lastUpdate || 0;
            return remoteLastUpdate > 0 && localLastUpdate > 0 && remoteLastUpdate > localLastUpdate;
          }
          if (nameDateKey !== '|' && localKeySet.has(nameDateKey)) return false;
          return true;
        });

        // B. Sentieri dal PC da INVIARE allo smartphone Android
        const remoteUuidSet = new Set(sentieri.map(s => s.uuid || s.uuidStr).filter(Boolean));
        const remoteKeySet = new Set(sentieri.map(s => `${(s.Nome || s.nome || '').trim().toLowerCase()}|${(s.DataOra || s.dataOra || '').trim()}`));

        const sentieriDaInviareAdAndroid = localSentieriList.filter(s => {
          const uuid = s.uuid || '';
          const key = `${(s.Nome || '').trim().toLowerCase()}|${(s.DataOra || '').trim()}`;
          if (uuid && remoteUuidSet.has(uuid)) return false;
          if (key !== '|' && remoteKeySet.has(key)) return false;
          return true;
        });

        console.log(`[Sync Bidirezionale] Da scaricare da Android: ${sentieriDaAggiornare.length}. Da inviare ad Android: ${sentieriDaInviareAdAndroid.length}`);

        // C. INVIO PERCORSI (PC -> ANDROID)
        let inviatiAdAndroidCount = 0;
        if (sentieriDaInviareAdAndroid.length > 0) {
          console.log(`[Sync Push] Invio di ${sentieriDaInviareAdAndroid.length} sentieri al dispositivo Android...`);
          try {
            const payloadPush = {
              sentieri: sentieriDaInviareAdAndroid.map(s => ({
                id: s.id,
                uuid: s.uuid,
                Nome: s.Nome,
                Descrizione: s.Descrizione,
                Lunghezza: s.Lunghezza,
                Dislivello: s.Dislivello,
                Discesa: s.Discesa,
                HrMed: s.HrMed,
                HrMax: s.HrMax,
                DataOra: s.DataOra,
                TempMedia: s.TempMedia,
                TempMax: s.TempMax,
                TempMin: s.TempMin,
                DataFine: s.DataFine,
                TempoTot: s.TempoTot,
                TempoInMov: s.TempoInMov,
                MediaVel: s.MediaVel,
                lastUpdate: s.lastUpdate,
                punti: (s.punti || []).map(p => ({
                  Lat: p.Lat, Lon: p.Lon, Ele: p.Ele, Time: p.Time,
                  batteryPercent: p.batteryPercent, cadence: p.cadence, assistLevel: p.assistLevel, power: p.power, heartRate: p.heartRate
                })),
                pois: (s.pois || []).map(poi => ({
                  uuid: poi.uuid, trackUuid: poi.trackUuid || s.uuid,
                  Lat: poi.Lat, Lon: poi.Lon, Ele: poi.Ele,
                  NomePOI: poi.NomePOI, DescrPOI: poi.DescrPOI, Time: poi.Time, UriPath: poi.UriPath,
                  lastUpdate: poi.lastUpdate
                }))
              }))
            };

            const resPush = await fetch(`${targetUrl}/api/v1/sync`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payloadPush)
            });
            if (resPush.ok) {
              const resPushJson = await resPush.json();
              inviatiAdAndroidCount = resPushJson.importedSentieri || sentieriDaInviareAdAndroid.length;
              console.log(`[Sync Push] Inviati con successo ad Android: ${inviatiAdAndroidCount} sentieri.`);
            }
          } catch (errPush) {
            console.error('[Sync Push] Errore invio percorsi ad Android:', errPush.message);
          }
        }

        if (sentieriDaAggiornare.length === 0 && inviatiAdAndroidCount === 0) {
          console.log('[Sync] Tutti i sentieri sono già aggiornati in entrambe le direzioni!');
          return {
            ok: true,
            sentieri,
            totalSentieri: sentieri.length,
            daAggiornareCount: 0,
            inviatiCount: 0,
            savedCount: 0,
            pointsCount: 0,
            poisCount: 0,
            fotosCount: 0,
            fileFotoScaricati: 0,
            fileAudioScaricati: 0,
            alreadyUpToDate: true
          };
        }

        // 3. Scarica punti GPS, POI e Foto per i sentieri da aggiornare
        let scaricatiCount = 0;
        const listaDaScaricare = sentieriDaAggiornare;

        for (const s of listaDaScaricare) {
          const uuid = s.uuid || String(s.id);
          scaricatiCount++;
          console.log(`[Sync] Scaricamento dati (${scaricatiCount}/${listaDaScaricare.length}) per: "${s.Nome || s.nome}" [${uuid}]`);

          // A. Punti GPS (Track)
          try {
            const resPunti = await fetch(`${targetUrl}/api/v1/punti?uuid=${encodeURIComponent(uuid)}`);
            if (resPunti.ok) s.punti = await resPunti.json();
          } catch (errPunti) {
            console.warn(`[Sync] Impossibile scaricare punti per [${uuid}]:`, errPunti.message);
          }

          // B. Punti di Interesse (PoiDB)
          try {
            const resPoi = await fetch(`${targetUrl}/api/v1/poi?uuid=${encodeURIComponent(uuid)}`);
            if (resPoi.ok) s.pois = await resPoi.json();
          } catch (errPoi) {
            console.warn(`[Sync] Impossibile scaricare POI per [${uuid}]:`, errPoi.message);
          }

          // C. Foto (FotoPoi)
          try {
            const resFoto = await fetch(`${targetUrl}/api/v1/foto?uuid=${encodeURIComponent(uuid)}`);
            if (resFoto.ok) s.fotos = await resFoto.json();
          } catch (errFoto) {
            console.warn(`[Sync] Impossibile scaricare foto per [${uuid}]:`, errFoto.message);
          }
        }

        // 4. Salva o aggiorna i sentieri, punti, POI e Foto nel database SQLite locale dell'app desktop
        const savedStats = salvaDatiAndroidNelDb(listaDaScaricare);

        // 5. Scarica i file fisici di Foto (.jpg/.png) e Audio (.m4a) nel filesystem locale del PC
        const targetFotoDir = fotoDir();
        const targetVoceDir = voceDir();
        if (targetFotoDir) fs.mkdirSync(targetFotoDir, { recursive: true });
        if (targetVoceDir) fs.mkdirSync(targetVoceDir, { recursive: true });

        let fileFotoScaricati = 0;
        let fileAudioScaricati = 0;

        for (const s of listaDaScaricare) {
          // A. Download file immagini Foto
          if (Array.isArray(s.fotos) && targetFotoDir) {
            for (const f of s.fotos) {
              let fotoName = f.NomeFoto || f.nomeFoto || (f.UriPath || f.uriPath || '').split('/').pop() || '';
              try { fotoName = decodeURIComponent(fotoName); } catch {}
              fotoName = fotoName.split('?')[0].split('#')[0].split('/').pop();

              if (fotoName) {
                const localPath = path.join(targetFotoDir, fotoName);
                if (!fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
                  try {
                    console.log(`[Sync] Scaricamento file foto: ${fotoName}`);
                    const resFile = await fetch(`${targetUrl}/api/v1/files/foto?name=${encodeURIComponent(fotoName)}`);
                    if (resFile.ok) {
                      const buffer = Buffer.from(await resFile.arrayBuffer());
                      if (buffer.length > 0) {
                        fs.writeFileSync(localPath, buffer);
                        fileFotoScaricati++;
                      }
                    }
                  } catch (errFile) {
                    console.warn(`[Sync] Errore download file foto ${fotoName}:`, errFile.message);
                  }
                }
              }
            }
          }

          // B. Download file audio Voce Waypoint
          if (Array.isArray(s.pois) && targetVoceDir) {
            for (const poi of s.pois) {
              const uriPath = poi.UriPath || poi.uriPath || '';
              if (uriPath) {
                let voceName = uriPath.trim();
                try { voceName = decodeURIComponent(voceName); } catch {}
                voceName = voceName.split('?')[0].split('#')[0].split('/').pop();

                if (voceName && voceName.includes('.')) {
                  const localPath = path.join(targetVoceDir, voceName);
                  if (!fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
                    try {
                      console.log(`[Sync] Scaricamento file audio voce: ${voceName}`);
                      const resFile = await fetch(`${targetUrl}/api/v1/files/voce?name=${encodeURIComponent(voceName)}`);
                      if (resFile.ok) {
                        const buffer = Buffer.from(await resFile.arrayBuffer());
                        if (buffer.length > 0) {
                          fs.writeFileSync(localPath, buffer);
                          fileAudioScaricati++;
                          console.log(`[Sync] File audio salvato con successo: ${localPath} (${buffer.length} byte)`);
                        }
                      }
                    } catch (errFile) {
                      console.warn(`[Sync] Errore download file audio ${voceName}:`, errFile.message);
                    }
                  }
                }
              }
            }
          }
        }

        console.log(`[Sync] File fisici scaricati sul PC: ${fileFotoScaricati} foto, ${fileAudioScaricati} audio.`);

        return {
          ok: true,
          sentieri,
          baseUrl: targetUrl,
          totalSentieri: sentieri.length,
          daAggiornareCount: listaDaScaricare.length,
          savedCount: savedStats.countSentieri,
          pointsCount: savedStats.countPunti,
          poisCount: savedStats.countPois,
          fotosCount: savedStats.countFotos,
          fileFotoScaricati,
          fileAudioScaricati,
        };
      } catch (err) {
        console.error('[Sync] Errore sincronizzazione:', err);
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('sync-push-to-android', async (_e, { baseUrl, payload } = {}) => {
      try {
        let targetUrl = baseUrl;
        if (!targetUrl) {
          const device = await trovaEVerificaAndroid(5000, '/api/v1/info');
          targetUrl = device.baseUrl;
        }

        const res = await fetch(`${targetUrl}/api/v1/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Errore risposta sync: HTTP ${res.status}`);
        const result = await res.json();

        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
	
	ipcMain.handle('mbtiles:pick', async (event) => {
		//const win = BrowserWindow.fromWebContents(event.sender);
		const result = await dialog.showOpenDialog(win, {
			title: 'Seleziona una mappa MBTiles',
			filters: [{ name: 'MBTiles', extensions: ['mbtiles'] }],
			properties: ['openFile']
		});
		if (result.canceled || !result.filePaths.length) return null;
		return { path: result.filePaths[0] };
	});

	ipcMain.on('mbtiles:load', (event, path) => {
		event.sender.send('mbtiles:load', path);
	});

    server = createServer({
      webRoot: path.join(__dirname, 'web'),
      ctx: { status: () => status, api: () => api, tilesDir },
    });
    port = await server.listenLocal(PREFERRED_PORT);

    protocol.handle('mbtiles', (request) => {
      const textHeaders = { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
      try {
        const url = new URL(request.url);
        let fileRef = decodeURIComponent(url.hostname || url.host || '');

        let fullPath = activeMbtilesFilePath;
        if (!fullPath || !fs.existsSync(fullPath)) {
          if (path.isAbsolute(fileRef) && fs.existsSync(fileRef)) {
            fullPath = fileRef;
          } else {
            fullPath = path.join(tilesDir(), fileRef);
          }
        }

        const parts = url.pathname.replace(/^\/+/, '').split('/');
        const z = parseInt(parts[0], 10);
        const x = parseInt(parts[1], 10);
        const y = parseInt(parts[2], 10);

        if (!fs.existsSync(fullPath)) {
          console.error('[MBTiles Protocol] File non trovato:', fullPath);
          return new Response(`FILE MBTILES NON TROVATO.\nPercorso cercato: ${fullPath}`, { status: 200, headers: textHeaders });
        }

        const mdb = getMbtilesDb(fullPath);
        if (!mdb) {
          console.error('[MBTiles Protocol] Impossibile aprire SQLite per:', fullPath);
          return new Response(`IMPOSSIBILE APRIRE SQLITE.\nFile: ${fullPath}`, { status: 200, headers: textHeaders });
        }

        if (Number.isNaN(z) || Number.isNaN(x) || Number.isNaN(y)) {
          return new Response(`COORDINATE NON VALIDE.\nURL: ${request.url}`, { status: 200, headers: textHeaders });
        }

        const tmsY = (Math.pow(2, z) - 1) - y;
        const row = mdb.prepare(
          'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
        ).get(z, x, tmsY);

        if (row && row.tile_data) {
          let mime = 'image/png';
          if (row.tile_data[0] === 0xFF && row.tile_data[1] === 0xD8) mime = 'image/jpeg';
          else if (row.tile_data[0] === 0x52 && row.tile_data[1] === 0x49) mime = 'image/webp';

          return new Response(row.tile_data, {
            headers: { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' },
          });
        }

        return new Response(`TESSERA NON PRESENTE NEL DB.\nFile: ${fullPath}`, { status: 200, headers: textHeaders });
      } catch (err) {
        return new Response(`ERRORE ECCEZIONE MBTILES:\n${err.stack || err.message}`, { status: 200, headers: textHeaders });
      }
    });

    buildMenu();
    createWindow();

    const initial = dbFromArgv(process.argv) || settings.get('lastDb');
    if (initial && fs.existsSync(initial)) openDatabasePath(initial);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    chiudiBonjour();
    closeDatabase();
    if (server) server.close();
    for (const mdb of mbtilesCache.values()) { try { mdb.close(); } catch {} }
    mbtilesCache.clear();
  });
}