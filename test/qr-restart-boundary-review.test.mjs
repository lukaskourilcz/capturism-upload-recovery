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
const START = 1000000, MINUTE = 60000, META = `sessions/${TOKEN}/meta.json`;
const hash = createHash('sha256').update(TOKEN).digest('hex');
const WAIT = `qr-video-wait/v1/${hash}.json`, PROOF = `qr-expiry/v1/${hash}.json`;
for (const phase of ['pause-clock', 'pause-ack']) test(`SIGKILL ${phase}: cold recovery preserves first confirmation without a false acknowledgement`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-qr-commit-boundary-')), file = join(dir, 'provider.json'); let child;
  const store = storage(), relay = makeQrRelay(store, { now: () => START }); await relay.issue(); store.objects.set(PHOTO, Buffer.alloc(32, 7));
  await writeFile(file, JSON.stringify([...store.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')])));
  const start = async (clock, mode = 'normal') => {
    child = fork(new URL('./fixtures/qr-relay-worker.mjs', import.meta.url), [file, 'normal', String(clock), mode], { env: { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe','ipc'] });
    const [{ port }] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  const snapshot = async () => new Map(JSON.parse(await readFile(file, 'utf8')));
  try {
    let base = await start(START + 9 * MINUTE, phase);
    const marker = once(child, 'message');
    const pending = fetch(base + '/confirm', { method: 'POST', body: JSON.stringify({ ...BODY, videosPending: true }) }).then(r => ({ status: r.status }), () => ({ disconnected: true }));
    const [message] = await marker; assert.equal(message.phase, phase === 'pause-clock' ? 'before-clock-write' : 'clock-durable');
    const before = await snapshot(); assert.equal(before.has(META), true); assert.equal(before.has(WAIT), phase === 'pause-ack');
    const first = JSON.parse(Buffer.from(before.get(META), 'base64'));
    assert.equal(first.videoWaitStartedAt, START + 9 * MINUTE);
    const died = once(child, 'exit'); child.kill('SIGKILL'); await died; assert.deepEqual(await pending, { disconnected: true });
    base = await start(START + 11 * MINUTE);
    const response = await fetch(base + '/download/' + TOKEN); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.videoPending, true); assert.equal(Date.parse(body.expiresAt), START + 86400000);
    assert.deepEqual(Buffer.from(await (await fetch(body.photoUrl)).arrayBuffer()), Buffer.alloc(32, 7));
    assert.equal((await fetch(base + '/confirm', { method: 'POST', body: JSON.stringify({ ...BODY, videosPending: true }) })).status, 200);
    const after = await snapshot(); assert.equal(after.get(PROOF), before.get(PROOF)); assert.equal(after.get(META), before.get(META));
    assert.equal(JSON.parse(Buffer.from(after.get(WAIT), 'base64')).startedAt, first.videoWaitStartedAt);
    if (before.has(WAIT)) assert.equal(after.get(WAIT), before.get(WAIT));
  } finally { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } await rm(dir, { recursive: true, force: true }); }
});
