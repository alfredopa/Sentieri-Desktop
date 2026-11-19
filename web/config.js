// ---------------------------------------------------------------------------
// Configurazione dell'app. Modifica questo file per puntare al tuo backend.
// ---------------------------------------------------------------------------
window.APP_CONFIG = {

  // Se true, l'app usa i dati di esempio in demo-data.js invece di chiamare
  // un'API. Utile per verificare subito che la webapp funzioni, prima di
  // avere il backend sul NAS pronto.
  USE_DEMO_DATA: false,

  // URL base dell'API PHP sul NAS (cartella nas-api/, servita dal Web Server
  // di QNAP). Endpoint attesi, vedi README.md:
  //   GET {API_BASE}/routes.php            -> elenco percorsi
  //   GET {API_BASE}/routes.php?q=nome     -> elenco filtrato per nome
  //   GET {API_BASE}/geojson.php?id=3      -> geometria del percorso (GeoJSON)
  API_BASE: location.origin,

  // Stili mappa selezionabili dal pannello "Livelli mappa" (icona in alto a
  // destra). Tutti tile raster pubblici, gratuiti, senza chiave API — quindi
  // solo per sviluppo/uso personale leggero (rispetta la tile usage policy
  // di ciascun fornitore). Per un uso più intenso, valuta di servire tu le
  // tile dal NAS con tileserver-gl (coerente con l'esplorazione già fatta
  // con OpenHikingMap/MBTiles). Il primo della lista è quello di default.
  MAP_STYLES: [
    {
      id: "osm",
      name: "OpenStreetMap",
      description: "Stile standard",
      style: {
        version: 8,
        sources: {
          base: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "&copy; OpenStreetMap contributors"
          }
        },
        layers: [{ id: "base", type: "raster", source: "base" }]
      }
    },
    {
      id: "opentopo",
      name: "OpenTopoMap",
      description: "Curve di livello e sentieri — ideale per escursionismo",
      style: {
        version: 8,
        sources: {
          base: {
            type: "raster",
            tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)"
          }
        },
        layers: [{ id: "base", type: "raster", source: "base" }]
      }
    },
    {
      id: "cyclosm",
      name: "CyclOSM",
      description: "Mappa ciclabile, buona anche per tracciati misti",
      style: {
        version: 8,
        sources: {
          base: {
            type: "raster",
            tiles: ["https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "&copy; OpenStreetMap contributors, Style: CyclOSM"
          }
        },
        layers: [{ id: "base", type: "raster", source: "base" }]
      }
    },
    {
      id: "hot",
      name: "Humanitarian",
      description: "Stile HOT, alto contrasto su edifici e strade",
      style: {
        version: 8,
        sources: {
          base: {
            type: "raster",
            tiles: ["https://tile-a.openstreetmap.fr/hot/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "&copy; OpenStreetMap contributors, Tiles style by Humanitarian OpenStreetMap Team"
          }
        },
        layers: [{ id: "base", type: "raster", source: "base" }]
      }
    },
    {
      // Livello offline: legge un file .pmtiles servito staticamente dal NAS
      // (nessun tile server necessario). Converti il tuo MBTiles una volta
      // con il tool "pmtiles" (https://github.com/protomaps/go-pmtiles):
      //   pmtiles convert input.mbtiles output.pmtiles
      // poi carica output.pmtiles in una cartella del Web Server QNAP e
      // sostituisci l'URL sotto con quello reale.
      id: "FreemapSk",
      name: "FreemapSk",
      description: "Mappa FreemapSk Offline",
      style: {
        version: 8,
        sources: {
          base: {
            type: "raster",
			tiles: ["mbtiles://FreemapSk.mbtiles/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "Tile offline"
          }
        },
        layers: [{ id: "base", type: "raster", source: "base" }]
      }
    },
	 {
      // Livello offline: legge un file .pmtiles servito staticamente dal NAS
      // (nessun tile server necessario). Converti il tuo MBTiles una volta
      // con il tool "pmtiles" (https://github.com/protomaps/go-pmtiles):
      //   pmtiles convert input.mbtiles output.pmtiles
      // poi carica output.pmtiles in una cartella del Web Server QNAP e
      // sostituisci l'URL sotto con quello reale.
      id: "DBGT",
      name: "DBGT",
      description: "DBGT Regione Sardegna",
      style: {
        version: 8,
        sources: {
          base: {
            type: "raster",
            url: "pmtiles://" + location.origin + "/tiles/DBGT.pmtiles",
            tileSize: 256,
            attribution: "Tile offline"
          }
        },
        layers: [{ id: "base", type: "raster", source: "base" }]
      }
    },
	 {
      // Livello offline: legge un file .pmtiles servito staticamente dal NAS
      // (nessun tile server necessario). Converti il tuo MBTiles una volta
      // con il tool "pmtiles" (https://github.com/protomaps/go-pmtiles):
      //   pmtiles convert input.mbtiles output.pmtiles
      // poi carica output.pmtiles in una cartella del Web Server QNAP e
      // sostituisci l'URL sotto con quello reale.
      id: "ortofoto",
      name: "Ortofoto",
      description: "Ortofoto Regione Sardegna",
      style: {
        version: 8,
        sources: {
          base: {
            type: "raster",
            url: "pmtiles://" + location.origin + "/tiles/ortofoto.pmtiles",
            tileSize: 256,
            attribution: "Tile offline"
          }
        },
        layers: [{ id: "base", type: "raster", source: "base" }]
      }
    }
  ],

  // Vista iniziale della mappa (Sardegna come default, cambiala pure).
  INITIAL_CENTER: [9.11, 39.22],
  INITIAL_ZOOM: 9,

  // Colore/spessore della traccia disegnata sulla mappa.
  TRACK_COLOR: "#b8672f",
  TRACK_COLOR_ACTIVE: "#e08a3e"
};
