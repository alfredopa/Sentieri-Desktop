'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Funzioni che la pagina può usare (solo quelle elencate qui).
contextBridge.exposeInMainWorld('desktop', {
  openDatabaseDialog: () => ipcRenderer.invoke('open-db-dialog'),
  openDatabasePath: (file) => ipcRenderer.invoke('open-db-path', file),
  pathForFile: (file) => webUtils.getPathForFile(file),
  findAndroidDevice: (options) => ipcRenderer.invoke('find-android-device', options),
  syncFetchAndroidData: (options) => ipcRenderer.invoke('sync-fetch-android-data', options),
  syncPushToAndroid: (options) => ipcRenderer.invoke('sync-push-to-android', options),
});
