import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';
const MINUTE = 60000, START = 1000000, META = `sessions/${TOKEN}/meta.json`;
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const WAIT = `qr-video-wait/v1/${HASH}.json`, PROOF = `qr-expiry/v1/${HASH}.json`;
const pending = { ...BODY, videosPending: true };

test('slow photo gets its own full video wait without extending original QR retention', async () => {
  const store = storage(); let clock = START;
  const opts = { now: () => clock }, relay = makeQrRelay(store, opts); await relay.issue();
  clock += 9 * MINUTE; assert.equal((await relay.confirm(pending)).status, 200);
  const proof = store.objects.get(PROOF); assert.equal(JSON.parse(store.objects.get(WAIT)).startedAt, clock);
  clock = START + 11 * MINUTE;
  for (const current of [relay, makeQrRelay(store, opts)]) {
    const result = await current.download(TOKEN); assert.equal(result.body.videoPending, true); assert.equal(result.body.videoFailed, false);
    assert.equal(Date.parse(result.body.expiresAt), START + 86400000);
  }
  clock = START + 19 * MINUTE;
  const expiredWait = await makeQrRelay(store, opts).download(TOKEN); assert.equal(expiredWait.body.videoPending, false); assert.equal(expiredWait.body.videoFailed, true);
  clock = START + 86400000; assert.equal((await relay.confirm(pending)).status, 410);
  assert.equal((await relay.download(TOKEN)).status, 404); assert.equal(store.objects.get(PROOF), proof);
});

test('replay, patch, client timestamp and metadata cleanup never restart the persistent wait', async () => {
  const store = storage(); let clock = START;
  const opts = { now: () => clock }, relay = makeQrRelay(store, opts); await relay.issue();
  clock += 9 * MINUTE; await relay.confirm(pending); const wait = store.objects.get(WAIT), proof = store.objects.get(PROOF);
  clock += 3 * MINUTE;
  assert.equal((await relay.confirm({ ...pending, videoWaitStartedAt: clock + 999999 })).status, 200);
  store.objects.delete(META);
  const cold = makeQrRelay(store, opts); assert.equal((await cold.confirm(pending)).status, 200);
  assert.equal(cold.cache.get(TOKEN).videoWaitStartedAt, START + 9 * MINUTE);
  await cold.patchSession(TOKEN, { storyVideoKey: `sessions/${TOKEN}/story.mp4` });
  assert.equal(store.objects.get(WAIT), wait); assert.equal(store.objects.get(PROOF), proof);
});

test('failed metadata attempts leave no wait clock; the first durable retry establishes it', async () => {
  const store = storage(); let clock = START;
  const opts = { now: () => clock }, relay = makeQrRelay(store, opts); await relay.issue(); store.failWrites = 1;
  assert.equal((await relay.confirm(pending)).status, 503); assert.equal(store.objects.has(META), false);
  assert.equal(store.objects.has(WAIT), false); assert.equal(relay.cache.size, 0); assert.equal(relay.notifications.length, 0);
  clock += 9 * MINUTE; assert.equal((await makeQrRelay(store, opts).confirm(pending)).status, 200);
  assert.equal(JSON.parse(store.objects.get(WAIT)).startedAt, clock);
  clock += 2 * MINUTE; assert.equal((await makeQrRelay(store, opts).download(TOKEN)).body.videoPending, true);
});

test('lost clock acknowledgement and failed metadata save retain the same clock through cold replay', async () => {
  const store = storage(); let clock = START, lost = false, failMeta = true;
  const opts = { now: () => clock }, relay = makeQrRelay(store, opts); await relay.issue();
  store.afterPut = async ({ Key }) => { if (Key === WAIT && !lost) { lost = true; throw new Error('Clock ACK lost'); } };
  assert.equal((await relay.confirm(pending)).status, 503); const wait = store.objects.get(WAIT);
  assert.ok(wait); assert.equal(store.objects.has(META), true); assert.equal(relay.cache.size, 0);
  store.beforePut = async ({ Key }) => { if (Key === META && failMeta) throw new Error('Metadata unavailable'); };
  clock += MINUTE;
  assert.equal((await makeQrRelay(store, opts).confirm({ ...pending, layoutVideoKey: 'layout.mp4' })).status, 503); assert.equal(store.objects.get(WAIT), wait);
  failMeta = false; clock += MINUTE;
  assert.equal((await makeQrRelay(store, opts).confirm({ ...pending, layoutVideoKey: 'layout.mp4' })).status, 200);
  assert.equal(store.objects.get(WAIT), wait); assert.equal(store.writes, 4);
});

test('competing first confirmations share one clock and preserve both completed video fields', async () => {
  const store = storage(), first = makeQrRelay(store, { now: () => START }), second = makeQrRelay(store, { now: () => START + 5000 });
  await first.issue();
  const results = await Promise.all([first.confirm({ ...pending, layoutVideoKey: 'layout.mp4' }), second.confirm({ ...pending, storyVideoKey: 'story.mp4' })]);
  assert.deepEqual(results.map(r => r.status), [200,200]);
  const wait = JSON.parse(store.objects.get(WAIT)); assert.ok([START, START + 5000].includes(wait.startedAt));
  const meta = JSON.parse(store.objects.get(META)); assert.equal(meta.layoutVideoKey, 'layout.mp4'); assert.equal(meta.storyVideoKey, 'story.mp4');
  assert.equal(first.cache.get(TOKEN).videoWaitStartedAt, second.cache.get(TOKEN).videoWaitStartedAt);
});

test('missing clock restores the persisted confirmation timestamp; legacy fallback uses creation time', async () => {
  const store = storage(); let clock = START;
  const opts = { now: () => clock }, relay = makeQrRelay(store, opts); await relay.issue();
  clock += 9 * MINUTE; await relay.confirm(pending); store.objects.delete(WAIT);
  clock += MINUTE; const cold = makeQrRelay(store, opts); assert.equal((await cold.download(TOKEN)).status, 200);
  assert.equal(cold.cache.get(TOKEN).videoWaitStartedAt, START + 9 * MINUTE);
  const legacy = storage(); legacy.objects.set(META, JSON.stringify({ photoKey: PHOTO, boothId: 'synthetic-booth', createdAt: START, expiresAt: START + 86400000, videosPending: true }));
  const read = await makeQrRelay(legacy, { now: () => START + MINUTE }).download(TOKEN);
  assert.equal(read.body.videoPending, true); assert.equal(JSON.parse(legacy.objects.get(WAIT)).startedAt, START);
});

test('unreadable or altered clock fails closed without replacing metadata or clock', async () => {
  const store = storage(), relay = makeQrRelay(store); await relay.issue(); await relay.confirm(pending);
  const meta = store.objects.get(META), wait = store.objects.get(WAIT);
  store.beforeGet = async ({ Key }) => { if (Key === WAIT) throw new Error('Clock read failure'); };
  const cold = makeQrRelay(store); assert.equal((await cold.download(TOKEN)).status, 503); assert.equal((await cold.confirm(pending)).status, 503);
  store.beforeGet = null;
  const bad = JSON.stringify({ ...JSON.parse(wait), identityHash: '0'.repeat(64) }); store.objects.set(WAIT, bad);
  assert.equal((await cold.download(TOKEN)).status, 503); assert.equal((await cold.confirm(pending)).status, 503);
  assert.equal(store.objects.get(WAIT), bad); assert.equal(store.objects.get(META), meta);
});

test('clock persistence crossing expiry never creates usable metadata or acknowledges success', async () => {
  const store = storage(); let clock = START;
  const relay = makeQrRelay(store, { now: () => clock }); await relay.issue();
  store.afterPut = async ({ Key }) => { if (Key === WAIT) clock = START + 86400000; };
  assert.equal((await relay.confirm(pending)).status, 410); assert.equal((await relay.download(TOKEN)).status, 404);
  assert.equal(relay.cache.size, 0); assert.equal(relay.notifications.length, 0);
});

test('video clock survives SIGKILL and cold video delivery without resetting retention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-video-clock-')), file = join(dir, 'provider.json'); let child;
  const store = storage(), parent = makeQrRelay(store, { now: () => START }); await parent.issue();
  const video = `sessions/${TOKEN}/layout.mp4`; store.objects.set(PHOTO, Buffer.alloc(32, 7)); store.objects.set(video, Buffer.alloc(16, 9));
  await writeFile(file, JSON.stringify([...store.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')])));
  const start = async clock => {
    child = fork(new URL('./fixtures/qr-relay-worker.mjs', import.meta.url), [file, 'normal', String(clock)], { env: { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe','ipc'] });
    const [{ port }] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  const stop = async () => { const died = once(child, 'exit'); child.kill('SIGKILL'); await died; };
  try {
    let base = await start(START + 9 * MINUTE);
    assert.equal((await fetch(base + '/confirm', { method: 'POST', body: JSON.stringify(pending) })).status, 200);
    const original = new Map(JSON.parse(await readFile(file, 'utf8'))).get(WAIT); await stop();
    base = await start(START + 11 * MINUTE);
    const waiting = await (await fetch(base + '/download/' + TOKEN)).json(); assert.equal(waiting.videoPending, true);
    assert.equal((await fetch(base + '/confirm', { method: 'POST', body: JSON.stringify({ ...pending, layoutVideoKey: video }) })).status, 200);
    await stop(); base = await start(START + 12 * MINUTE);
    const ready = await (await fetch(base + '/download/' + TOKEN)).json(); assert.equal(ready.videoPending, false);
    assert.equal(Date.parse(ready.expiresAt), START + 86400000);
    assert.deepEqual(Buffer.from(await (await fetch(ready.layoutVideoUrl)).arrayBuffer()), Buffer.alloc(16, 9));
    assert.equal(new Map(JSON.parse(await readFile(file, 'utf8'))).get(WAIT), original);
  } finally { if (child?.exitCode === null) { const died = once(child, 'exit'); child.kill('SIGTERM'); await died; } await rm(dir, { recursive: true, force: true }); }
});


test('clock save failure after durable metadata is retryable and cold recovery preserves first confirmation', async () => {
  const store = storage(); let clock = START, fail = true;
  const opts = { now: () => clock }, relay = makeQrRelay(store, opts); await relay.issue();
  store.beforePut = async ({ Key }) => { if (Key === WAIT && fail) throw new Error('Clock save failure'); };
  clock += 9 * MINUTE;
  assert.equal((await relay.confirm(pending)).status, 503); assert.equal(relay.cache.size, 0); assert.equal(relay.notifications.length, 0);
  const meta = store.objects.get(META); assert.ok(meta); assert.equal(store.objects.has(WAIT), false);
  assert.equal((await makeQrRelay(store, opts).download(TOKEN)).status, 503);
  fail = false; clock += 2 * MINUTE;
  const cold = makeQrRelay(store, opts), ready = await cold.download(TOKEN);
  assert.equal(ready.status, 200); assert.equal(ready.body.videoPending, true);
  assert.equal(store.objects.get(META), meta); assert.equal(JSON.parse(store.objects.get(WAIT)).startedAt, START + 9 * MINUTE);
  assert.equal((await cold.confirm(pending)).status, 200); assert.equal(store.writes, 3);
});
