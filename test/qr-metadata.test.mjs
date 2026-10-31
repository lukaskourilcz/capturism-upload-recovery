import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';

const KEY = `sessions/${TOKEN}/meta.json`;
const saved = store => JSON.parse(store.objects.get(KEY).toString());

test('failed QR save returns 503, has no success cache/notice, and same-token retry survives restart', async () => {
  const store = storage(), relay = makeQrRelay(store); await relay.issue(); store.objects.set(PHOTO, Buffer.alloc(32, 7)); let fail = true; store.beforePut = async ({ Key }) => { if (Key.endsWith('/meta.json') && fail) { fail = false; throw new Error('Metadata save unavailable'); } };
  assert.equal((await relay.confirm(BODY)).status, 503);
  assert.equal(relay.cache.size, 0); assert.equal(relay.notifications.length, 0); assert.equal(store.objects.has(KEY), false);
  assert.equal((await relay.download(TOKEN)).status, 404);
  assert.equal((await relay.confirm(BODY)).status, 200); assert.equal(store.writes, 3);
  const restarted = makeQrRelay(store); assert.equal(restarted.cache.size, 0);
  const download = await restarted.download(TOKEN); assert.equal(download.status, 200); assert.ok(download.body.photoUrl);
  assert.equal(store.objects.has(PHOTO), true);
});

test('lost storage acknowledgement is reconciled by durable read without another write or renewed expiry', async () => {
  const store = storage(); let clock = 1000000, failed = false;
  const relay = makeQrRelay(store, { now: () => clock }); await relay.issue();
  store.afterPut = async ({ Key: key }) => { if (key === KEY && !failed) { failed = true; throw new Error('Lost storage acknowledgement'); } };
  assert.equal((await relay.confirm(BODY)).status, 503); assert.equal(relay.cache.size, 0); assert.equal(relay.notifications.length, 0);
  const original = saved(store); clock += 50000;
  assert.equal((await relay.confirm(BODY)).status, 200); assert.equal(store.writes, 3); assert.deepEqual(saved(store), original);
  assert.equal((await makeQrRelay(store, { now: () => clock }).download(TOKEN)).status, 200);
});

test('photo-only replay after video delivery preserves video keys, unknown historical fields and original clocks', async () => {
  const store = storage(); let clock = 1000000;
  const relay = makeQrRelay(store, { now: () => clock }); await relay.issue(); await relay.confirm({ ...BODY, videosPending: true });
  const original = saved(store); clock += 50000;
  const videos = { layoutVideoKey: `sessions/${TOKEN}/layout.mp4`, storyVideoKey: `sessions/${TOKEN}/story.webm` };
  assert.equal((await relay.confirm({ ...BODY, ...videos })).status, 200);
  const record = saved(store); record.historicalField = 'preserve'; store.objects.set(KEY, JSON.stringify(record));
  clock += 50000;
  const restarted = makeQrRelay(store, { now: () => clock }); assert.equal((await restarted.confirm(BODY)).status, 200);
  const final = saved(store);
  assert.equal(final.createdAt, original.createdAt); assert.equal(final.expiresAt, original.expiresAt);
  assert.equal(final.layoutVideoKey, videos.layoutVideoKey); assert.equal(final.storyVideoKey, videos.storyVideoKey);
  assert.equal(final.historicalField, 'preserve'); assert.equal(store.writes, 4);
  assert.equal(restarted.notifications[0].payload.layoutVideoKey, videos.layoutVideoKey);
});

test('concurrent relays merge different video commits without losing the original photo or expiry', async () => {
  const store = storage(), first = makeQrRelay(store), second = makeQrRelay(store); await first.issue(); await first.confirm(BODY);
  const original = saved(store);
  const results = await Promise.all([first.confirm({ ...BODY, layoutVideoKey: `sessions/${TOKEN}/layout.mp4` }), second.confirm({ ...BODY, storyVideoKey: `sessions/${TOKEN}/story.mp4` })]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  const final = saved(store); assert.ok(final.layoutVideoKey); assert.ok(final.storyVideoKey);
  assert.equal(final.photoKey, original.photoKey); assert.equal(final.expiresAt, original.expiresAt);
});

test('failed video discovery patch changes neither committed cache nor metadata, then retry succeeds', async () => {
  const store = storage(), relay = makeQrRelay(store); await relay.issue(); await relay.confirm(BODY);
  const original = saved(store); store.failWrites = 1;
  await assert.rejects(relay.patchSession(TOKEN, { storyVideoKey: `sessions/${TOKEN}/story.mp4` }));
  assert.deepEqual(saved(store), original); assert.equal(relay.cache.get(TOKEN).storyVideoKey, undefined);
  await relay.patchSession(TOKEN, { storyVideoKey: `sessions/${TOKEN}/story.mp4` });
  assert.equal(saved(store).expiresAt, original.expiresAt); assert.ok(saved(store).storyVideoKey);
});

test('expired session cannot be revived by confirmation or discovery replay', async () => {
  const store = storage(); let clock = 1000000;
  const relay = makeQrRelay(store, { now: () => clock }); await relay.issue(); await relay.confirm(BODY); const original = saved(store);
  clock = original.expiresAt + 1;
  assert.equal((await relay.confirm(BODY)).status, 410);
  await assert.rejects(relay.patchSession(TOKEN, { storyVideoKey: `sessions/${TOKEN}/story.mp4` }), error => error.status === 410);
  assert.equal((await relay.download(TOKEN)).status, 404); assert.deepEqual(saved(store), original);
});

test('a save completing after retention expiry cannot acknowledge a usable QR or renew its clock', async () => {
  const store = storage(); let clock = 1000000;
  const relay = makeQrRelay(store, { now: () => clock }); await relay.issue();
  store.beforePut = async ({ Key: key }) => { if (key === KEY) clock += 86400001; };
  assert.equal((await relay.confirm(BODY)).status, 410);
  assert.equal(relay.cache.size, 0); assert.equal(relay.notifications.length, 0);
  assert.equal(saved(store).createdAt, 1000000); assert.equal(saved(store).expiresAt, 87400000);
});

test('exact expiry boundary rejects warm and cold replay without any metadata write', async () => {
  const store = storage(); let clock = 1000000;
  const relay = makeQrRelay(store, { now: () => clock }); await relay.issue(); await relay.confirm(BODY);
  const original = store.objects.get(KEY); clock = saved(store).expiresAt;
  for (const current of [relay, makeQrRelay(store, { now: () => clock })]) {
    assert.equal((await current.confirm(BODY)).status, 410);
    assert.equal((await current.download(TOKEN)).status, 404);
  }
  assert.equal(store.objects.get(KEY), original); assert.equal(store.writes, 3);
});

test('stale warm relay reconciles a photo replay from durable media without renewing retention', async () => {
  const store = storage(), stale = makeQrRelay(store); await stale.issue(); await stale.confirm(BODY);
  const original = saved(store), second = makeQrRelay(store);
  await second.confirm({ ...BODY, layoutVideoKey: `sessions/${TOKEN}/layout.mp4` });
  assert.equal(stale.cache.get(TOKEN).layoutVideoKey, undefined);
  assert.equal((await stale.confirm(BODY)).status, 200);
  assert.ok(stale.cache.get(TOKEN).layoutVideoKey); assert.equal(saved(store).expiresAt, original.expiresAt);
  assert.equal(store.writes, 4);
});

test('conflicting photo, booth or completed video identity cannot overwrite a committed session', async () => {
  const store = storage(), relay = makeQrRelay(store); await relay.issue(); await relay.confirm({ ...BODY, layoutVideoKey: `sessions/${TOKEN}/layout.mp4` });
  const original = saved(store);
  assert.equal((await relay.confirm({ ...BODY, photoKey: `sessions/${TOKEN}/photo.png` })).status, 409);
  assert.equal((await relay.confirm({ ...BODY, layoutVideoKey: `sessions/${TOKEN}/layout.webm` })).status, 409);
  assert.equal((await makeQrRelay(store, { boothId: 'another-booth' }).confirm(BODY)).status, 409);
  assert.deepEqual(saved(store), original); assert.equal(store.writes, 3);
});

test('unavailable storage/read and invalid stored metadata fail closed rather than replacing an existing record', async () => {
  assert.equal((await makeQrRelay(null).confirm(BODY)).status, 503);
  const store = storage(), relay = makeQrRelay(store); await relay.issue(); await relay.confirm(BODY); const original = store.objects.get(KEY);
  store.beforeGet = async () => { throw new Error('Storage read unavailable'); };
  assert.equal((await relay.confirm(BODY)).status, 503); assert.equal(store.objects.get(KEY), original);
  store.beforeGet = null; store.objects.set(KEY, '{}');
  assert.equal((await makeQrRelay(store).confirm(BODY)).status, 503); assert.equal(store.objects.get(KEY), '{}');
});

test('malformed confirmation and dev seed return errors without acknowledgement/cache changes', async () => {
  const store = storage(), relay = makeQrRelay(store); await relay.issue();
  for (const body of [null, [], { ...BODY, token: '../invalid' }, { ...BODY, videosPending: 'yes' }]) assert.equal((await relay.confirm(body)).status, 400);
  store.failWrites = 1;
  const result = await new Promise((resolve, reject) => relay.handleDevSeed({ body: { ...BODY, key: 'synthetic', boothId: 'synthetic-booth' }, fail: reject }, { resolve }));
  assert.equal(result.status, 503); assert.equal(relay.cache.size, 0); assert.equal(store.objects.has(KEY), false);
});

test('WebSocket photos-ready notification is withheld on save failure and emitted after durable success', async () => {
  const store = storage(), relay = makeQrRelay(store); await relay.issue(); store.failWrites = 1;
  const msg = { type: 'booth:photos_ready', payload: BODY };
  await relay.handleWsPhotosReady(msg, 'synthetic-booth'); assert.equal(relay.notifications.length, 0); assert.equal(relay.cache.size, 0);
  await relay.handleWsPhotosReady(msg, 'synthetic-booth'); assert.equal(relay.notifications.length, 1); assert.equal(store.objects.has(KEY), true);
});

test('actual relay handler in a new child process resolves the acknowledged QR after abrupt restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capturism-qr-relay-process-')); let child;
  const start = async failOnce => {
    child = fork(new URL('./fixtures/qr-relay-worker.mjs', import.meta.url), [join(directory, 'provider.json'), failOnce ? 'fail' : 'normal'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const result = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Fixture relay exited before readiness'); })]);
    return `http://127.0.0.1:${result[0].port}`;
  };
  try {
    let base = await start(true);
    const confirm = () => fetch(base + '/confirm', { method: 'POST', body: JSON.stringify(BODY) });
    assert.equal((await confirm()).status, 503); assert.equal((await fetch(base + '/download/' + TOKEN)).status, 404);
    const ok = await confirm(); assert.equal(ok.status, 200); await ok.text();
    const died = once(child, 'exit'); child.kill('SIGKILL'); await died;
    base = await start(false);
    const download = await fetch(base + '/download/' + TOKEN); assert.equal(download.status, 200);
    const photoResponse = await fetch((await download.json()).photoUrl); assert.equal(photoResponse.status, 200);
    assert.deepEqual(Buffer.from(await photoResponse.arrayBuffer()), Buffer.alloc(32, 7));
    assert.equal((await confirm()).status, 200);
  } finally { if (child?.exitCode === null) { const died = once(child, 'exit'); child.kill('SIGTERM'); await died; } await rm(directory, { recursive: true, force: true }); }
});

test('restart fixture does not conceal a missing provider photo by reseeding it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capturism-qr-no-reseed-')); let child;
  try {
    const record = { photoKey: PHOTO, boothId: 'synthetic-booth', createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
    const file = join(directory, 'provider.json');
    await writeFile(file, JSON.stringify([[KEY, Buffer.from(JSON.stringify(record)).toString('base64')]]));
    child = fork(new URL('./fixtures/qr-relay-worker.mjs', import.meta.url), [file, 'normal'], { env: { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe','ipc'] });
    const [{ port }] = await once(child, 'message');
    const metadata = await fetch(`http://127.0.0.1:${port}/download/${TOKEN}`); assert.equal(metadata.status, 200);
    const photo = await fetch((await metadata.json()).photoUrl); assert.equal(photo.status, 404);
  } finally { if (child?.exitCode === null) { const died = once(child, 'exit'); child.kill('SIGTERM'); await died; } await rm(directory, { recursive: true, force: true }); }
});

test('disk-backed expiry proof rejects replay after metadata cleanup and abrupt process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capturism-qr-expiry-process-')); let child;
  const file = join(directory, 'provider.json');
  const start = async clock => {
    child = fork(new URL('./fixtures/qr-relay-worker.mjs', import.meta.url), [file, 'normal', String(clock)], { env: { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe','ipc'] });
    const [{ port }] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  try {
    let base = await start(1000000);
    assert.equal((await fetch(base + '/confirm', { method: 'POST', body: JSON.stringify(BODY) })).status, 200);
    const original = (await (await fetch(base + '/download/' + TOKEN)).json()).expiresAt;
    const died = once(child, 'exit'); child.kill('SIGKILL'); await died;
    const { readFile } = await import('node:fs/promises');
    const provider = JSON.parse(await readFile(file, 'utf8')).filter(([key]) => key !== KEY);
    assert.ok(provider.some(([key]) => key.startsWith('qr-expiry/v1/')));
    await writeFile(file, JSON.stringify(provider));
    base = await start(Date.parse(original));
    assert.equal((await fetch(base + '/confirm', { method: 'POST', body: JSON.stringify(BODY) })).status, 410);
    assert.equal((await fetch(base + '/download/' + TOKEN)).status, 404);
    const final = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(final.some(([key]) => key === KEY), false);
    assert.ok(final.some(([key]) => key === PHOTO)); assert.deepEqual(final, provider);
  } finally { if (child?.exitCode === null) { const died = once(child, 'exit'); child.kill('SIGTERM'); await died; } await rm(directory, { recursive: true, force: true }); }
});
