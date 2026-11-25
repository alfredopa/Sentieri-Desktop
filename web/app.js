// ---------------------------------------------------------------------------
// Percorsi — Viewer
// Carica l'elenco percorsi (da API REST o dati demo), li mostra in una lista
// laterale e permette di visualizzare più tracce insieme sulla mappa, ognuna
// con un colore diverso e una freccia di direzione lungo il percorso.
// ---------------------------------------------------------------------------

const cfg = window.APP_CONFIG;

// Registra il protocollo "pmtiles://" — permette di usare come sorgente
// mappa un singolo file .pmtiles servito staticamente dal NAS (nessun
// server di tile necessario: MapLibre legge direttamente via HTTP Range
// Request). Va fatto una volta sola, prima di creare la mappa.
if (window.pmtiles) {
  const pmtilesProtocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);
}

// Tavolozza colori per le tracce attive. Assegnata per ordine di selezione,
// riusata quando una traccia viene rimossa.
const PALETTE = [
  "#ff0000", "#2f6b8e", "#2f44b8", "#8e2f6b",
  "#2f8e6b", "#c9954f", "#5b3e96", "#c94f4f"
];

const state = {
  routes: [],
  currentList: [],
  activeRoutes: new Map(), // id -> { feature, color, meta }
  geojsonCache: new Map(),
  areaSearch: {
    drawing: false,
    corner1: null,   // maplibregl.Marker
    corner2: null,   // maplibregl.Marker
    filterActive: false
  }
};

const els = {
  app: document.getElementById("app"),
  sidebar: document.getElementById("sidebar"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  list: document.getElementById("route-list"),
  search: document.getElementById("search"),
  count: document.getElementById("route-count"),
  fitAll: document.getElementById("fit-all"),
  sourceIndicator: document.getElementById("source-indicator"),
  tracksPanel: document.getElementById("tracks-panel"),
  tracksList: document.getElementById("tracks-list"),
  clearTracks: document.getElementById("clear-tracks"),
  toast: document.getElementById("toast"),
  layersToggle: document.getElementById("layers-toggle"),
  layersPanel: document.getElementById("layers-panel"),
  layersPanelClose: document.getElementById("layers-panel-close"),
  layersList: document.getElementById("layers-list"),
  routeModal: document.getElementById("route-modal"),
  routeModalClose: document.getElementById("route-modal-close"),
  routeModalSwatch: document.getElementById("route-modal-swatch"),
  routeModalName: document.getElementById("route-modal-name"),
  routeModalDesc: document.getElementById("route-modal-desc"),
  routeModalStats: document.getElementById("route-modal-stats"),
  routeModalChart: document.getElementById("route-modal-chart"),
  areaSearchToggle: document.getElementById("area-search-toggle"),
  areaSearchToolbar: document.getElementById("area-search-toolbar"),
  areaSearchHint: document.getElementById("area-search-hint"),
  areaSearchConfirm: document.getElementById("area-search-confirm"),
  areaSearchCancel: document.getElementById("area-search-cancel"),
  areaFilterBanner: document.getElementById("area-filter-banner"),
  areaFilterCount: document.getElementById("area-filter-count"),
  areaFilterClear: document.getElementById("area-filter-clear")
};

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Selezione dello stile mappa (persistita in localStorage se disponibile)
// ---------------------------------------------------------------------------

function getSavedStyleId() {
  try { return localStorage.getItem("percorsi.mapStyleId"); } catch { return null; }
}
function saveStyleId(id) {
  try { localStorage.setItem("percorsi.mapStyleId", id); } catch { /* ignora, non essenziale */ }
}

const savedId = getSavedStyleId();
const initialStyleEntry =
  cfg.MAP_STYLES.find(s => s.id === savedId) || cfg.MAP_STYLES[0];
let currentStyleId = initialStyleEntry.id;

const map = new maplibregl.Map({
  container: "map",
  style: initialStyleEntry.style,
  center: cfg.INITIAL_CENTER,
  zoom: cfg.INITIAL_ZOOM
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

map.on("load", () => {
  try {
    attachRouteLayers();
    renderLayersPanel();
  } catch (err) {
    console.error("Errore nell'inizializzazione dei layer mappa:", err);
    showToast("Errore inizializzazione mappa: " + err.message, true);
  }
  init();
});

// ---------------------------------------------------------------------------
// Caricamento mappe MBTiles selezionate dal menu Electron
// ---------------------------------------------------------------------------
function loadMbtilesFileOnMap(filePath) {
  if (!map || !filePath) return;
  const fileName = filePath.split(/[/\\]/).pop();
  const sourceId = "custom-mbtiles-source";
  const layerId = "custom-mbtiles-layer";

  try {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    map.addSource(sourceId, {
      type: "raster",
      tiles: [`mbtiles://${encodeURIComponent(fileName)}/{z}/{x}/{y}`],
      tileSize: 256
    });

    const beforeLayer = map.getLayer("active-routes-line") ? "active-routes-line" : undefined;
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": 1.0 }
    }, beforeLayer);

    showToast(`Mappa caricata: ${fileName}`);
    console.log(`[Map] Mappa MBTiles caricata con successo da: ${filePath}`);
  } catch (err) {
    console.error("[Map] Errore durante il caricamento della mappa MBTiles:", err);
    showToast(`Errore mappa: ${err.message}`, true);
  }
}

if (window.desktop && typeof window.desktop.onLoadMbtilesFile === "function") {
  window.desktop.onLoadMbtilesFile((filePath) => {
    loadMbtilesFileOnMap(filePath);
  });
}
if (window.desktop && typeof window.desktop.onLoadMbtiles === "function") {
  window.desktop.onLoadMbtiles((filePath) => {
    loadMbtilesFileOnMap(filePath);
  });
}

// ---------------------------------------------------------------------------
// Caricamento e visualizzazione file GPX locali sulla mappa
// ---------------------------------------------------------------------------
function removeGpxTrackFromMap(fileName = null, lineLayerId = "gpx-imported-line", sourceId = "gpx-imported-source") {
  if (window._currentGpxPopup) {
    window._currentGpxPopup.remove();
    window._currentGpxPopup = null;
  }
  if (window._currentGpxClickHandler) {
    try {
      map.off("click", lineLayerId, window._currentGpxClickHandler);
      map.off("mouseenter", lineLayerId, window._currentGpxMouseEnter);
      map.off("mouseleave", lineLayerId, window._currentGpxMouseLeave);
    } catch {}
    window._currentGpxClickHandler = null;
    window._currentGpxMouseEnter = null;
    window._currentGpxMouseLeave = null;
  }
  if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  if (window._currentGpxMarkers) {
    window._currentGpxMarkers.forEach(m => m.remove());
    window._currentGpxMarkers = [];
  }
  if (fileName) {
    showToast(`Traccia "${fileName}" rimossa dalla mappa.`);
  }
}

function parseAndRenderGpx(fileName, gpxText) {
  if (!map || !gpxText) return;
  try {
    // Svuota completamente qualsiasi traccia, popup e listener GPX precedente
    removeGpxTrackFromMap();

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(gpxText, "text/xml");

    // Estrazione punti traccia (<trkpt> o <rtept>)
    const trkpts = Array.from(xmlDoc.getElementsByTagNameNS("*", "trkpt")).concat(
      Array.from(xmlDoc.getElementsByTagNameNS("*", "rtept"))
    );
    const coordinates = [];
    const bounds = new maplibregl.LngLatBounds();

    trkpts.forEach((pt) => {
      const lat = parseFloat(pt.getAttribute("lat"));
      const lon = parseFloat(pt.getAttribute("lon"));
      const eleNode = pt.getElementsByTagNameNS("*", "ele")[0] || pt.querySelector("ele");
      const ele = eleNode ? parseFloat(eleNode.textContent) || 0 : 0;

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        coordinates.push([lon, lat, ele]);
        bounds.extend([lon, lat]);
      }
    });

    if (coordinates.length === 0) {
      showToast("Nessun punto GPS trovato nel file GPX.", true);
      return;
    }

    // Estrazione Waypoint (<wpt>) compatibile con tutti gli spazi dei nomi GPX
    const wpts = Array.from(xmlDoc.getElementsByTagNameNS("*", "wpt"));
    const waypoints = [];
    wpts.forEach((pt) => {
      const lat = parseFloat(pt.getAttribute("lat"));
      const lon = parseFloat(pt.getAttribute("lon"));

      const getTagText = (tags) => {
        for (const t of tags) {
          const el = pt.getElementsByTagNameNS("*", t)[0] || pt.querySelector(t);
          if (el && el.textContent) return el.textContent.trim();
        }
        return "";
      };

      const name = getTagText(["name", "Name", "title"]);
      const description = getTagText(["desc", "cmt", "comment", "description"]);
      const eleStr = getTagText(["ele", "Elevation"]);

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        waypoints.push({
          id: `gpx-wp-${Date.now()}-${Math.random()}`,
          lat, lon,
          ele: eleStr ? parseFloat(eleStr) : NaN,
          name: name || "Waypoint GPX",
          description: description || "",
          time: "",
          audio: false
        });
        bounds.extend([lon, lat]);
      }
    });

    // Calcola la lunghezza totale in km ed il dislivello in m della traccia GPX
    let totalLengthM = 0;
    let elevationGainM = 0;
    for (let i = 1; i < coordinates.length; i++) {
      const p1 = coordinates[i - 1], p2 = coordinates[i];
      const R = 6371000;
      const dLat = (p2[1] - p1[1]) * Math.PI / 180;
      const dLon = (p2[0] - p1[0]) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(p1[1] * Math.PI / 180) * Math.cos(p2[1] * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      totalLengthM += R * c;

      const diffEle = (p2[2] || 0) - (p1[2] || 0);
      if (diffEle > 0) elevationGainM += diffEle;
    }

    const distKm = Math.round((totalLengthM / 1000) * 10) / 10;
    const gainM = Math.round(elevationGainM);

    const sourceId = "gpx-imported-source";
    const lineLayerId = "gpx-imported-line";

    map.addSource(sourceId, {
      type: "geojson",
      data: {
        type: "Feature",
        properties: { name: fileName },
        geometry: {
          type: "LineString",
          coordinates: coordinates
        }
      }
    });

    map.addLayer({
      id: lineLayerId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#e63946",
        "line-width": 5,
        "line-opacity": 0.95
      }
    });

    // Registrazione singola degli eventi mouse per il layer della traccia GPX
    window._currentGpxMouseEnter = () => { map.getCanvas().style.cursor = "pointer"; };
    window._currentGpxMouseLeave = () => { map.getCanvas().style.cursor = ""; };

    window._currentGpxClickHandler = (e) => {
      if (window._currentGpxPopup) {
        window._currentGpxPopup.remove();
        window._currentGpxPopup = null;
      }

      const box = document.createElement("div");
      box.className = "gpx-popup-box";
      box.style.font = "13px/1.4 system-ui, sans-serif";
      box.innerHTML = `
        <strong style="display:block;font-size:14px;color:#1d2318;margin-bottom:4px">Traccia GPX: ${escapeHtml(fileName)}</strong>
        <div style="color:#5a6350;font-size:12px;margin-bottom:8px">
          <span>Distanza: <strong>${distKm} km</strong></span> ·
          <span>Dislivello: <strong>+${gainM} m</strong></span><br>
          <span>Punti GPS: <strong>${coordinates.length}</strong></span> ·
          <span>Waypoint: <strong>${waypoints.length}</strong></span>
        </div>
        <button type="button" class="gpx-remove-btn" style="width:100%;padding:6px 10px;background:#e63946;color:#fff;border:0;border-radius:4px;cursor:pointer;font-weight:600;font-size:12px">🗑 Rimuovi traccia dalla mappa</button>
      `;

      const popup = new maplibregl.Popup({ offset: 10, maxWidth: "280px" })
        .setLngLat(e.lngLat)
        .setDOMContent(box)
        .addTo(map);

      window._currentGpxPopup = popup;

      box.querySelector(".gpx-remove-btn").addEventListener("click", () => {
        removeGpxTrackFromMap(fileName, lineLayerId, sourceId);
      });
    };

    map.on("mouseenter", lineLayerId, window._currentGpxMouseEnter);
    map.on("mouseleave", lineLayerId, window._currentGpxMouseLeave);
    map.on("click", lineLayerId, window._currentGpxClickHandler);

    // Disegna ed attacca i popup ai Waypoint del file GPX sulla mappa
    window._currentGpxMarkers = [];
    const gpxEntry = { color: "#e63946", name: fileName, pois: waypoints, photos: [], markers: window._currentGpxMarkers };

    waypoints.forEach((wp) => {
      if (window.Media && typeof window.Media.addPoiMarker === "function") {
        window.Media.addPoiMarker(gpxEntry, wp);
      }
    });

    // Adatta lo zoom ed il centro della mappa all'estensione della traccia
    map.fitBounds(bounds, { padding: 50, maxZoom: 16 });
    showToast(`Traccia GPX caricata: ${fileName} (${distKm} km, ${waypoints.length} waypoint)`);
    console.log(`[GPX] Caricata traccia "${fileName}" (${distKm} km) con ${coordinates.length} punti e ${waypoints.length} waypoint.`);
  } catch (err) {
    console.error("[GPX] Errore caricamento file GPX:", err);
    showToast(`Errore GPX: ${err.message}`, true);
  }
}

if (window.desktop && typeof window.desktop.onLoadGpxData === "function") {
  window.desktop.onLoadGpxData(({ fileName, content }) => {
    parseAndRenderGpx(fileName, content);
  });
}

// ---------------------------------------------------------------------------
// Sorgenti/layer delle tracce. setStyle() sostituisce l'intero stile e
// cancella sorgenti/layer custom, quindi vanno ricreati ogni volta —
// per questo questa logica è isolata in una funzione richiamabile.
// ---------------------------------------------------------------------------

function attachRouteLayers() {
  if (!map.getImage("arrow-icon")) {
    map.addImage("arrow-icon", createArrowIcon(), { sdf: true });
  }

  if (!map.getSource("active-routes")) {
    map.addSource("active-routes", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
  }

  if (!map.getLayer("active-routes-line")) {
    map.addLayer({
      id: "active-routes-line",
      type: "line",
      source: "active-routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 4
      }
    });
  }

  if (!map.getLayer("active-routes-direction-halo")) {
    map.addLayer({
      id: "active-routes-direction-halo",
      type: "symbol",
      source: "active-routes",
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 110,
        "icon-image": "arrow-icon",
        "icon-size": 0.85,
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      },
      paint: {
        "icon-color": "#eef0e6",
        "icon-opacity": 0.9
      }
    });
  }

  if (!map.getLayer("active-routes-direction")) {
    map.addLayer({
      id: "active-routes-direction",
      type: "symbol",
      source: "active-routes",
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 110,
        "icon-image": "arrow-icon",
        "icon-size": 0.55,
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      },
      paint: {
        "icon-color": ["get", "color"]
      }
    });
  }

  if (!map.getLayer("active-routes-start")) {
    map.addLayer({
      id: "active-routes-start",
      type: "circle",
      source: "active-routes",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#eef0e6",
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 2.5
      }
    });
  }

  // Interattività al click sulle tracce caricate dal DB
  if (!map._activeRouteEventsAttached) {
    map._activeRouteEventsAttached = true;

    map.on("mouseenter", "active-routes-line", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "active-routes-line", () => { map.getCanvas().style.cursor = ""; });

    map.on("click", "active-routes-line", (e) => {
      if (!e.features || !e.features[0]) return;

      if (window._currentGpxPopup) {
        window._currentGpxPopup.remove();
        window._currentGpxPopup = null;
      }

      const feature = e.features[0];
      const props = feature.properties || {};
      const routeId = Number(props.id);
      const activeObj = state.activeRoutes.get(routeId);
      const meta = activeObj?.meta || props;
      const color = activeObj?.color || props.color || "#c94f4f";
      const name = meta.name || props.name || "Percorso";

      const distKm = meta.distance_km != null ? meta.distance_km : (props.distance_km != null ? props.distance_km : (meta.length_m ? Math.round(meta.length_m / 100) / 10 : 0));
      const durMin = meta.duration_min != null ? meta.duration_min : (props.duration_min != null ? props.duration_min : (meta.duration_total_min != null ? meta.duration_total_min : 0));
      const gainM = meta.elevation_gain_m || props.elevation_gain_m || 0;
      const dateStr = formatDate(meta.date || meta.time_start || props.date || "");

      const box = document.createElement("div");
      box.className = "db-route-popup-box";
      box.style.font = "13px/1.4 system-ui, sans-serif";
      box.innerHTML = `
        <strong style="display:block;font-size:14px;color:#1d2318;margin-bottom:4px">
          <span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:2px;margin-right:6px"></span>
          ${escapeHtml(name)}
        </strong>
        <div style="color:#5a6350;font-size:12px">
          ${dateStr ? `<span>Data: <strong>${dateStr}</strong></span><br>` : ""}
          <span>Distanza: <strong>${formatKm(distKm)}</strong></span> ·
          <span>Durata: <strong>${formatDuration(durMin)}</strong></span>
          ${gainM > 0 ? `<br><span>Dislivello: <strong>+${gainM} m</strong></span>` : ""}
        </div>
      `;

      const popup = new maplibregl.Popup({ offset: 10, maxWidth: "280px" })
        .setLngLat(e.lngLat)
        .setDOMContent(box)
        .addTo(map);

      window._currentGpxPopup = popup;
    });
  }

  // Ridisegna le tracce eventualmente già attive sul nuovo stile
  redrawActiveRoutes();
}

function switchMapStyle(id) {
  const entry = cfg.MAP_STYLES.find(s => s.id === id);
  if (!entry || id === currentStyleId) return;

  clearAreaSearch(); // il rettangolo/markers non sopravvivono a un cambio stile

  currentStyleId = id;
  saveStyleId(id);
  map.once("style.load", () => {
    try {
      attachRouteLayers();
    } catch (err) {
      console.error("Errore nel ridisegnare le tracce dopo il cambio stile:", err);
      showToast("Errore nel ridisegnare le tracce: " + err.message, true);
    }
  });
  map.setStyle(entry.style, { diff: false });

  renderLayersPanel();
}

function renderLayersPanel() {
  if (!els.layersList) return;

  els.layersList.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const entry of cfg.MAP_STYLES) {
    const btn = document.createElement("button");
    btn.className = "layer-option" + (entry.id === currentStyleId ? " active" : "");
    btn.innerHTML = `
      <span class="layer-option-name">${escapeHtml(entry.name)}</span>
      <span class="layer-option-desc">${escapeHtml(entry.description || "")}</span>
    `;
    btn.addEventListener("click", () => switchMapStyle(entry.id));
    frag.appendChild(btn);
  }
  els.layersList.appendChild(frag);
}

els.layersToggle?.addEventListener("click", () => {
  els.layersPanel?.classList.toggle("hidden");
});
els.layersPanelClose?.addEventListener("click", () => {
  els.layersPanel?.classList.add("hidden");
});

// Disegna una freccia triangolare su un canvas, per usarla come icona SDF
// (permette di colorarla a runtime via icon-color, una per traccia).
function createArrowIcon(size = 32) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(size * 0.12, size * 0.18);
  ctx.lineTo(size * 0.90, size * 0.5);
  ctx.lineTo(size * 0.12, size * 0.82);
  ctx.lineTo(size * 0.32, size * 0.5);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadRoutes(q = "") {
  if (cfg.USE_DEMO_DATA) {
    if (!Array.isArray(window.DEMO_ROUTES)) {
      throw new Error('USE_DEMO_DATA è true ma demo-data.js non è caricato (manca il file sul server, o non è incluso in index.html).');
    }
    els.sourceIndicator.textContent = "sorgente: dati demo";
    const all = window.DEMO_ROUTES;
    return q ? all.filter(r => r.name.toLowerCase().includes(q.toLowerCase())) : all;
  }
  els.sourceIndicator.textContent = "sorgente: " + cfg.API_BASE;
  const url = new URL(`${cfg.API_BASE}/routes.php`);
  //const url = new URL(location.origin);
  if (q) url.searchParams.set("q", q);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Errore ${res.status} nel caricare i percorsi`);
  return res.json();
}

async function loadRoutesInArea(bounds) {
  if (cfg.USE_DEMO_DATA) {
    // Demo: nessun endpoint dedicato, filtro lato client sulle geometrie
    const matches = [];
    for (const r of window.DEMO_ROUTES) {
      const feature = await loadRouteGeoJSON(r.id);
      const hit = feature.geometry.coordinates.some(([lon, lat]) =>
        lon >= bounds.minLon && lon <= bounds.maxLon &&
        lat >= bounds.minLat && lat <= bounds.maxLat
      );
      if (hit) matches.push(r);
    }
    return matches;
  }

  const url = new URL(`${cfg.API_BASE}/routes-in-area.php`);
  url.searchParams.set("minLon", bounds.minLon);
  url.searchParams.set("minLat", bounds.minLat);
  url.searchParams.set("maxLon", bounds.maxLon);
  url.searchParams.set("maxLat", bounds.maxLat);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Errore ${res.status} nella ricerca per area`);
  return res.json();
}

async function loadRouteGeoJSON(id) {
  if (state.geojsonCache.has(id)) return state.geojsonCache.get(id);

  let feature;
  if (cfg.USE_DEMO_DATA) {
    feature = window.DEMO_GEOJSON[id];
    if (!feature) throw new Error("Nessuna geometria demo per questo percorso");
  } else {
    const res = await fetch(`${cfg.API_BASE}/geojson.php?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Errore ${res.status} nel caricare la traccia`);
    feature = await res.json();
  }

  state.geojsonCache.set(id, feature);
  return feature;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    state.routes = await loadRoutes();
    renderList(state.routes);
  } catch (err) {
    console.error(err);
    els.list.innerHTML = `<p class="empty">Impossibile caricare i percorsi.<br>${escapeHtml(err.message)}</p>`;
    showToast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

function renderList(routes) {
  state.currentList = routes;
  els.count.textContent = `${routes.length} percors${routes.length === 1 ? "o" : "i"}`;

  if (routes.length === 0) {
    els.list.innerHTML = `<p class="empty">Nessun percorso trovato.</p>`;
    return;
  }

  els.list.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const r of routes) {
    const active = state.activeRoutes.get(r.id);
    const item = document.createElement("div");
    item.className = "route-item" + (active ? " selected" : "");
    item.dataset.id = r.id;
    if (active) item.style.setProperty("--track-color", active.color);

    item.innerHTML = `
      <span class="swatch"></span>
      <span class="item-text">
        <span class="name">${escapeHtml(r.name)}</span>
        <span class="meta">${formatDate(r.date)} · ${formatKm(r.distance_km)} · ${formatDuration(r.duration_min)}</span>
      </span>
    `;

    item.addEventListener("click", () => toggleRoute(r.id));
    frag.appendChild(item);
  }

  els.list.appendChild(frag);
}

// ---------------------------------------------------------------------------
// Selezione multipla delle tracce
// ---------------------------------------------------------------------------

async function toggleRoute(id) {
  if (state.activeRoutes.has(id)) {
    removeRoute(id);
    return;
  }

  const meta = state.routes.find(r => r.id === id) ||
               state.currentList.find(r => r.id === id);

  try {
    const feature = await loadRouteGeoJSON(id);
    const usedColors = new Set([...state.activeRoutes.values()].map(v => v.color));
    const color = assignColor(usedColors);

    state.activeRoutes.set(id, { feature, color, meta });
    window.Media?.add(id, color, meta?.name ?? feature.properties?.name);
    redrawActiveRoutes();
    renderList(state.currentList);
    renderTracksPanel();
    fitToActive();
  } catch (err) {
    console.error(err);
    showToast(err.message, true);
  }
}

function removeRoute(id) {
  state.activeRoutes.delete(id);
  window.Media?.remove(id);
  redrawActiveRoutes();
  renderList(state.currentList);
  renderTracksPanel();
}

function clearAllRoutes() {
  state.activeRoutes.clear();
  window.Media?.clear();
  redrawActiveRoutes();
  renderList(state.currentList);
  renderTracksPanel();
}

function assignColor(usedColors) {
  for (const c of PALETTE) {
    if (!usedColors.has(c)) return c;
  }
  return PALETTE[usedColors.size % PALETTE.length];
}

// ---------------------------------------------------------------------------
// Disegno sulla mappa
// ---------------------------------------------------------------------------

function redrawActiveRoutes() {
  if (!map.getSource("active-routes")) {
    // La sorgente manca (es. persa in un cambio di stile) — la ricreo invece
    // di fallire in silenzio. attachRouteLayers() richiama redrawActiveRoutes
    // al termine, quindi non serve continuare oltre in questa chiamata.
    console.warn("Sorgente active-routes assente, la ricreo.");
    attachRouteLayers();
    return;
  }

  const lineFeatures = [];
  const startFeatures = [];

  for (const [routeId, { feature, color, meta }] of state.activeRoutes.entries()) {
    lineFeatures.push({
      ...feature,
      properties: {
        ...(feature.properties || {}),
        id: routeId,
        color,
        name: meta?.name || feature.properties?.name || "Percorso",
        date: meta?.date || meta?.time_start || "",
        distance_km: meta?.distance_km != null ? meta.distance_km : (meta?.length_m ? Math.round(meta.length_m / 100) / 10 : 0),
        duration_min: meta?.duration_min != null ? meta.duration_min : (meta?.duration_total_min != null ? meta.duration_total_min : 0),
        elevation_gain_m: meta?.elevation_gain_m || 0
      }
    });

    const coords = feature.geometry.coordinates;
    if (coords.length) {
      startFeatures.push({
        type: "Feature",
        properties: { color },
        geometry: { type: "Point", coordinates: coords[0] }
      });
    }
  }

  map.getSource("active-routes").setData({
    type: "FeatureCollection",
    features: [...lineFeatures, ...startFeatures]
  });
}

function fitToActive() {
  const allCoords = [...state.activeRoutes.values()]
    .flatMap(v => v.feature.geometry.coordinates);

  if (allCoords.length === 0) return;

  const bounds = allCoords.reduce(
    (b, c) => b.extend(c),
    new maplibregl.LngLatBounds(allCoords[0], allCoords[0])
  );
  map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 600 });
}

// ---------------------------------------------------------------------------
// Ricerca per area: disegno di un rettangolo trascinando sulla mappa,
// regolabile trascinando i due angoli, poi ricerca dei percorsi che vi
// passano attraverso.
// ---------------------------------------------------------------------------

function ensureAreaSource() {
  if (!map.getSource("search-area")) {
    map.addSource("search-area", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "search-area-fill",
      type: "fill",
      source: "search-area",
      paint: { "fill-color": "#2f6b8e", "fill-opacity": 0.15 }
    });
    map.addLayer({
      id: "search-area-outline",
      type: "line",
      source: "search-area",
      paint: { "line-color": "#2f6b8e", "line-width": 2, "line-dasharray": [2, 2] }
    });
  }
}

function rectangleFeature(a, b) {
  const minLon = Math.min(a.lng, b.lng), maxLon = Math.max(a.lng, b.lng);
  const minLat = Math.min(a.lat, b.lat), maxLat = Math.max(a.lat, b.lat);
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [minLon, minLat], [maxLon, minLat],
        [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]
      ]]
    }
  };
}

function boundsFromCorners(a, b) {
  return {
    minLon: Math.min(a.lng, b.lng), maxLon: Math.max(a.lng, b.lng),
    minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat)
  };
}

function setAreaRectangle(a, b) {
  ensureAreaSource();
  map.getSource("search-area").setData({
    type: "FeatureCollection",
    features: [rectangleFeature(a, b)]
  });
}

function showAreaToolbar(hint, showConfirm) {
  if (!els.areaSearchToolbar) return;
  els.areaSearchToolbar.classList.remove("hidden");
  if (els.areaSearchHint) els.areaSearchHint.textContent = hint;
  els.areaSearchConfirm?.classList.toggle("hidden", !showConfirm);
}
function hideAreaToolbar() {
  els.areaSearchToolbar?.classList.add("hidden");
}

function enterAreaDrawMode() {
  clearAreaSearch();
  state.areaSearch.drawing = true;
  els.areaSearchToggle?.classList.add("active");
  map.dragPan.disable();
  map.getCanvas().style.cursor = "crosshair";
  showAreaToolbar("Trascina sulla mappa per disegnare l'area", false);

  map.once("mousedown", onAreaMouseDown);
}

function onAreaMouseDown(e) {
  if (!state.areaSearch.drawing) return;
  const startLngLat = e.lngLat;
  ensureAreaSource();
  setAreaRectangle(startLngLat, startLngLat);

  const onMove = (ev) => setAreaRectangle(startLngLat, ev.lngLat);
  const onUp = (ev) => {
    map.off("mousemove", onMove);
    finishAreaDraw(startLngLat, ev.lngLat);
  };

  map.on("mousemove", onMove);
  map.once("mouseup", onUp);
}

function finishAreaDraw(cornerA, cornerB) {
  state.areaSearch.drawing = false;
  els.areaSearchToggle?.classList.remove("active");
  map.dragPan.enable();
  map.getCanvas().style.cursor = "";

  const bounds = boundsFromCorners(cornerA, cornerB);

  const swMarker = new maplibregl.Marker({ draggable: true, color: "#2f6b8e" })
    .setLngLat([bounds.minLon, bounds.minLat]).addTo(map);
  const neMarker = new maplibregl.Marker({ draggable: true, color: "#2f6b8e" })
    .setLngLat([bounds.maxLon, bounds.maxLat]).addTo(map);

  const refresh = () => setAreaRectangle(swMarker.getLngLat(), neMarker.getLngLat());
  swMarker.on("drag", refresh);
  neMarker.on("drag", refresh);

  state.areaSearch.corner1 = swMarker;
  state.areaSearch.corner2 = neMarker;

  setAreaRectangle(swMarker.getLngLat(), neMarker.getLngLat());
  showAreaToolbar("Regola l'area trascinando gli angoli, poi conferma", true);
}

function clearAreaSearch() {
  state.areaSearch.drawing = false;
  els.areaSearchToggle?.classList.remove("active");
  map.dragPan.enable();
  map.getCanvas().style.cursor = "";
  state.areaSearch.corner1?.remove();
  state.areaSearch.corner2?.remove();
  state.areaSearch.corner1 = null;
  state.areaSearch.corner2 = null;
  map.getSource("search-area")?.setData({ type: "FeatureCollection", features: [] });
  hideAreaToolbar();
}

async function confirmAreaSearch() {
  if (!state.areaSearch.corner1 || !state.areaSearch.corner2) return;

  const bounds = boundsFromCorners(
    state.areaSearch.corner1.getLngLat(),
    state.areaSearch.corner2.getLngLat()
  );

  hideAreaToolbar();
  showToast("Ricerca percorsi nell'area…");

  try {
    const results = await loadRoutesInArea(bounds);
    applyAreaFilter(results);
  } catch (err) {
    console.error(err);
    showToast(err.message, true);
  }
  clearAreaSearch();
}

function applyAreaFilter(routes) {
  state.areaSearch.filterActive = true;
  els.search.value = "";
  renderList(routes);
  els.areaFilterBanner?.classList.remove("hidden");
  if (els.areaFilterCount) {
    els.areaFilterCount.textContent =
      `${routes.length} percors${routes.length === 1 ? "o" : "i"} nell'area selezionata`;
  }
}

function clearAreaFilter() {
  state.areaSearch.filterActive = false;
  els.areaFilterBanner?.classList.add("hidden");
  renderList(state.routes);
}

els.areaSearchToggle?.addEventListener("click", () => {
  if (state.areaSearch.drawing || state.areaSearch.corner1) {
    clearAreaSearch();
  } else {
    enterAreaDrawMode();
  }
});
els.areaSearchCancel?.addEventListener("click", clearAreaSearch);
els.areaSearchConfirm?.addEventListener("click", confirmAreaSearch);
els.areaFilterClear?.addEventListener("click", clearAreaFilter);

// ---------------------------------------------------------------------------
// Pannello legenda tracce attive
// ---------------------------------------------------------------------------

function renderTracksPanel() {
  if (!els.tracksPanel || !els.tracksList) return;

  if (state.activeRoutes.size === 0) {
    els.tracksPanel.classList.add("hidden");
    els.tracksList.innerHTML = "";
    return;
  }

  els.tracksPanel.classList.remove("hidden");
  els.tracksList.innerHTML = "";

  const frag = document.createDocumentFragment();
  for (const [id, { color, meta, feature }] of state.activeRoutes) {
    const row = document.createElement("div");
    row.className = "track-row";
    row.innerHTML = `
      <span class="swatch" style="background:${color}"></span>
      <span class="track-info">
        <span class="track-name">${escapeHtml(meta?.name ?? feature.properties?.name ?? "Percorso")}</span>
        <span class="track-meta">${meta ? formatKm(meta.distance_km) : ""}</span>
      </span>
      <button class="detail-btn" title="Dettagli e altimetria" aria-label="Dettagli e altimetria">ⓘ</button>
      <button class="download-btn" title="Scarica GPX" aria-label="Scarica GPX">⬇</button>
      <button class="remove-btn" title="Rimuovi dalla mappa" aria-label="Rimuovi">×</button>
    `;
    const trackName = meta?.name ?? feature.properties?.name ?? "percorso";
    row.querySelector(".detail-btn").addEventListener("click", () => openRouteDetail(id));
    row.querySelector(".download-btn").addEventListener("click", () => downloadGPX(feature, trackName));
    row.querySelector(".remove-btn").addEventListener("click", () => removeRoute(id));
    frag.appendChild(row);
  }
  els.tracksList.appendChild(frag);
}

els.clearTracks?.addEventListener("click", clearAllRoutes);

// ---------------------------------------------------------------------------
// Pannello dettagli + profilo altimetrico
// ---------------------------------------------------------------------------

function openRouteDetail(id) {
  const active = state.activeRoutes.get(id);
  if (!active) return;
  const { feature, color, meta } = active;

  if (els.routeModalSwatch) els.routeModalSwatch.style.background = color;
  if (els.routeModalName) els.routeModalName.textContent = meta?.name ?? feature.properties?.name ?? "Percorso";

  if (els.routeModalDesc) {
    const desc = (meta?.description ?? "").trim();
    els.routeModalDesc.textContent = desc;
    els.routeModalDesc.classList.toggle("hidden", desc === "");
  }

  if (els.routeModalStats) els.routeModalStats.innerHTML = buildStatsHTML(meta);
   if (els.routeModalChart) {
     if (window.RouteCharts) RouteCharts.render(els.routeModalChart, feature);
     else els.routeModalChart.innerHTML = buildElevationChartSVG(feature.geometry.coordinates);
   }

  els.routeModal?.classList.remove("hidden");
}

function closeRouteDetail() {
  els.routeModal?.classList.add("hidden");
}

els.routeModalClose?.addEventListener("click", closeRouteDetail);
document.getElementById("route-modal-backdrop")?.addEventListener("click", closeRouteDetail);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeRouteDetail();
    if (state.areaSearch.drawing || state.areaSearch.corner1) clearAreaSearch();
  }
});

function buildStatsHTML(meta) {
  if (!meta) return "";

  const rows = [
    ["Data", formatDate(meta.date)],
    ["Distanza", formatKm(meta.distance_km)],
    ["Durata totale", formatDuration(meta.duration_min)],
    ["Durata in movimento", formatDuration(meta.duration_moving_min)],
    ["Dislivello +", meta.elevation_gain_m != null ? `${meta.elevation_gain_m} m` : "—"],
    ["Dislivello −", meta.elevation_loss_m != null ? `${meta.elevation_loss_m} m` : "—"],
    ["Velocità media", meta.avg_speed_kmh != null ? `${meta.avg_speed_kmh} km/h` : "—"],
    ["FC media", meta.hr_avg != null ? `${meta.hr_avg} bpm` : "—"],
    ["FC massima", meta.hr_max != null ? `${meta.hr_max} bpm` : "—"],
  ];

  return rows
    .map(([label, value]) => `
      <div class="stat-cell">
        <span class="stat-value">${escapeHtml(String(value))}</span>
        <span class="stat-label">${escapeHtml(label)}</span>
      </div>
    `)
    .join("");
}

// Distanza fra due punti lat/lon in km (formula di Haversine).
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function buildElevationChartSVG(coords) {
  const pts = coords
    .filter(c => c.length >= 3 && Number.isFinite(c[2]))
    .map(c => ({ lon: c[0], lat: c[1], ele: c[2] }));

  if (pts.length < 2) {
    return `<p class="chart-empty">Quota non disponibile per questo percorso.</p>`;
  }

  // Cumulative distance lungo la traccia
  let dist = 0;
  const series = [{ d: 0, ele: pts[0].ele }];
  for (let i = 1; i < pts.length; i++) {
    dist += haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    series.push({ d: dist, ele: pts[i].ele });
  }

  const totalDist = series[series.length - 1].d || 1;
  const eles = series.map(p => p.ele);
  let minEle = Math.min(...eles);
  let maxEle = Math.max(...eles);
  if (minEle === maxEle) { minEle -= 10; maxEle += 10; } // evita divisione per zero

  const W = 560, H = 160, padL = 42, padR = 12, padT = 10, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const x = (d) => padL + (d / totalDist) * plotW;
  const y = (ele) => padT + plotH - ((ele - minEle) / (maxEle - minEle)) * plotH;

  const linePoints = series.map(p => `${x(p.d).toFixed(1)},${y(p.ele).toFixed(1)}`).join(" ");
  const areaPoints = `${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} ${linePoints} ${x(totalDist).toFixed(1)},${(padT + plotH).toFixed(1)}`;

  const midEle = Math.round((minEle + maxEle) / 2);

  return `
    <svg viewBox="0 0 ${W} ${H}" class="elevation-svg" preserveAspectRatio="xMidYMid meet">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="chart-axis" />
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" class="chart-axis" />

      <text x="4" y="${padT + 4}" class="chart-label">${Math.round(maxEle)} m</text>
      <text x="4" y="${padT + plotH / 2 + 4}" class="chart-label">${midEle} m</text>
      <text x="4" y="${padT + plotH}" class="chart-label">${Math.round(minEle)} m</text>

      <text x="${padL}" y="${H - 4}" class="chart-label">0 km</text>
      <text x="${padL + plotW}" y="${H - 4}" class="chart-label chart-label-end">${totalDist.toFixed(1)} km</text>

      <polygon points="${areaPoints}" class="chart-area" />
      <polyline points="${linePoints}" class="chart-line" />
    </svg>
  `;
}

// ---------------------------------------------------------------------------
// Esportazione GPX
// ---------------------------------------------------------------------------

function downloadGPX(feature, name) {
  const coords = feature.geometry?.coordinates ?? [];
  if (coords.length === 0) {
    showToast("Nessun punto da esportare per questo percorso", true);
    return;
  }

  const safeName = escapeXml(name || "percorso");
  const trkpts = coords
    .map(([lon, lat, ele]) =>
      ele != null
        ? `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>`
        : `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`
    )
    .join("\n");

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Percorsi Viewer" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${safeName}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugify(name || "percorso")}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function slugify(str) {
  return String(str)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // rimuove accenti
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "percorso";
}

// ---------------------------------------------------------------------------
// Search / filter
// ---------------------------------------------------------------------------

let searchTimer = null;
els.search.addEventListener("input", () => {
  if (state.areaSearch.filterActive) {
    state.areaSearch.filterActive = false;
    els.areaFilterBanner?.classList.add("hidden");
  }
  const q = els.search.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      const results = await loadRoutes(q);
      renderList(results);
    } catch (err) {
      showToast(err.message, true);
    }
  }, 250); // debounce: evita una richiesta per ogni battuta
});

// ---------------------------------------------------------------------------
// "Adatta vista" — inquadra le tracce attualmente visualizzate sulla mappa
// ---------------------------------------------------------------------------

els.fitAll.addEventListener("click", () => {
  if (state.activeRoutes.size === 0) {
    showToast("Seleziona almeno un percorso dalla lista");
    return;
  }
  fitToActive();
});

// ---------------------------------------------------------------------------
// Mostra/nascondi il pannello con l'elenco percorsi
// ---------------------------------------------------------------------------

els.sidebarToggle?.addEventListener("click", () => {
  const collapsed = els.app.classList.toggle("sidebar-collapsed");
  els.sidebarToggle.textContent = collapsed ? "›" : "‹";
  els.sidebarToggle.title = collapsed ? "Mostra elenco percorsi" : "Nascondi elenco percorsi";
});

// MapLibre osserva il resize del contenitore automaticamente, ma un
// map.resize() esplicito a fine transizione evita eventuali artefatti
// di rendering durante l'animazione CSS.
els.sidebar?.addEventListener("transitionend", (e) => {
  if (e.propertyName === "width" || e.propertyName === "height") map.resize();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatKm(km) {
  return km == null ? "—" : `${km.toFixed(1)} km`;
}

function formatDuration(min) {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let toastTimer = null;
function showToast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  els.toast.classList.toggle("error", isError);
  clearTimeout(toastTimer);
  if (!isError) toastTimer = setTimeout(hideToast, 2500);
}
function hideToast() {
  els.toast.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Sincronizzazione con lo smartphone Android (mDNS / HTTP REST)
// ---------------------------------------------------------------------------
window.onAndroidRoutesSynced = function (sentieriFromAndroid) {
  if (!Array.isArray(sentieriFromAndroid) || sentieriFromAndroid.length === 0) {
    showToast("Nessun percorso trovato sullo smartphone Android.");
    return;
  }

  const converted = sentieriFromAndroid.map((s) => ({
    id: s.uuid || String(s.id),
    name: s.Nome || s.nome || "Percorso Android",
    description: s.Descrizione || s.descrizione || "",
    distance_km: s.Lunghezza || s.lunghezza || 0,
    duration_min: Math.round((s.TempoTot || s.tempoTot || 0) / 60),
    duration_moving_min: Math.round((s.TempoInMov || s.tempoInMov || 0) / 60),
    elevation_gain_m: s.Dislivello || s.dislivello || 0,
    elevation_loss_m: s.Discesa || s.discesa || 0,
    avg_speed_kmh: s.MediaVel || s.mediaVel || 0,
    date: s.DataOra || s.dataOra || "",
    hr_avg: s.HrMed || s.hrMed || null,
    hr_max: s.HrMax || s.hrMax || null,
    nPunti: s.nPunti || 0,
  }));

  state.routes = converted;
  renderList(state.routes);
  if (els.sourceIndicator) {
    els.sourceIndicator.textContent = "sorgente: Smartphone Wi-Fi";
  }
  showToast(`Sincronizzati ${converted.length} percorsi dallo smartphone!`);
};
