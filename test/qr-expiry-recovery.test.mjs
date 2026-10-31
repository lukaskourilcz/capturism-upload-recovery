import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';
const KEY = `sessions/${TOKEN}/meta.json`;
const EXPIRY = `qr-expiry/v1/${createHash('sha256').update(TOKEN).digest('hex')}.json`;
const record = store => JSON.parse(store.objects.get(KEY));

test('expired QR cannot be renewed after metadata cleanup, replay, re-sign or cold restart', async () => {
  const store = storage(); let clock = 1000000;
  const options = { now: () => clock }, first = makeQrRelay(store, options);
  await first.issue(); await first.confirm(BODY); store.objects.set(PHOTO, Buffer.alloc(32, 7));
  const original = record(store), proof = store.objects.get(EXPIRY); clock = original.expiresAt;
  store.objects.delete(KEY);
  for (const relay of [first, makeQrRelay(store, options)]) {
    assert.equal((await relay.confirm(BODY)).status, 410);
    assert.equal((await relay.sign({ token: TOKEN, kind: 'photo', contentType: 'image/jpeg' })).status, 410);
    assert.equal((await relay.sign({ token: TOKEN, kind: 'video', contentType: 'video/mp4' })).status, 410);
    await assert.rejects(relay.patchSession(TOKEN, { videoKey: `sessions/${TOKEN}/video.mp4` }), e => e.status === 410);
    assert.equal((await relay.download(TOKEN)).status, 404);
  }
  assert.equal(store.objects.has(KEY), false); assert.equal(store.objects.get(EXPIRY), proof); assert.equal(store.objects.has(PHOTO), true);
});

test('metadata recovery before expiry retains issuance clock and expires at the original boundary', async () => {
  const store = storage(); let clock = 1000000;
  const options = { now: () => clock }, first = makeQrRelay(store, options); await first.issue();
  clock += 120000; await first.confirm(BODY); const original = record(store);
  assert.equal(original.createdAt, 1000000); assert.equal(original.expiresAt, 87400000);
  store.objects.delete(KEY); clock += 300000;
  const cold = makeQrRelay(store, options); assert.equal((await cold.confirm(BODY)).status, 200);
  assert.deepEqual(record(store), original);
  clock = original.expiresAt; assert.equal((await cold.download(TOKEN)).status, 404);
  assert.equal((await makeQrRelay(store, options).confirm(BODY)).status, 410);
});

test('unknown tokens and partial restores without expiry or metadata cannot establish a new clock', async () => {
  const store = storage(), relay = makeQrRelay(store);
  assert.equal((await relay.confirm(BODY)).status, 410);
  assert.equal((await relay.sign({ token: TOKEN, kind: 'photo', contentType: 'image/jpeg' })).status, 410);
  await relay.issue(); await relay.confirm(BODY); store.objects.delete(EXPIRY); store.objects.delete(KEY);
  const cold = makeQrRelay(store);
  assert.equal((await cold.confirm(BODY)).status, 410);
  assert.equal((await cold.sign({ token: TOKEN, kind: 'photo', contentType: 'image/jpeg' })).status, 410);
  assert.equal(store.objects.size, 0);
});

test('legacy metadata is anchored with its exact original identity and clocks before recovery', async () => {
  const store = storage(); let clock = 2000000;
  const old = { photoKey: PHOTO, boothId: 'synthetic-booth', createdAt: 1000000, expiresAt: 87400000, storyVideoKey: 'legacy/story.mp4' };
  store.objects.set(KEY, JSON.stringify(old)); const relay = makeQrRelay(store, { now: () => clock });
  assert.equal((await relay.download(TOKEN)).status, 200);
  const proof = JSON.parse(store.objects.get(EXPIRY)); assert.equal(proof.createdAt, old.createdAt); assert.equal(proof.expiresAt, old.expiresAt);
  assert.deepEqual(record(store), old);
  clock = old.expiresAt + 1; store.objects.delete(KEY);
  assert.equal((await makeQrRelay(store, { now: () => clock }).confirm(BODY)).status, 410);
});

test('signing persists proof first; failures grant no capability and altered identities cannot re-sign', async () => {
  const store = storage(), relay = makeQrRelay(store); store.failWrites = 1;
  assert.equal((await relay.sign({ kind: 'photo', contentType: 'image/jpeg' })).status, 503);
  assert.equal(store.objects.size, 0);
  const signed = await relay.sign({ kind: 'photo', contentType: 'image/jpeg' }); assert.equal(signed.status, 200);
  assert.equal(store.objects.size, 1); assert.ok([...store.objects.keys()][0].startsWith('qr-expiry/v1/'));
  assert.equal((await relay.confirm({ token: signed.body.token, photoKey: signed.body.key })).status, 200);
  assert.equal((await relay.sign({ token: signed.body.token, kind: 'video', contentType: 'video/mp4' })).status, 200);
  assert.equal((await relay.sign({ token: signed.body.token, kind: 'photo', contentType: 'image/png' })).status, 409);
  const another = makeQrRelay(store, { boothId: 'other-booth' });
  assert.equal((await another.sign({ token: signed.body.token, kind: 'photo', contentType: 'image/jpeg' })).status, 409);
});

test('concurrent expiry creation and lost proof acknowledgement never renew retention', async () => {
  const store = storage(); let clock = 1000000;
  const options = { now: () => clock }, first = makeQrRelay(store, options), second = makeQrRelay(store, options);
  await Promise.all([first.issue(), second.issue()]); assert.equal(store.writes, 1);
  const original = store.objects.get(EXPIRY); clock += 100000; await second.issue(); assert.equal(store.objects.get(EXPIRY), original);
  const other = storage(), relay = makeQrRelay(other, options); let once = false;
  other.afterPut = async () => { if (!once) { once = true; throw new Error('ACK lost'); } };
  await assert.rejects(relay.issue()); const proof = other.objects.get(EXPIRY); clock += 100000;
  await relay.issue(); assert.equal(other.objects.get(EXPIRY), proof); assert.equal(other.writes, 1);
});

test('cold transient reads return retryable 503 then recover without rewriting or extending QR', async () => {
  const store = storage(), warm = makeQrRelay(store); await warm.issue(); await warm.confirm(BODY);
  const old = store.objects.get(KEY), proof = store.objects.get(EXPIRY), writes = store.writes;
  store.beforeGet = async () => { throw new Error('Transient read failure'); };
  assert.equal((await warm.download(TOKEN)).status, 200);
  const cold = makeQrRelay(store), failure = await cold.download(TOKEN);
  assert.equal(failure.status, 503); assert.equal(failure.body.retryable, true); assert.equal(cold.cache.size, 0);
  store.beforeGet = null; assert.equal((await cold.download(TOKEN)).status, 200);
  assert.equal(store.objects.get(KEY), old); assert.equal(store.objects.get(EXPIRY), proof); assert.equal(store.writes, writes);
});

test('corrupt expiry or altered stored clocks fail closed with retryable read errors', async () => {
  const store = storage(), relay = makeQrRelay(store); await relay.issue(); await relay.confirm(BODY);
  const old = record(store); store.objects.set(KEY, JSON.stringify({ ...old, expiresAt: old.expiresAt + 10000 }));
  assert.equal((await makeQrRelay(store).download(TOKEN)).status, 503);
  assert.equal((await makeQrRelay(store).confirm(BODY)).status, 503);
  store.objects.set(KEY, JSON.stringify(old)); store.objects.set(EXPIRY, '{}');
  assert.equal((await makeQrRelay(store).download(TOKEN)).status, 503);
  assert.equal((await makeQrRelay(store).confirm(BODY)).status, 503);
});


test('asset proxy and subscription fail safely on cold session reads before any side effects', async () => {
  const store = storage(), relay = makeQrRelay(store); await relay.issue(); await relay.confirm(BODY);
  const writes = store.writes; store.beforeGet = async () => { throw new Error('Read outage'); };
  const cold = makeQrRelay(store);
  const proxy = await new Promise((resolve, reject) => { void cold.handleProxyAsset({}, { resolve }, TOKEN, 'photo').catch(reject); });
  assert.equal(proxy.status, 503); assert.equal(proxy.body.retryable, true);
  const subscription = await new Promise((resolve, reject) => cold.handleSubscribe({ body: { token: TOKEN, email: 'synthetic@example.invalid' }, fail: reject }, { resolve }));
  assert.equal(subscription.status, 503); assert.equal(subscription.body.retryable, true);
  assert.equal(store.writes, writes); assert.equal(cold.notifications.length, 0);
});


test('malformed download tokens remain terminal invalid links rather than storage outages', async () => {
  const relay = makeQrRelay(storage()); assert.equal((await relay.download('../invalid')).status, 404);
});
