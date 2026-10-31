// Isolated relay process fixture; disk-backed provider replacement, no env/SDK.
import fs from 'node:fs';
import http from 'node:http';
import { storage } from '../helpers/relay-fixture.mjs';
import { makeQrRelay, PHOTO } from '../helpers/qr-relay-fixture.mjs';
import queue from '../../candidate/pool-queue.cjs';
const providerFile = process.argv[2], store = storage();
const fresh = !fs.existsSync(providerFile);
if (!fresh) {
  for (const [key, bytes] of JSON.parse(fs.readFileSync(providerFile, 'utf8'))) store.objects.set(key, Buffer.from(bytes, 'base64'));
} else {
  // Seed only a fresh provider. A restart must not manufacture a lost photo.
  store.objects.set(PHOTO, Buffer.alloc(32, 7));
  queue.atomicJSON(providerFile, [...store.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')]));
}

const original = store.send.bind(store);
store.send = async command => {
  const result = await original(command);
  if (command.constructor.name === 'PutObjectCommand') {
    queue.atomicJSON(providerFile, [...store.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')]));
    if (command.input.Key.endsWith('/meta.json') && process.argv[5] === 'pause-discovery-ack' && JSON.parse(command.input.Body).layoutVideoKey) {
      process.send({ phase: 'discovery-metadata-durable' }); await new Promise(() => {});
    }
    if (command.input.Key.startsWith('qr-video-wait/') && process.argv[5] === 'pause-ack') {
      process.send({ phase: 'clock-durable' }); await new Promise(() => {});
    }
  }
  return result;
};
let base;
const relay = makeQrRelay(store, { now: () => process.argv[4] ? Number(process.argv[4]) : Date.now(), signR2Url: async key => base + '/object?key=' + encodeURIComponent(key) });
if (fresh) await relay.issue();
let failMetadata = process.argv[3] === 'fail';
store.beforePut = async ({ Key }) => {
  if (Key.endsWith('/meta.json') && process.argv[5] === 'discovery-save-error') throw new Error('Discovery metadata save failure');
  if (Key.endsWith('/meta.json') && failMetadata) { failMetadata = false; throw new Error('Metadata save failure'); }
  if (Key.startsWith('qr-video-wait/') && process.argv[5] === 'pause-clock') {
    process.send({ phase: 'before-clock-write' }); await new Promise(() => {});
  }
};
store.beforeHead = async () => { if (process.argv[5] === 'head-error') throw Object.assign(new Error('Storage unavailable'), { $metadata: { httpStatusCode: 503 } }); };
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
