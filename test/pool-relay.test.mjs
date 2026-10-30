import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { makeRelay, storage, call, identity, photo, upload, uploadId } from './helpers/relay-fixture.mjs';
const tick = () => new Promise(r => setTimeout(r, 1));
async function waitFor(check) { const end = Date.now() + 3000; while (Date.now() < end) { if (check()) return; await tick(); } throw new Error('Expected state not reached'); }
const key = `pool/${uploadId()}.json`, portraitKey = `pool-portraits/${uploadId()}.jpg`;

test('protocol 2 concurrent publication and replay commit one immutable portrait', async () => {
  const store = storage(), relay = makeRelay(store);
  for (const result of await Promise.all([upload(relay), upload(relay)])) assert.equal(result.status, 200);
  assert.equal((await upload(relay)).status, 200);
  assert.equal(store.objects.size, 2); assert.equal(store.writes, 3);
  assert.deepEqual(store.objects.get(portraitKey), photo);
  const changed = Buffer.alloc(photo.length, 9), changedId = { ...identity, photoDigest: crypto.createHash('sha256').update(changed).digest('hex') };
  assert.equal((await upload(relay, changedId, changed)).status, 409);
  assert.equal((await upload(relay, identity, changed)).status, 200); // declared digest already committed; body ignored
  assert.deepEqual(store.objects.get(portraitKey), photo);
  assert.equal((await upload(relay, { ...identity, seed: true })).status, 409);
});

test('failed publication save is retryable and does not overwrite already-written pixels', async () => {
  const store = storage(), relay = makeRelay(store); let failed = false;
  store.beforePut = async request => {
    if (request.Key === key && JSON.parse(request.Body).status === 'active' && !failed) { failed = true; throw new Error('Injected failed publication'); }
  };
  assert.equal((await upload(relay)).status, 503);
  assert.equal(JSON.parse(store.objects.get(key)).status, 'pending');
  assert.equal((await upload(relay)).status, 200);
  assert.equal(store.writes, 3); assert.deepEqual(store.objects.get(portraitKey), photo);
});

test('replay after restart preserves published distributions and consent', async () => {
  const store = storage(), first = makeRelay(store); await upload(first);
  const saved = JSON.parse(store.objects.get(key)); saved.distributionCount = 3; saved.status = 'retired';
  store.objects.set(key, JSON.stringify(saved));
  assert.equal((await upload(makeRelay(store))).status, 200);
  assert.equal(store.writes, 3); assert.equal(JSON.parse(store.objects.get(key)).distributionCount, 3);
});

test('withdrawal permanently scrubs entry and blocks replay and restart recovery', async () => {
  const store = storage(), relay = makeRelay(store); await upload(relay);
  assert.equal((await call(relay, 'handleAdminDelete', { entryId: uploadId() })).status, 200);
  const tombstone = JSON.parse(store.objects.get(key));
  assert.equal(tombstone.status, 'withdrawn'); assert.equal(tombstone.firstName, undefined); assert.equal(tombstone.sessionId, undefined);
  assert.equal(store.objects.has(portraitKey), false);
  assert.equal((await upload(relay)).status, 410);
  assert.equal((await upload(makeRelay(store))).status, 410);
  assert.equal(store.objects.has(portraitKey), false); assert.equal(JSON.parse(store.objects.get(key)).status, 'withdrawn');
});

test('withdrawal during incoming upload fences subsequent publication', async () => {
  const store = storage(), relay = makeRelay(store), request = new PassThrough();
  request.headers = { 'x-pool-upload': Buffer.from(JSON.stringify(identity)).toString('base64') };
  const completed = new Promise(resolve => { void relay.handlePoolUpload(request, { resolve }, 'test-booth'); });
  await waitFor(() => store.objects.has(key));
  assert.equal((await call(relay, 'handleAdminDelete', { entryId: uploadId() })).status, 200);
  request.end(photo);
  assert.equal((await completed).status, 410); assert.equal(store.objects.has(portraitKey), false);
});

test('withdrawal racing a publication waits, then removes every published byte', async () => {
  const store = storage(), relay = makeRelay(store); let release, reached = false;
  const blocked = new Promise(r => { release = r; });
  store.beforePut = async request => { if (request.Key === key && JSON.parse(request.Body).status === 'active') { reached = true; await blocked; } };
  const publishing = upload(relay); await waitFor(() => reached);
  const deleting = call(relay, 'handleAdminDelete', { entryId: uploadId() });
  release(); assert.equal((await publishing).status, 200); assert.equal((await deleting).status, 200);
  assert.equal(store.objects.has(portraitKey), false); assert.equal((await upload(relay)).status, 410);
});

test('cross-relay stale publication cannot replace a withdrawal tombstone', async () => {
  const store = storage(), first = makeRelay(store), second = makeRelay(store); let release, reached = false;
  const blocked = new Promise(r => { release = r; });
  store.beforePut = async request => { if (request.Key === key && JSON.parse(request.Body).status === 'active') { reached = true; await blocked; } };
  const publishing = upload(first); await waitFor(() => reached);
  assert.equal((await call(second, 'handleAdminDelete', { entryId: uploadId() })).status, 200);
  release(); assert.equal((await publishing).status, 410);
  assert.equal(JSON.parse(store.objects.get(key)).status, 'withdrawn'); assert.equal(store.objects.has(portraitKey), false);
});

test('partial withdrawal failure is fenced and can finish after restart', async () => {
  const store = storage(), relay = makeRelay(store); await upload(relay); let failed = false;
  store.beforePut = async request => { if (request.Key.startsWith('pool-deletions/') && !failed) { failed = true; throw new Error('Marker unavailable'); } };
  assert.equal((await call(relay, 'handleAdminDelete', { entryId: uploadId() })).status, 503);
  assert.equal((await upload(relay)).status, 410);
  const restarted = makeRelay(store);
  assert.equal((await call(restarted, 'handleAdminDelete', { entryId: uploadId() })).status, 200);
  assert.equal(store.objects.has(portraitKey), false);
});

test('storage failures and malformed protocol fail closed without minting PUT URLs', async () => {
  const store = storage(); store.failLists = 2; const relay = makeRelay(store); await tick();
  assert.equal((await upload(relay)).status, 503); assert.equal((await upload(relay)).status, 200);
  for (const handler of ['handleSignUpload','handlePoolJoin']) assert.equal((await call(relay, handler, identity)).status, 426);
  assert.equal((await upload(relay, null)).status, 400);
  assert.equal((await upload(relay, { ...identity, retryVersion: 1 })).status, 400);
});

test('ambiguous canonical commit is reconciled without losing the visible pool entry', async () => {
  const store = storage(), relay = makeRelay(store); let failed = false;
  store.afterPut = async request => { if (request.Key === key && JSON.parse(request.Body).status === 'active' && !failed) { failed = true; throw new Error('Lost provider acknowledgement'); } };
  assert.equal((await upload(relay)).status, 503);
  assert.equal((await upload(relay)).status, 200); assert.equal(store.writes, 3);
  const status = await new Promise(resolve => relay.handlePoolStatus({}, { resolve }));
  assert.equal(status.body.activeCount, 1);
});

test('restoring stale active data cannot override an existing deletion marker on restart', async () => {
  const store = storage(), relay = makeRelay(store); await upload(relay);
  const oldRecord = store.objects.get(key), oldPhoto = Buffer.from(store.objects.get(portraitKey));
  await call(relay, 'handleAdminDelete', { entryId: uploadId() });
  store.objects.set(key, oldRecord); store.objects.set(portraitKey, oldPhoto);
  const restarted = makeRelay(store);
  assert.equal((await upload(restarted)).status, 410);
  assert.equal(JSON.parse(store.objects.get(key)).status, 'withdrawn'); assert.equal(store.objects.has(portraitKey), false);
});

test('portrait deletion failure remains fenced and retry completes without restoring data', async () => {
  const store = storage(), relay = makeRelay(store); await upload(relay); let failed = false;
  store.beforeDelete = async () => { if (!failed) { failed = true; throw new Error('Injected delete failure'); } };
  assert.equal((await call(relay, 'handleAdminDelete', { entryId: uploadId() })).status, 503);
  assert.equal((await upload(relay)).status, 410);
  assert.equal((await call(relay, 'handleAdminDelete', { entryId: uploadId() })).status, 200);
  assert.equal(store.objects.has(portraitKey), false);
});

test('stale relay match cannot recreate a withdrawn entry through metadata persistence', async () => {
  const store = storage(), first = makeRelay(store); await upload(first);
  const stale = makeRelay(store); await upload(stale); // populate that relay's cache
  await call(first, 'handleAdminDelete', { entryId: uploadId() });
  const result = await call(stale, 'handlePoolMatch', { answers: [1,2,3].map(n => ({ questionId: 'q'+n, answerId: 'a' })), sessionId: 'visitor', joined: true });
  assert.equal(result.status, 503); assert.equal(result.body.match, undefined);
  assert.equal(JSON.parse(store.objects.get(key)).status, 'withdrawn');
});

test('failed distribution update does not increment cached or durable history', async () => {
  const store = storage(), relay = makeRelay(store); await upload(relay); store.failWrites = 1;
  const body = { answers: [1,2,3].map(n => ({ questionId: 'q'+n, answerId: 'a' })), sessionId: 'visitor', joined: true };
  assert.equal((await call(relay, 'handlePoolMatch', body)).status, 503);
  assert.equal(JSON.parse(store.objects.get(key)).distributionCount, 0);
  assert.equal((await call(relay, 'handlePoolMatch', body)).status, 200);
  assert.equal(JSON.parse(store.objects.get(key)).distributionCount, 1);
});

test('a portrait PUT completing after withdrawal cannot publish or survive cleanup', async () => {
  const store = storage(), writer = makeRelay(store), deleter = makeRelay(store);
  let release, reached = false; const blocked = new Promise(r => { release = r; });
  store.beforePut = async request => { if (request.Key === portraitKey) { reached = true; await blocked; } };
  const publishing = upload(writer); await waitFor(() => reached);
  assert.equal((await call(deleter, 'handleAdminDelete', { entryId: uploadId() })).status, 200);
  release(); assert.equal((await publishing).status, 410);
  assert.equal(store.objects.has(portraitKey), false);
  assert.equal(JSON.parse(store.objects.get(key)).status, 'withdrawn');
  assert.equal((await upload(makeRelay(store))).status, 410);
});

test('restart scrubs an orphan left by a writer dying after a late portrait commit', async () => {
  const store = storage(), relay = makeRelay(store); await upload(relay);
  await call(relay, 'handleAdminDelete', { entryId: uploadId() });
  // State at a process crash after an in-flight conditional image write:
  // private orphan exists, canonical tombstone is still authoritative.
  store.objects.set(portraitKey, photo);
  assert.equal((await upload(makeRelay(store))).status, 410);
  assert.equal(store.objects.has(portraitKey), false);
  assert.equal(JSON.parse(store.objects.get(key)).status, 'withdrawn');
});

test('legacy committed entry without a digest is verified and never republished', async () => {
  const store = storage(), relay = makeRelay(store); await upload(relay);
  const legacy = JSON.parse(store.objects.get(key)); delete legacy.photoDigest; delete legacy.publicationVersion;
  legacy.distributionCount = 2; store.objects.set(key, JSON.stringify(legacy));
  const restarted = makeRelay(store);
  assert.equal((await upload(restarted)).status, 200);
  const changed = Buffer.alloc(photo.length, 8);
  assert.equal((await upload(restarted, { ...identity, photoDigest: crypto.createHash('sha256').update(changed).digest('hex') }, changed)).status, 409);
  assert.equal(store.writes, 3); assert.deepEqual(JSON.parse(store.objects.get(key)), legacy);
  assert.deepEqual(store.objects.get(portraitKey), photo);
});

test('unavailable deletion lookup fails closed and incorrect new bytes never publish', async () => {
  const store = storage(), relay = makeRelay(store); let failing = true;
  store.beforeGet = async request => { if (request.Key.startsWith('pool-deletions/') && failing) throw new Error('Deletion lookup unavailable'); };
  assert.equal((await upload(relay)).status, 503); assert.equal(store.objects.size, 0);
  failing = false;
  assert.equal((await upload(relay, identity, Buffer.alloc(photo.length, 8))).status, 422);
  assert.equal(JSON.parse(store.objects.get(key)).status, 'pending'); assert.equal(store.objects.has(portraitKey), false);
  assert.equal((await upload(relay)).status, 200);
});

test('a failed canonical tombstone write is never acknowledged as withdrawal', async () => {
  const store = storage(), relay = makeRelay(store); await upload(relay);
  store.beforePut = async request => { if (request.Key === key && JSON.parse(request.Body).status === 'withdrawn') throw new Error('Tombstone write failed'); };
  assert.equal((await call(relay, 'handleAdminDelete', { entryId: uploadId() })).status, 503);
  assert.equal(JSON.parse(store.objects.get(key)).status, 'active'); assert.equal(store.objects.has(portraitKey), true);
  store.beforePut = null;
  assert.equal((await call(makeRelay(store), 'handleAdminDelete', { entryId: uploadId() })).status, 200);
  assert.equal((await upload(relay)).status, 410); assert.equal(store.objects.has(portraitKey), false);
});

test('competing relays with different pixels cannot overwrite the winner', async () => {
  const store = storage(), first = makeRelay(store), second = makeRelay(store), changed = Buffer.alloc(photo.length, 8);
  const results = await Promise.all([upload(first), upload(second, { ...identity, photoDigest: crypto.createHash('sha256').update(changed).digest('hex') }, changed)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(store.objects.get(portraitKey), results[0].status === 200 ? photo : changed);
  assert.equal(store.writes, 3);
});
