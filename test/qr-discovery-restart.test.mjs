import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';
const START = 1000000, META = `sessions/${TOKEN}/meta.json`, VIDEO = `sessions/${TOKEN}/layout.mp4`;
const hash = createHash('sha256').update(TOKEN).digest('hex');
const PROOF = `qr-expiry/v1/${hash}.json`, WAIT = `qr-video-wait/v1/${hash}.json`;
for (const mode of ['head-error', 'discovery-save-error', 'pause-discovery-ack']) test(`discovery ${mode} survives process replacement without losing video or moving either clock`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-discovery-restart-')), file = join(dir, 'provider.json'); let child;
  const store = storage(); let clock = START;
  const relay = makeQrRelay(store, { now: () => clock }); await relay.issue(); clock += 540000;
  await relay.confirm({ ...BODY, videosPending: true });
  store.objects.set(PHOTO, Buffer.alloc(32, 7)); store.objects.set(VIDEO, Buffer.alloc(16, 9));
  await writeFile(file, JSON.stringify([...store.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')])));
  const snapshot = async () => new Map(JSON.parse(await readFile(file, 'utf8')));
  const original = await snapshot();
  const start = async state => {
    child = fork(new URL('./fixtures/qr-relay-worker.mjs', import.meta.url), [file, 'normal', String(START + 1200000), state], { env: { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe','ipc'] });
    const [{ port }] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  const stop = async () => { const died = once(child, 'exit'); child.kill('SIGKILL'); await died; };
  try {
    let base = await start(mode);
    if (mode === 'pause-discovery-ack') {
      const marker = once(child, 'message');
      const request = fetch(base + '/download/' + TOKEN).then(r => ({ status: r.status }), () => ({ disconnected: true }));
      const [message] = await marker; assert.equal(message.phase, 'discovery-metadata-durable');
      assert.equal(JSON.parse(Buffer.from((await snapshot()).get(META), 'base64')).layoutVideoKey, VIDEO);
      await stop(); assert.deepEqual(await request, { disconnected: true });
    } else {
      const failure = await fetch(base + '/download/' + TOKEN); assert.equal(failure.status, 503);
      assert.equal((await failure.json()).retryable, true); assert.equal((await snapshot()).get(META), original.get(META));
      await stop();
    }
    const beforeRecovery = await snapshot(); base = await start('normal');
    const recovered = await fetch(base + '/download/' + TOKEN); assert.equal(recovered.status, 200);
    const body = await recovered.json(); assert.equal(body.videoFailed, false); assert.ok(body.layoutVideoUrl);
    assert.deepEqual(Buffer.from(await (await fetch(body.layoutVideoUrl)).arrayBuffer()), Buffer.alloc(16, 9));
    const after = await snapshot();
    for (const key of [PROOF, WAIT, PHOTO, VIDEO]) assert.equal(after.get(key), original.get(key));
    const oldMeta = JSON.parse(Buffer.from(original.get(META), 'base64')), newMeta = JSON.parse(Buffer.from(after.get(META), 'base64'));
    for (const field of ['createdAt','expiresAt','videoWaitStartedAt']) assert.equal(newMeta[field], oldMeta[field]);
    assert.equal(newMeta.layoutVideoKey, VIDEO);
    if (mode === 'pause-discovery-ack') assert.equal(after.get(META), beforeRecovery.get(META));
    assert.equal((await fetch(base + '/download/' + TOKEN)).status, 200);
    assert.deepEqual(await snapshot(), after);
  } finally { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } await rm(dir, { recursive: true, force: true }); }
});
