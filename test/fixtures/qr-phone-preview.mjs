// Local-only browser verification, using actual candidate download handler.
// Synthetic media and storage; no credentials, emails, uploads or cloud calls.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { storage } from '../helpers/relay-fixture.mjs';
import { makeQrRelay, PHOTO, BODY, TOKEN } from '../helpers/qr-relay-fixture.mjs';
const flag = process.argv[2];
if (!flag) throw new Error('Supply local read-failure flag path');
const store = storage();
let base;
let relay = makeQrRelay(store, { signR2Url: async () => base + '/photo.svg' });
await relay.issue(); await relay.confirm(BODY);
relay = makeQrRelay(store, { signR2Url: async () => base + '/photo.svg' });
store.beforeGet = async () => { if (existsSync(flag)) throw new Error('Synthetic cold read outage'); };
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4321'); res.setHeader('Cache-Control', 'no-store');
  res.on('finish', () => console.log(JSON.stringify({ method: req.method, path: req.url, status: res.statusCode, storageWrites: store.writes })));
  if (req.method === 'GET' && req.url === '/api/download/' + TOKEN) return void relay.handleGetDownload(req, res, TOKEN);
  if (req.method === 'GET' && req.url === '/photo.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#ced7d3"/><circle cx="300" cy="280" r="100" fill="#a6b9b4"/><path d="M120 650 Q120 400 300 400 Q480 400 480 650" fill="#a6b9b4"/><text x="300" y="740" text-anchor="middle" font-family="sans-serif" font-size="25" fill="#42594f">Local recovery test</text></svg>');
  }
  res.writeHead(404); res.end();
});
server.listen(4322, '127.0.0.1', () => { base = 'http://127.0.0.1:4322'; console.log('Local synthetic relay ready'); });
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
