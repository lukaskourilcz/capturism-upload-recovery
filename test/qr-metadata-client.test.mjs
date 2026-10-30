import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO } from './helpers/qr-relay-fixture.mjs';

test('real QR client retains its checkpoint until actual relay metadata is durable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capturism-qr-metadata-client-')), nativeFetch = global.fetch;
  const file = join(root, 'client.mjs');
  await build({ stdin: { contents: `export * from './candidate/capturism-app/src/lib/relayUpload';
    export * from './candidate/capturism-app/src/lib/qrUploadState';
    export { resetSession } from './src/adapters';`, resolveDir: resolve('.') }, outfile: file, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'local-adapters', setup(b) {
      b.onResolve({ filter: /^(\.\/boothRelay|\.\.\/store\/sessionStore)$/ }, () => ({ path: resolve('src/adapters.ts') }));
    } }] });
  let base, relay, store, counts, statuses;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/relay/configured' || req.url === '/api/diagnostics') { req.resume(); return res.end(JSON.stringify({ configured: true })); }
    if (req.url === '/api/relay/sign-upload') {
      req.resume(); counts.sign++; return res.end(JSON.stringify({ token: TOKEN, key: PHOTO, uploadUrl: base + '/put' }));
    }
    if (req.url === '/put') {
      counts.put++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
      store.objects.set(PHOTO, Buffer.concat(chunks)); return res.end('{}');
    }
    if (req.url === '/api/relay/photos-ready') {
      counts.confirm++; res.on('finish', () => statuses.push(res.statusCode));
      return relay.handlePhotosReady(req, res);
    }
    if (req.url.startsWith('/download/')) return void relay.handleGetDownload(req, res, TOKEN);
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = (url, init) => { const target = new URL(url, base); assert.equal(target.origin, base); return nativeFetch(target, init); };
  const client = await import(pathToFileURL(file));
  const photo = new Blob([new Uint8Array(16384)], { type: 'image/jpeg' });
  try {
    for (const scenario of ['save-failure', 'lost-storage-ack', 'deadline-then-manual-recovery']) await t.test(scenario, async () => {
      store = storage(); relay = makeQrRelay(store); counts = { sign: 0, put: 0, confirm: 0 }; statuses = [];
      const metadataKey = `sessions/${TOKEN}/meta.json`;
      if (scenario === 'save-failure') store.failWrites = 1;
      if (scenario === 'lost-storage-ack') {
        let once = false;
        store.afterPut = async () => { if (!once) { once = true; throw new Error('Lost provider ACK'); } };
      }
      if (scenario === 'deadline-then-manual-recovery') {
        store.failWrites = 10;
        await assert.rejects(client.uploadSessionToCloud({ photo, retryForMs: 200 }), { name: 'UploadDeadlineError' });
        assert.equal(client.getQrUploadState().phase, 'failed'); assert.equal(client.getQrUploadState().canRetry, true);
        assert.equal(store.objects.has(metadataKey), false); assert.equal(relay.cache.size, 0); assert.equal(relay.notifications.length, 0);
        store.failWrites = 0; assert.equal(await client.retryQrUpload(), TOKEN);
      } else assert.equal(await client.uploadSessionToCloud({ photo, retryForMs: 5000 }), TOKEN);
      assert.deepEqual(statuses, [503,200]); assert.equal(counts.sign, 1); assert.equal(counts.put, 1); assert.equal(counts.confirm, 2);
      assert.equal(store.writes, 1); assert.equal(relay.notifications.length, 1);
      const originalMetadata = store.objects.get(metadataKey), originalPhoto = store.objects.get(PHOTO);
      relay = makeQrRelay(store); // Relay loses all cache, provider state remains.
      const download = await nativeFetch(base + '/download/' + TOKEN); assert.equal(download.status, 200); await download.text();
      assert.equal(store.objects.get(metadataKey), originalMetadata); assert.equal(store.objects.get(PHOTO), originalPhoto);
      assert.equal(originalPhoto.length, photo.size); client.resetSession();
    });
  } finally { global.fetch = nativeFetch; server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); }
});
