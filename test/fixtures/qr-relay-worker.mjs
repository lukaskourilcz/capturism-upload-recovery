// Isolated relay process fixture; disk-backed provider replacement, no env/SDK.
import fs from 'node:fs';
import http from 'node:http';
import { storage } from '../helpers/relay-fixture.mjs';
import { makeQrRelay, PHOTO } from '../helpers/qr-relay-fixture.mjs';
import queue from '../../candidate/pool-queue.cjs';
const providerFile = process.argv[2], store = storage();
if (fs.existsSync(providerFile)) for (const [key, bytes] of JSON.parse(fs.readFileSync(providerFile, 'utf8'))) store.objects.set(key, Buffer.from(bytes, 'base64'));
store.objects.set(PHOTO, Buffer.alloc(32, 7));
if (!fs.existsSync(providerFile)) queue.atomicJSON(providerFile, [...store.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')]));
store.failWrites = process.argv[3] === 'fail' ? 1 : 0;
const original = store.send.bind(store);
store.send = async command => {
  const result = await original(command);
  if (command.constructor.name === 'PutObjectCommand') queue.atomicJSON(providerFile, [...store.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')]));
  return result;
};
let base;
const relay = makeQrRelay(store, { signR2Url: async key => base + '/object?key=' + encodeURIComponent(key) });
const server = http.createServer((req, res) => {
  if (req.url === '/confirm') return relay.handlePhotosReady(req, res);
  if (req.url.startsWith('/download/')) return void relay.handleGetDownload(req, res, req.url.split('/')[2]);
  if (req.url.startsWith('/object?')) {
    const bytes = store.objects.get(new URL(req.url, base).searchParams.get('key'));
    if (bytes) return res.end(bytes);
  }
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; process.send({ port: server.address().port }); });
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
