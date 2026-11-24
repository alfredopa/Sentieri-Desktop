'use strict';
// Gli stessi endpoint del backend PHP (routes.php, geojson.php, poi.php, ...), ma su SQLite.
// Ogni funzione restituisce { status?, json } oppure { file: {path, mime} } oppure { buffer: {data, mime} }.
const fs = require('node:fs');
const path = require('node:path');

const AREA_LIMIT = 300;

const ROUTE_COLUMNS = ['id', 'Nome', 'Descrizione', 'DataOra', 'DataFine', 'Lunghezza', 'TempoTot', 'TempoInMov',
  'Dislivello', 'Discesa', 'MediaVel', 'HrMed', 'HrMax'];
const SENSORI = { hr: 'heartRate', battery: 'batteryPercent', assist: 'assistLevel', power: 'power' };

const VOCE_NAME_RE = /^[\p{L}\p{N}._ ()-]{1,180}\.(m4a|3gp|aac|mp3|wav|ogg|mp4)$/iu;
const AUDIO_MIME = { '.m4a': 'audio/x-m4a', '.mp4': 'audio/mp4', '.3gp': 'audio/3gpp', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
const FOTO_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

const bad = (status, error) => ({ status, json: { error } });
const intParam = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null);
const isSet = (v) => v !== null && v !== undefined;     // come isset() in PHP: il NULL resta NULL
const toInt = (v) => Math.trunc(Number(v));               // come (int) in PHP

// Restituisce il percorso reale del file solo se sta dentro la cartella indicata.
function resolveInside(root, candidates) {
  if (!root) return null;
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch { return null; }
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (real.startsWith(rootReal + path.sep) && fs.statSync(real).isFile()) return real;
    } catch { /* prova il prossimo */ }
  }
  return null;
}

const baseName = (v) => path.basename(String(v ?? '').replace(/\\/g, '/'));

// Stessa conversione di normalizeRouteRows() in route-fields.php (backend PHP sul NAS):
// Lunghezza in metri, TempoTot e TempoInMov in secondi; FC e velocità a 0 diventano null.
function toRoute(r) {
  const distKm = isSet(r.Lunghezza) ? (Number(r.Lunghezza) > 500 ? Math.round(Number(r.Lunghezza) / 100) / 10 : Math.round(Number(r.Lunghezza) * 10) / 10) : 0;
  const durationMin = isSet(r.TempoTot) ? Math.round(Number(r.TempoTot) / 60) : 0;
  const dateStr = String(r.DataOra ?? '');

  return {
    id: Number(r.id),
    name: String(r.Nome ?? '').trim(),
    description: String(r.Descrizione ?? '').trim(),

    // Campi per app.js (rendering lista laterale: Data, Lunghezza, Durata):
    date: dateStr,
    distance_km: distKm,
    duration_min: durationMin,

    time_start: dateStr,
    time_end: String(r.DataFine ?? ''),
    length_m: isSet(r.Lunghezza) ? Math.round(Number(r.Lunghezza)) : null,
    duration_total_min: durationMin,
    duration_moving_min: isSet(r.TempoInMov) ? Math.round(Number(r.TempoInMov) / 60) : null,
    elevation_gain_m: isSet(r.Dislivello) ? toInt(r.Dislivello) : null,
    elevation_loss_m: isSet(r.Discesa) ? toInt(r.Discesa) : null,
    hr_avg: isSet(r.HrMed) ? (Number(r.HrMed) > 0 ? toInt(r.HrMed) : null) : null,
    hr_max: isSet(r.HrMax) ? (Number(r.HrMax) > 0 ? toInt(r.HrMax) : null) : null,
    avg_speed_kmh: isSet(r.MediaVel) ? (Number(r.MediaVel) > 0 ? Math.round(Number(r.MediaVel) * 10) / 10 : null) : null,
  };
}

function createApi({ db, fotoDir, voceDir, makeThumb = async () => null }) {
  const columnsOf = (table) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name.toLowerCase()));
    } catch {
      return new Set();
    }
  };

  const sentieriCols = columnsOf('Sentieri');
  const trackCols = columnsOf('Track');
  const poiCols = columnsOf('PoiDB');
  const fotoCols = columnsOf('FotoPoi');

  const hasSentieriUuid = sentieriCols.has('uuid');
  const hasPoiTrackUuid = poiCols.has('trackuuid');
  const hasFotoTrackUuid = fotoCols.has('trackuuid');
  const hasTrackUuid = trackCols.has('trackuuid');

  const poiLatCol = poiCols.has('latit') ? 'Latit' : (poiCols.has('lat') ? 'Lat' : 'Lat');
  const poiLonCol = poiCols.has('longit') ? 'Longit' : (poiCols.has('lon') ? 'Lon' : 'Lon');
  const trackLatCol = trackCols.has('latit') ? 'Latit' : (trackCols.has('lat') ? 'Lat' : 'Lat');
  const trackLonCol = trackCols.has('longit') ? 'Longit' : (trackCols.has('lon') ? 'Lon' : 'Lon');

  const routeSelect = (alias) => ROUTE_COLUMNS
    .map((c) => (sentieriCols.has(c.toLowerCase()) ? `${alias}."${c}" AS "${c}"` : `NULL AS "${c}"`))
    .join(', ');
  const routeOrder = (alias) => (sentieriCols.has('dataora') ? `${alias}."DataOra" DESC` : `${alias}."id" DESC`);

  const stmts = {
    routes: db.prepare(`SELECT ${routeSelect('s')} FROM Sentieri s ORDER BY ${routeOrder('s')}`),
    routesByName: db.prepare(
      `SELECT ${routeSelect('s')} FROM Sentieri s WHERE s."Nome" LIKE ? ORDER BY ${routeOrder('s')}`),
    routesInArea: db.prepare(
      `SELECT ${routeSelect('s')} FROM Sentieri s
        WHERE s."id" IN (SELECT t."Trackid" FROM Track t
                          WHERE t."${trackLatCol}" BETWEEN ? AND ? AND t."${trackLonCol}" BETWEEN ? AND ?)
        ORDER BY ${routeOrder('s')} LIMIT ${AREA_LIMIT}`),
    routeName: db.prepare('SELECT "Nome" AS nome FROM Sentieri WHERE "id" = ?'),
    poi: (hasPoiTrackUuid && hasSentieriUuid) ? db.prepare(
      `SELECT id, "${poiLatCol}" AS Lat, "${poiLonCol}" AS Lon, Ele, NomePOI, DescrPOI, UriPath, Time
       FROM PoiDB
       WHERE Trackid = ? OR trackUuid = (SELECT uuid FROM Sentieri WHERE id = ?)
       ORDER BY Time`) : db.prepare(
      `SELECT id, "${poiLatCol}" AS Lat, "${poiLonCol}" AS Lon, Ele, NomePOI, DescrPOI, UriPath, Time
       FROM PoiDB
       WHERE Trackid = ?
       ORDER BY Time`),
    poiAudio: db.prepare('SELECT UriPath FROM PoiDB WHERE id = ?'),
    foto: (hasFotoTrackUuid && hasSentieriUuid) ? db.prepare(
      `SELECT id, NomeFoto
       FROM FotoPoi
       WHERE Trackid = ? OR trackUuid = (SELECT uuid FROM Sentieri WHERE id = ?)`) : db.prepare(
      `SELECT id, NomeFoto
       FROM FotoPoi
       WHERE Trackid = ?`),
    fotoById: db.prepare('SELECT NomeFoto FROM FotoPoi WHERE id = ?'),
  };

  const sensoriDisponibili = Object.entries(SENSORI).filter(([, col]) => trackCols.has(col.toLowerCase()));
  stmts.points = (hasTrackUuid && hasSentieriUuid) ? db.prepare(
    `SELECT "${trackLonCol}" AS Lon, "${trackLatCol}" AS Lat, Ele${sensoriDisponibili.map(([k, col]) => `, "${col}" AS m_${k}`).join('')}
       FROM Track
       WHERE Trackid = ? OR trackUuid = (SELECT uuid FROM Sentieri WHERE id = ?)
       ORDER BY Time`) : db.prepare(
    `SELECT "${trackLonCol}" AS Lon, "${trackLatCol}" AS Lat, Ele${sensoriDisponibili.map(([k, col]) => `, "${col}" AS m_${k}`).join('')}
       FROM Track
       WHERE Trackid = ?
       ORDER BY Time`);

  const thumbCache = new Map();
  async function thumbOf(file) {
    const key = `${file}:${fs.statSync(file).mtimeMs}`;
    if (thumbCache.has(key)) return thumbCache.get(key);
    const data = await makeThumb(file);
    if (data) {
      thumbCache.set(key, data);
      if (thumbCache.size > 300) thumbCache.delete(thumbCache.keys().next().value);
    }
    return data;
  }

  function voceFile(uriPath) {
    if (!uriPath) return null;
    let nome = String(uriPath).trim();
    try { nome = decodeURIComponent(nome); } catch {}
    nome = path.basename(nome.replace(/\\/g, '/')).split('?')[0].split('#')[0];
    if (!nome || nome.includes('..') || !VOCE_NAME_RE.test(nome)) return null;

    const root = voceDir();
    const candidates = [
      path.join(root, nome),
      path.join(path.dirname(root), 'VoceWaypoint', nome),
      path.join(path.dirname(root), 'VoiceNotesWaypoint', nome)
    ];

    for (const cand of candidates) {
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile() && fs.statSync(cand).size > 0) {
          return cand;
        }
      } catch { /* ignora errori di permessi o path */ }
    }
    return null;
  }

  return {
    // GET routes.php[?q=...]
    async routes(q) {
      const text = String(q.q ?? '').trim();
      const rows = text ? stmts.routesByName.all(`%${text}%`) : stmts.routes.all();
      return { json: rows.map(toRoute) };
    },

    // GET routes-in-area.php?minLon&minLat&maxLon&maxLat
    async routesInArea(q) {
      const v = ['minLat', 'maxLat', 'minLon', 'maxLon'].map((k) => (q[k] === undefined ? NaN : Number(q[k])));
      if (v.some((x) => !Number.isFinite(x))) {
        return bad(400, 'Parametri minLon/minLat/maxLon/maxLat mancanti o non validi');
      }
      return { json: stmts.routesInArea.all(...v).map(toRoute) };
    },

    // GET geojson.php?id=N  (con "metrics": serie dei sensori allineate ai punti)
    async geojson(q) {
      try {
        const id = intParam(q.id);
        if (id === null) return bad(400, 'Parametro "id" mancante');

        const points = (hasTrackUuid && hasSentieriUuid) ? stmts.points.all(id, id) : stmts.points.all(id);
        if (!points || !points.length) return bad(404, 'Nessun punto trovato per questo percorso');

        const name = stmts.routeName.get(id)?.nome ?? null;
        const feature = {
          type: 'Feature',
          properties: { name: name || null },
          geometry: {
            type: 'LineString',
            coordinates: points.map((p) => [Number(p.Lon), Number(p.Lat), Number(p.Ele) || 0]),
          },
        };

        const metrics = {};
        for (const [k] of sensoriDisponibili) {
          let utile = false;
          const serie = points.map((p) => {
            const raw = p[`m_${k}`];
            const v = raw === null || raw === undefined ? null : Math.trunc(Number(raw));
            if (v !== null && v !== 0) utile = true;
            return v;
          });
          if (utile) metrics[k] = serie;
        }
        if (Object.keys(metrics).length) feature.metrics = metrics;
        return { json: feature };
      } catch (err) {
        console.error(`[API] Errore in geojson.php?id=${q.id}:`, err);
        return bad(500, err.message);
      }
    },

    // GET poi.php?id=N
    async poi(q) {
      try {
        const id = intParam(q.id);
        if (id === null) {
          console.warn('[API] poi.php: Parametro "id" non valido:', q);
          return bad(400, 'Parametro "id" mancante o non valido');
        }

        const sentiero = stmts.routeName.get(id);
        const uuidVal = hasSentieriUuid ? (db.prepare('SELECT uuid FROM Sentieri WHERE id = ?').get(id)?.uuid || '') : '';
        const rows = (hasPoiTrackUuid && hasSentieriUuid) ? stmts.poi.all(id, id) : stmts.poi.all(id);

        console.log(`[API] GET /poi.php?id=${id} (Nome="${sentiero?.nome}", UUID="${uuidVal}") -> Trovati ${rows.length} waypoint nel DB.`);

        return {
          json: rows.map((r, idx) => {
            const validPoiId = isSet(r.id) ? Number(r.id) : (isSet(r.Id) ? Number(r.Id) : (idx + 1));
            return {
              id: validPoiId,
              lat: Number(r.Lat),
              lon: Number(r.Lon),
              ele: Number(r.Ele),
              name: String(r.NomePOI ?? '').trim(),
              description: String(r.DescrPOI ?? '').trim(),
              time: String(r.Time ?? ''),
              audio: voceFile(r.UriPath) !== null,
            };
          }),
        };
      } catch (err) {
        console.error(`[API] Errore in poi.php?id=${q.id}:`, err.message, err.stack);
        return { json: [] };
      }
    },

    // GET foto.php?id=N
    async foto(q) {
      try {
        const id = intParam(q.id);
        if (id === null) return bad(400, 'Parametro "id" mancante o non valido');

        const rows = (hasFotoTrackUuid && hasSentieriUuid) ? stmts.foto.all(id, id) : stmts.foto.all(id);
        const out = rows.map((f) => {
          const base = path.parse(String(f.NomeFoto ?? '')).name;
          let ms = null;
          if (/^\d+$/.test(base)) {
            const n = Number(base);
            ms = n > 100000000000 ? n : n * 1000;
          }
          return { id: Number(f.id), name: String(f.NomeFoto ?? ''), taken_ms: ms };
        });
        out.sort((a, b) => (a.taken_ms ?? 0) - (b.taken_ms ?? 0));
        return { json: out };
      } catch (err) {
        console.error(`[API] Errore in foto.php?id=${q.id}:`, err);
        return { json: [] };
      }
    },

    // GET foto-file.php?id=N[&thumb=1]
    async fotoFile(q) {
      const id = intParam(q.id);
      if (id === null) return bad(400, 'Richiesta non valida');
      const row = stmts.fotoById.get(id);
      if (!row) return bad(404, 'Foto non trovata');
      const root = fotoDir();
      const nome = baseName(row.NomeFoto);
      const uuid = baseName(row.trackUuid);
      const file = nome && resolveInside(root, [path.join(root, nome), path.join(root, uuid, nome)]);
      if (!file) return bad(404, 'Foto non trovata');

      const ext = path.extname(file).toLowerCase();
      const mime = FOTO_MIME[ext];
      if (!mime) return bad(400, 'Richiesta non valida');

      if (q.thumb !== undefined && (ext === '.jpg' || ext === '.jpeg')) {
        const data = await thumbOf(file);
        if (data) return { buffer: { data, mime: 'image/jpeg' } };
      }
      return { file: { path: file, mime } };
    },

    // GET voce-file.php?id=N
    async voceFile(q) {
      try {
        const rawId = q.id || q.uuid || '';
        const id = intParam(rawId);
        let row = id !== null ? stmts.poiAudio.get(id) : null;
        if (!row && rawId) {
          try {
            row = db.prepare('SELECT UriPath FROM PoiDB WHERE uuid = ? OR id = ? OR rowid = ?').get(rawId, rawId, rawId);
          } catch {}
        }
        const file = row && voceFile(row.UriPath);
        if (!file) return bad(404, 'Audio non trovato');

        const ext = path.extname(file).toLowerCase();
        const mime = AUDIO_MIME[ext] || 'audio/x-m4a';
        return { file: { path: file, mime } };
      } catch (err) {
        console.error(`[API] Errore in voceFile?id=${q.id}:`, err);
        return bad(500, err.message);
      }
    },
  };
}

module.exports = { createApi, toRoute };
