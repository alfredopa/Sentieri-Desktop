'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Impostazioni salvate in un file JSON (cartelle scelte, ultimo database aperto).
function createSettings(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* primo avvio */ }
  return {
    get: (key, fallback) => (data[key] ?? fallback),
    set(key, value) {
      if (value === undefined || value === null || value === '') delete data[key];
      else data[key] = value;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch (err) {
        console.error('Impossibile salvare le impostazioni:', err.message);
      }
    },
  };
}

module.exports = { createSettings };
