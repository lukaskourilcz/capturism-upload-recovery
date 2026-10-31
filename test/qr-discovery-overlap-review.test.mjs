import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, BODY } from './helpers/qr-relay-fixture.mjs';
const META = `sessions/${TOKEN}/meta.json`, VIDEO = `sessions/${TOKEN}/layout.mp4`;
async function setup() {
  const store = storage(); let clock = 1000000;
  const opts = { now: () => clock }, relay = makeQrRelay(store, opts); await relay.issue(); await relay.confirm({ ...BODY, videosPending: true });
  clock += 600000; return { store, opts, relay };
}

test('a second relay commit during an absent HEAD scan is returned instead of final cached absence', async () => {
  const { store, opts, relay } = await setup(); let entered, release;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  store.beforeHead = async () => { entered(); await gate; };
  const request = relay.download(TOKEN); await started;
  const key = 'historical/late-layout.webm'; store.objects.set(key, Buffer.alloc(16, 8));
  const other = makeQrRelay(store, opts); assert.equal((await other.confirm({ ...BODY, videosPending: true, layoutVideoKey: key })).status, 200);
  release(); const result = await request;
  assert.equal(result.status, 200); assert.equal(result.body.videoFailed, false); assert.ok(result.body.layoutVideoUrl.includes(encodeURIComponent(key)));
  assert.equal(JSON.parse(store.objects.get(META)).layoutVideoKey, key);
});

test('a conflicting cross-relay video commit stays intact and immediate retry recovers its committed key', async () => {
  const { store, opts, relay } = await setup(); store.objects.set(VIDEO, Buffer.alloc(16, 9));
  const key = `sessions/${TOKEN}/layout.webm`; store.objects.set(key, Buffer.alloc(16, 8));
  let entered, release;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  store.beforeHead = async () => { entered(); await gate; };
  const request = relay.download(TOKEN); await started;
  const other = makeQrRelay(store, opts); await other.confirm({ ...BODY, videosPending: true, layoutVideoKey: key });
  const committed = store.objects.get(META), writes = store.writes; release();
  assert.equal((await request).status, 503); assert.equal(store.objects.get(META), committed); assert.equal(store.writes, writes);
  store.beforeHead = async () => { throw new Error('Committed metadata should suffice'); };
  const recovered = await relay.download(TOKEN); assert.equal(recovered.status, 200); assert.ok(recovered.body.layoutVideoUrl.includes(encodeURIComponent(key)));
  assert.equal(store.objects.get(META), committed); assert.equal(store.writes, writes);
});

for (const cold of [false, true]) test(`50 ${cold ? 'cold' : 'warm'} readers share one discovery and one metadata save`, async () => {
  const { store, opts, relay: seeded } = await setup(); store.objects.set(VIDEO, Buffer.alloc(16, 9));
  const relay = cold ? makeQrRelay(store, opts) : seeded;
  const send = store.send.bind(store); const counts = { GetObjectCommand: 0, HeadObjectCommand: 0, PutObjectCommand: 0 };
  store.send = async command => { counts[command.constructor.name]++; return send(command); };
  const results = await Promise.all(Array.from({ length: 50 }, () => relay.download(TOKEN)));
  assert.ok(results.every(r => r.status === 200 && r.body.layoutVideoUrl && !r.body.videoFailed));
  assert.equal(new Set(results.map(r => r.body.layoutVideoUrl)).size, 1);
  assert.equal(counts.HeadObjectCommand, 5); assert.equal(counts.PutObjectCommand, 1); assert.equal(relay.videoProbes.size, 0);
  const meta = JSON.parse(store.objects.get(META)); assert.equal(meta.createdAt, 1000000); assert.equal(meta.videoWaitStartedAt, 1000000); assert.equal(meta.expiresAt, 87400000);
  console.log(JSON.stringify({ scenario: cold ? 'cold-burst' : 'warm-burst', readers: 50, ...counts, interpretation: 'local provider operation counts, not a cloud performance benchmark' }));
});
