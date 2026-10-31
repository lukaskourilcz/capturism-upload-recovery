import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, BODY } from './helpers/qr-relay-fixture.mjs';
const META = `sessions/${TOKEN}/meta.json`, VIDEO = `sessions/${TOKEN}/layout.mp4`;
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const PROOF = `qr-expiry/v1/${HASH}.json`, WAIT = `qr-video-wait/v1/${HASH}.json`;
async function seeded({ present = true, timeout = 15000 } = {}) {
  const store = storage(); let clock = 1000000;
  const options = { now: () => clock, probeTimeoutMs: timeout }, relay = makeQrRelay(store, options);
  await relay.issue(); await relay.confirm({ ...BODY, videosPending: true });
  if (present) store.objects.set(VIDEO, Buffer.alloc(16, 9));
  const proof = store.objects.get(PROOF), wait = store.objects.get(WAIT), metadata = JSON.parse(store.objects.get(META));
  return { store, relay, options, advance: n => { clock += n; }, assertClocks() {
    const current = JSON.parse(store.objects.get(META));
    for (const field of ['createdAt','expiresAt','videoWaitStartedAt']) assert.equal(current[field], metadata[field]);
    assert.equal(store.objects.get(PROOF), proof); assert.equal(store.objects.get(WAIT), wait);
  } };
}
for (const status of [403, 429, 500, 503]) test(`HEAD ${status} remains retryable on warm/cold relays and immediate recovery finds video`, async () => {
  const f = await seeded(); f.advance(600000);
  f.store.beforeHead = async () => { throw Object.assign(new Error('Synthetic storage error'), { $metadata: { httpStatusCode: status } }); };
  for (const current of [f.relay, makeQrRelay(f.store, f.options)]) {
    const result = await current.download(TOKEN); assert.equal(result.status, 503); assert.equal(result.body.retryable, true);
    assert.equal(result.body.videoFailed, undefined); assert.equal(current.videoProbes.size, 0);
  }
  f.store.beforeHead = null; f.advance(1);
  const recovered = await f.relay.download(TOKEN); assert.equal(recovered.status, 200); assert.ok(recovered.body.layoutVideoUrl);
  assert.equal(recovered.body.videoFailed, false); f.assertClocks();
});

test('mixed found/unknown HEAD results do not publish a false negative or partial success; retry persists all found media', async () => {
  const f = await seeded(); f.advance(600000);
  const story = `sessions/${TOKEN}/story.webm`; f.store.objects.set(story, Buffer.alloc(16, 8));
  f.store.beforeHead = async ({ Key }) => { if (Key.endsWith('story.mp4')) throw new Error('Unreadable variant'); };
  assert.equal((await f.relay.download(TOKEN)).status, 503);
  assert.equal(JSON.parse(f.store.objects.get(META)).layoutVideoKey, undefined);
  f.store.beforeHead = null;
  const ready = await f.relay.download(TOKEN); assert.equal(ready.status, 200); assert.ok(ready.body.layoutVideoUrl); assert.ok(ready.body.storyVideoUrl);
  f.assertClocks();
});

test('failed discovery save keeps old committed cache and immediate retry can persist the video', async () => {
  const f = await seeded(); f.advance(600000); const original = f.store.objects.get(META); let fail = true;
  f.store.beforePut = async ({ Key }) => { if (Key === META && fail) throw new Error('Save failure'); };
  const failed = await f.relay.download(TOKEN); assert.equal(failed.status, 503); assert.equal(failed.body.retryable, true);
  assert.equal(f.store.objects.get(META), original); assert.equal(f.relay.cache.get(TOKEN).layoutVideoKey, undefined);
  fail = false; const ready = await f.relay.download(TOKEN); assert.equal(ready.status, 200); assert.ok(ready.body.layoutVideoUrl);
  assert.ok(JSON.parse(f.store.objects.get(META)).layoutVideoKey); f.assertClocks();
});

test('lost discovery save acknowledgement reconciles committed media on immediate retry without another save', async () => {
  const f = await seeded(); f.advance(600000); let lost = false;
  f.store.afterPut = async ({ Key }) => { if (Key === META && !lost) { lost = true; throw new Error('ACK lost'); } };
  assert.equal((await f.relay.download(TOKEN)).status, 503); const writes = f.store.writes;
  const ready = await f.relay.download(TOKEN); assert.equal(ready.status, 200); assert.ok(ready.body.layoutVideoUrl);
  assert.equal(f.store.writes, writes); f.assertClocks();
});

test('overlapping readers await one successful probe rather than treating in-flight work as absence', async () => {
  const f = await seeded(); f.advance(600000); let entered, release, heads = 0, secondDone = false;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.store.beforeHead = async () => { heads++; entered(); await gate; };
  const first = f.relay.download(TOKEN); await started;
  const second = f.relay.download(TOKEN).then(r => { secondDone = true; return r; });
  await new Promise(r => setImmediate(r)); assert.equal(secondDone, false); assert.equal(f.relay.videoProbes.size, 1);
  release(); const results = await Promise.all([first, second]);
  assert.equal(heads, 5); assert.deepEqual(results.map(r => r.status), [200,200]);
  assert.ok(results.every(r => r.body.layoutVideoUrl && !r.body.videoFailed)); assert.equal(f.relay.videoProbes.size, 0); f.assertClocks();
});

test('overlapping failed probes all return retryable failure, release their slot, and recover immediately', async () => {
  const f = await seeded(); f.advance(600000); let entered, release;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.store.beforeHead = async () => { entered(); await gate; throw new Error('Transient error'); };
  const first = f.relay.download(TOKEN); await started; const second = f.relay.download(TOKEN); release();
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [503,503]);
  assert.equal(f.relay.videoProbes.size, 0); f.store.beforeHead = null;
  assert.equal((await f.relay.download(TOKEN)).status, 200); f.assertClocks();
});

test('a stalled abort-ignoring HEAD times out, cannot publish late results, and does not block retry', async () => {
  const f = await seeded({ timeout: 40 }); f.advance(600000); let release, signal;
  const gate = new Promise(r => { release = r; }), originalSend = f.store.send.bind(f.store);
  f.store.send = (command, options) => { if (command.constructor.name === 'HeadObjectCommand') signal = options.abortSignal; return originalSend(command); };
  f.store.beforeHead = async () => gate;
  const failed = await f.relay.download(TOKEN); assert.equal(failed.status, 503); assert.equal(signal.aborted, true);
  assert.equal(f.relay.videoProbes.size, 0); assert.equal(JSON.parse(f.store.objects.get(META)).layoutVideoKey, undefined);
  release(); await new Promise(r => setImmediate(r));
  assert.equal(JSON.parse(f.store.objects.get(META)).layoutVideoKey, undefined);
  f.store.beforeHead = null; assert.ok((await f.relay.download(TOKEN)).body.layoutVideoUrl); f.assertClocks();
});

test('negative cache cannot cross the final grace boundary without a fresh verified scan', async () => {
  const f = await seeded({ present: false }); f.advance(599999); let heads = 0;
  f.store.beforeHead = async () => { heads++; };
  assert.equal((await f.relay.download(TOKEN)).body.videoPending, true); assert.equal(heads, 6);
  assert.equal((await f.relay.download(TOKEN)).body.videoPending, true); assert.equal(heads, 6);
  f.store.objects.set(VIDEO, Buffer.alloc(16, 9)); f.advance(1);
  const exact = await f.relay.download(TOKEN); assert.ok(exact.body.layoutVideoUrl); assert.equal(exact.body.videoFailed, false);
  assert.equal(heads, 11); f.assertClocks();
});

test('fresh durable read notices a different relay commit instead of returning cached absence', async () => {
  const f = await seeded(); f.advance(600000); const other = makeQrRelay(f.store, f.options);
  await other.confirm({ ...BODY, videosPending: true, layoutVideoKey: VIDEO });
  f.store.beforeHead = async () => { throw new Error('No HEAD needed for already committed media'); };
  const result = await f.relay.download(TOKEN); assert.equal(result.status, 200); assert.ok(result.body.layoutVideoUrl); f.assertClocks();
});

test('expiry during a probe is terminal, not a late successful QR or renewed lifetime', async () => {
  const f = await seeded(); f.advance(600000);
  f.store.beforeHead = async () => { f.advance(86400000); };
  const response = await f.relay.download(TOKEN); assert.equal(response.status, 404);
  assert.equal(f.relay.videoProbes.size, 0); f.assertClocks();
});

test('stalled save keeps overlapping reads bounded and late provider commit is reconciled without duplicate writes', async () => {
  const f = await seeded({ timeout: 40 }); f.advance(600000); let entered, release, block = true;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.store.beforePut = async ({ Key }) => { if (Key === META && block) { entered(); await gate; } };
  const first = f.relay.download(TOKEN); await started;
  const overlap = f.relay.download(TOKEN);
  assert.deepEqual((await Promise.all([first, overlap])).map(r => r.status), [503,503]);
  assert.equal(f.relay.videoProbes.size, 0); assert.equal(JSON.parse(f.store.objects.get(META)).layoutVideoKey, undefined);
  // An already-accepted provider write may ignore client/server cancellation.
  const retryWhilePending = await f.relay.download(TOKEN); assert.equal(retryWhilePending.status, 503);
  block = false; release(); await new Promise(r => setImmediate(r));
  const recovered = await f.relay.download(TOKEN); assert.equal(recovered.status, 200); assert.ok(recovered.body.layoutVideoUrl);
  assert.equal(f.store.writes, 4); assert.equal(f.relay.videoProbes.size, 0); f.assertClocks();
});

test('a historical metadata lastProbeAt field cannot pretend a negative probe completed in this relay', async () => {
  const f = await seeded(); f.advance(600000);
  const meta = JSON.parse(f.store.objects.get(META)); meta.lastProbeAt = 1600000; f.store.objects.set(META, JSON.stringify(meta));
  const cold = makeQrRelay(f.store, f.options), result = await cold.download(TOKEN);
  assert.equal(result.status, 200); assert.ok(result.body.layoutVideoUrl); assert.equal(result.body.videoFailed, false); f.assertClocks();
});
