'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Funzioni che la pagina web può usare per interagire con Electron.
contextBridge.exposeInMainWorld('desktop', {
  openDatabaseDialog: () => ipcRenderer.invoke('open-db-dialog'),
  openDatabasePath: (file) => ipcRenderer.invoke('open-db-path', file),
  pathForFile: (file) => webUtils.getPathForFile(file),

  // Ricezione file MBTiles dal menu o dialog
  onLoadMbtilesFile: (cb) => ipcRenderer.on('mbtiles:load-file', (_e, filePath) => cb(filePath)),
  onLoadMbtiles: (cb) => ipcRenderer.on('mbtiles:load', (_e, path) => cb(path)),
  pickMbtiles: () => ipcRenderer.invoke('mbtiles:pick'),

  // Ricezione contenuto traccia GPX dal menu o dialog
  onLoadGpxData: (cb) => ipcRenderer.on('gpx:load-data', (_e, data) => cb(data)),

  // Sincronizzazione con lo smartphone Android via mDNS / HTTP REST
  findAndroidDevice: (options) => ipcRenderer.invoke('find-android-device', options),
  syncFetchAndroidData: (options) => ipcRenderer.invoke('sync-fetch-android-data', options),
  syncPushToAndroid: (options) => ipcRenderer.invoke('sync-push-to-android', options),
});
