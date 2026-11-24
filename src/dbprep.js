'use strict';
// Prepara il database da aprire: copia di lavoro + indici. Il file originale non viene mai modificato.
// Gira in un thread separato (dbprep-worker.js) perché con milioni di punti può richiedere minuti.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REQUIRED_TABLES = ['Sentieri', 'Track', 'PoiDB', 'FotoPoi'];
const SIGNATURE_VERSION = 1;

function sizeOrZero(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function prepareDatabase({ src, workDir, progress = () => {} }) {
  fs.mkdirSync(workDir, { recursive: true });
  const work = path.join(workDir, 'sentieri-work.db');
  const metaFile = path.join(workDir, 'meta.json');

  const st = fs.statSync(src);
  const signature = {
    version: SIGNATURE_VERSION,
    src: path.resolve(src),
    size: st.size,
    mtimeMs: Math.floor(st.mtimeMs),
    walSize: sizeOrZero(src + '-wal'),
  };

  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* nessuna copia precedente */ }
  const upToDate = meta && JSON.stringify(meta) === JSON.stringify(signature) && fs.existsSync(work);

  if (!upToDate) {
    progress('Copia del database…');
    fs.rmSync(metaFile, { force: true });
    for (const f of [work, work + '-wal', work + '-shm', work + '-journal']) fs.rmSync(f, { force: true });
    fs.copyFileSync(src, work);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, work + ext);
    }
  }

  const db = new DatabaseSync(work);
  try {
    db.exec('PRAGMA busy_timeout = 5000');

    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) {
      throw new Error(`Non sembra un database di Sentieri: mancano le tabelle ${missing.join(', ')}.`);
    }

    if (!upToDate) {
      progress('Aggiornamento del file…');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');   // porta nel file principale i dati ancora nel WAL
      db.exec('PRAGMA journal_mode = DELETE');
    }

    const trackCols = new Set(
      db.prepare('PRAGMA table_info("Track")').all().map((r) => r.name.toLowerCase())
    );
    const trackLatCol = trackCols.has('latit') ? 'Latit' : 'Lat';
    const trackLonCol = trackCols.has('longit') ? 'Longit' : 'Lon';

    const indexesToCreate = [
      ['idx_desk_track_trackid_time', 'Track', 'Trackid, Time'],
      ['idx_desk_track_area', 'Track', `"${trackLatCol}", "${trackLonCol}", Trackid`],
      ['idx_desk_poi_trackid', 'PoiDB', 'Trackid'],
      ['idx_desk_foto_trackid', 'FotoPoi', 'Trackid'],
    ];

    const existing = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name)
    );
    const todo = indexesToCreate.filter(([name]) => !existing.has(name));
    todo.forEach(([name, table, cols], i) => {
      progress(`Creazione degli indici ${i + 1}/${todo.length}…`);
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
      } catch (errIdx) {
        console.warn(`[DbPrep] Avviso creazione indice ${name}:`, errIdx.message);
      }
    });
    if (todo.length) {
      progress('Ottimizzazione…');
      db.exec('PRAGMA optimize');
    }
  } finally {
    db.close();
  }

  fs.writeFileSync(metaFile, JSON.stringify(signature));
  return work;
}

module.exports = { prepareDatabase, REQUIRED_TABLES };
