'use strict';

// Explicit local-only browser test harness. Not imported by the deployed application.
const http = require('node:http');
const fs = require('node:fs');
const { createServer } = require('../server');
const { createHandlers } = require('../lib/handlers');
const { config, memoryStore, providerDouble } = require('./helpers');

const port = 3001;
const testConfig = { ...config, origin: `http://localhost:${port}`, sandbox: true, fiatEnabled: false };
const store = memoryStore();
const provider = providerDouble();
const handlers = Object.fromEntries(Object.entries(createHandlers({ config: testConfig, store, provider })).map(([name, handler]) => [`/api/${name}`, handler]));
const application = createServer({ handlers });
const requestHandler = application.listeners('request')[0];
// Keep browser instrumentation confined to this test process, never public/ or production builds.
const server = http.createServer((req, res) => {
  if (req.url === '/__test/axe.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(require.resolve('axe-core/axe.min.js')));
    return;
  }
  requestHandler(req, res);
});
server.on('error', error => { console.error(error.code); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`TEST FIXTURES ONLY: http://localhost:${port}. No real provider or Redis calls.`));
