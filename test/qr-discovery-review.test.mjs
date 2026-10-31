import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, BODY } from './helpers/qr-relay-fixture.mjs';
const META = `sessions/${TOKEN}/meta.json`;

test('actual video discovery treats confirmed absence as pending before grace and failed at its boundary', async () => {
  const store = storage(); let clock = 1000000;
  const relay = makeQrRelay(store, { now: () => clock }); await relay.issue(); await relay.confirm({ ...BODY, videosPending: true });
  const metadata = store.objects.get(META), writes = store.writes;
  clock += 599999; const before = await relay.download(TOKEN); assert.equal(before.status, 200);
  assert.equal(before.body.videoPending, true); assert.equal(before.body.videoFailed, false);
  clock++; const exact = await relay.download(TOKEN); assert.equal(exact.status, 200);
  assert.equal(exact.body.videoPending, false); assert.equal(exact.body.videoFailed, true);
  assert.equal(store.objects.get(META), metadata); assert.equal(store.writes, writes);
});

test('actual orphan discovery persists found media and retains its original video clock and expiry after restart', async () => {
  const store = storage(); let clock = 1000000;
  const options = { now: () => clock }, relay = makeQrRelay(store, options); await relay.issue();
  clock += 540000; await relay.confirm({ ...BODY, videosPending: true });
  const original = JSON.parse(store.objects.get(META)); clock += 120000;
  const key = `sessions/${TOKEN}/layout.mp4`; store.objects.set(key, Buffer.alloc(16, 9));
  const response = await relay.download(TOKEN); assert.equal(response.status, 200); assert.ok(response.body.layoutVideoUrl);
  assert.equal(response.body.videoPending, false); assert.equal(response.body.videoFailed, false);
  const committed = JSON.parse(store.objects.get(META)); assert.equal(committed.layoutVideoKey, key);
  assert.equal(committed.videoWaitStartedAt, original.videoWaitStartedAt); assert.equal(committed.expiresAt, original.expiresAt);
  const cold = await makeQrRelay(store, options).download(TOKEN); assert.equal(cold.body.layoutVideoUrl, response.body.layoutVideoUrl);
});
