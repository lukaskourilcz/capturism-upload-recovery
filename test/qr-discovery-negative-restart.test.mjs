import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';
const META = `sessions/${TOKEN}/meta.json`, VIDEO = `sessions/${TOKEN}/layout.mp4`;
test('restart discards only the negative cache and discovers video arriving after a verified absence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-negative-restart-')), file = join(dir, 'provider.json'); let child;
  const store = storage(), relay = makeQrRelay(store, { now: () => 1000000 }); await relay.issue(); await relay.confirm({ ...BODY, videosPending: true });
  store.objects.set(PHOTO, Buffer.alloc(32, 7));
  await writeFile(file, JSON.stringify([...store.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')])));
  const snapshot = async () => new Map(JSON.parse(await readFile(file, 'utf8')));
  const start = async () => {
    child = fork(new URL('./fixtures/qr-relay-worker.mjs', import.meta.url), [file,'normal','2200000','normal'], { env: { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe','ipc'] });
    const [{ port }] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  try {
    let base = await start(); const original = await snapshot();
    const absent = await (await fetch(base + '/download/' + TOKEN)).json(); assert.equal(absent.videoFailed, true); assert.equal(absent.layoutVideoUrl, null);
    assert.deepEqual(await snapshot(), original); // No negative marker persisted.
    const died = once(child,'exit'); child.kill('SIGKILL'); await died;
    const uploaded = await snapshot(); uploaded.set(VIDEO, Buffer.alloc(16, 9).toString('base64')); await writeFile(file, JSON.stringify([...uploaded]));
    base = await start(); const recovered = await (await fetch(base + '/download/' + TOKEN)).json();
    assert.equal(recovered.videoFailed, false); assert.ok(recovered.layoutVideoUrl);
    assert.deepEqual(Buffer.from(await (await fetch(recovered.layoutVideoUrl)).arrayBuffer()), Buffer.alloc(16, 9));
    const final = await snapshot();
    for (const [key, bytes] of original) if (key !== META) assert.equal(final.get(key), bytes);
    const oldMeta = JSON.parse(Buffer.from(original.get(META), 'base64')), meta = JSON.parse(Buffer.from(final.get(META), 'base64'));
    for (const field of ['createdAt','expiresAt','videoWaitStartedAt']) assert.equal(meta[field], oldMeta[field]);
    assert.equal(meta.layoutVideoKey, VIDEO);
  } finally { if (child?.exitCode === null) { const died = once(child,'exit'); child.kill('SIGTERM'); await died; } await rm(dir, { recursive:true, force:true }); }
});
