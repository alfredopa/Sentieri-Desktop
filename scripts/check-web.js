'use strict';
// Controlla che nella cartella web ci siano tutti i file della webapp prima di creare l'installatore.
const fs = require('node:fs');
const path = require('node:path');

const web = path.join(__dirname, '..', 'web');
const needed = ['index.html', 'app.js', 'config.js', 'media.js', 'media.css', 'charts.js', 'charts.css',
  'desktop.js', 'desktop.css', 'style.css', '4mori.png',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/pmtiles.js'];
const missing = needed.filter((f) => !fs.existsSync(path.join(web, f)));

if (missing.length) {
  console.error('\nMancano questi file nella cartella "web":\n  - ' + missing.join('\n  - '));
  console.error('\nstyle.css e 4mori.png vanno copiati dalla cartella "sentieri" del NAS (vedi LEGGIMI.md).\n');
  process.exit(1);
}
console.log('Cartella web completa.');
