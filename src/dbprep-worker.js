'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { prepareDatabase } = require('./dbprep');

try {
  const work = prepareDatabase({
    src: workerData.src,
    workDir: workerData.workDir,
    progress: (message) => parentPort.postMessage({ type: 'progress', message }),
  });
  parentPort.postMessage({ type: 'done', work });
} catch (err) {
  const text = /not a database|malformed|encrypted/i.test(err.message)
    ? 'Il file scelto non è un database SQLite valido.'
    : err.message;
  parentPort.postMessage({ type: 'error', message: text });
}
