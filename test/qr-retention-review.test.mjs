import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { storage, storageCommands } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';
const KEY = `sessions/${TOKEN}/meta.json`;
const PROOF = `qr-expiry/v1/${createHash('sha256').update(TOKEN).digest('hex')}.json`;
const NOW = 2000000;
const legacy = { photoKey: PHOTO, boothId: 'synthetic-booth', createdAt: 1000000, expiresAt: 87400000,
  layoutVideoKey: 'historical/random-layout.mp4', historicalField: 'preserve' };
const options = { now: () => NOW };
const seed = (record = legacy) => { const store = storage(); store.objects.set(KEY, JSON.stringify(record)); return store; };

test('legacy adoption save failure preserves original metadata and cold retry keeps original expiry', async () => {
  const store = seed(), bytes = store.objects.get(KEY), first = makeQrRelay(store, options); store.failWrites = 1;
  assert.equal((await first.download(TOKEN)).status, 503); assert.equal(first.cache.size, 0);
  assert.equal(store.objects.get(KEY), bytes); assert.equal(store.objects.has(PROOF), false);
  const restarted = makeQrRelay(store, options), recovered = await restarted.download(TOKEN);
  assert.equal(recovered.status, 200); assert.equal(Date.parse(recovered.body.expiresAt), legacy.expiresAt);
  assert.equal(store.objects.get(KEY), bytes); assert.equal(store.writes, 2);
});

test('lost legacy proof acknowledgement reconciles after restart without rewriting identity or clock', async () => {
  const store = seed(), bytes = store.objects.get(KEY); let lost = false;
  store.afterPut = async ({ Key }) => { if (Key === PROOF && !lost) { lost = true; throw new Error('Ambiguous proof acknowledgement'); } };
  assert.equal((await makeQrRelay(store, options).download(TOKEN)).status, 503);
  const proof = store.objects.get(PROOF); assert.ok(proof);
  assert.equal((await makeQrRelay(store, options).download(TOKEN)).status, 200);
  assert.equal(store.objects.get(KEY), bytes); assert.equal(store.objects.get(PROOF), proof); assert.equal(store.writes, 2);
});

test('two cold relays adopt legacy metadata once and retain video/history fields', async () => {
  const store = seed(), bytes = store.objects.get(KEY);
  const results = await Promise.all([makeQrRelay(store, options).download(TOKEN), makeQrRelay(store, options).download(TOKEN)]);
  assert.deepEqual(results.map(r => r.status), [200,200]); assert.equal(store.writes, 2);
  const proof = JSON.parse(store.objects.get(PROOF));
  assert.equal(proof.createdAt, legacy.createdAt); assert.equal(proof.expiresAt, legacy.expiresAt);
  assert.equal(store.objects.get(KEY), bytes);
});

test('legacy noncanonical photo keys still permit video signing and replay with original identity', async () => {
  const original = { ...legacy, photoKey: 'historical/photo-from-another-prefix.jpeg' }, store = seed(original);
  const relay = makeQrRelay(store, options);
  assert.equal((await relay.sign({ token: TOKEN, kind: 'video', contentType: 'video/mp4' })).status, 200);
  assert.equal((await relay.confirm({ ...BODY, photoKey: original.photoKey })).status, 200);
  assert.deepEqual(JSON.parse(store.objects.get(KEY)), original);
  assert.equal((await relay.sign({ token: TOKEN, kind: 'photo', contentType: 'image/jpeg' })).status, 409);
  assert.equal(store.writes, 2);
});

test('unreadable existing expiry proof is never interpreted as missing legacy authority', async () => {
  const store = seed(), warm = makeQrRelay(store, options); await warm.download(TOKEN);
  const proof = store.objects.get(PROOF), bytes = store.objects.get(KEY), writes = store.writes;
  store.beforeGet = async ({ Key }) => { if (Key === PROOF) throw new Error('Proof read unavailable'); };
  const cold = makeQrRelay(store, options); assert.equal((await cold.download(TOKEN)).status, 503);
  assert.equal((await cold.confirm(BODY)).status, 503); assert.equal(cold.cache.size, 0);
  store.beforeGet = null; assert.equal((await cold.download(TOKEN)).status, 200);
  assert.equal(store.writes, writes); assert.equal(store.objects.get(PROOF), proof); assert.equal(store.objects.get(KEY), bytes);
});

test('backup review: actual pool snapshot omits QR proof but its pruner preserves the live prefix', async () => {
  const source = await readFile(new URL('../../diagnosis-2026-10-30/capturism-main/capturism-relay/backup.js', import.meta.url), 'utf8');
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  class CopyObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  const objects = new Map([[PROOF, 'proof'], ['pool/example.json', 'pool'], ['pool-portraits/example.jpg','photo'], ['pool-deletions/example.json','fence'], ['backups/pool/2000-01-01/qr-expiry/v1/old.json','old snapshot']]);
  const requests = [], module = { exports: {} };
  const client = { async send(command) {
    const input = command.input; requests.push({ operation: command.constructor.name, ...input });
    if (command instanceof ListObjectsV2Command) return { Contents: [...objects.keys()].filter(k => k.startsWith(input.Prefix)).map(Key => ({ Key })) };
    if (command instanceof CopyObjectCommand) { objects.set(input.Key, objects.get(decodeURIComponent(input.CopySource).slice('isolated/'.length))); return {}; }
    if (command instanceof DeleteObjectCommand) { objects.delete(input.Key); return {}; }
    if (command instanceof storageCommands.PutObjectCommand) { objects.set(input.Key, input.Body); return {}; }
    throw new Error('Unexpected backup request');
  } };
  vm.runInNewContext(source + '\nmodule.exports.configureForReview = (client, bucket) => { r2Client = client; R2_BUCKET = bucket; };', {
    module, process: { env: {} }, console: { log() {}, error() {} }, Buffer, Date,
    require: name => { assert.equal(name, '@aws-sdk/client-s3'); return { ...storageCommands, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand }; },
  });
  module.exports.configureForReview(client, 'isolated'); await module.exports.runBackup();
  assert.equal(objects.get(PROOF), 'proof');
  assert.equal(requests.some(r => r.operation === 'CopyObjectCommand' && decodeURIComponent(r.CopySource).includes('qr-expiry/')), false);
  assert.equal(objects.has('backups/pool/2000-01-01/qr-expiry/v1/old.json'), false);
  assert.equal(requests.filter(r => r.operation === 'DeleteObjectCommand').every(r => r.Key.startsWith('backups/pool/')), true);
  assert.equal(requests.filter(r => r.operation === 'CopyObjectCommand').length, 3);
});
