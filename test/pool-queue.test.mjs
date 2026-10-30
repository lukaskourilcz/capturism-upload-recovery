import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import queueModule from '../candidate/pool-queue.cjs';
import { createTwin } from '../server.mjs';

const payload = sessionId => ({ sessionId, code: '000000', seed: true, photoBase64: Buffer.alloc(16000, 7).toString('base64') });
const waitFor = async check => { const end = Date.now() + 10000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Recovery did not finish'); };

test('pool queue atomic persistence, duplicate handoffs, incomplete writes and disk failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-durable-'));
  try {
    const queue = queueModule.createPoolQueue({ directory: dir, boothId: 'local' });
    const body = payload('durable'); assert.equal(queue.enqueue(body).queued, true);
    const file = (await readdir(dir))[0], saved = await readFile(join(dir, file), 'utf8');
    assert.equal(queue.enqueue(body).queued, true); assert.equal((await readdir(dir)).length, 1);
    assert.throws(() => queue.enqueue({ ...body, photoBase64: Buffer.alloc(4).toString('base64') }), e => e.status === 409);
    assert.equal(queueModule.createPoolQueue({ directory: dir, boothId: 'local' }).status()[0].phase, 'pending');
    await writeFile(join(dir, 'a'.repeat(64) + '.json.123456abcdef.part'), 'partial');
    assert.equal(queue.status().length, 1); assert.equal((await readdir(dir)).length, 1);
    // Simulate interrupted checkpoint replacement. Old acknowledged bytes survive.
    const rename = fs.renameSync;
    try {
      fs.renameSync = () => { throw new Error('Injected disk error'); };
      assert.throws(() => queueModule.atomicJSON(join(dir, file), { broken: true }), /disk/);
    } finally { fs.renameSync = rename; }
    assert.equal(await readFile(join(dir, file), 'utf8'), saved);
    const bad = queueModule.createPoolQueue({ directory: join(dir, file), boothId: 'local' });
    assert.throws(() => bad.enqueue(payload('disk-fail')));
    const quota = join(dir, 'quota-test.bin'); fs.closeSync(fs.openSync(quota, 'w')); fs.truncateSync(quota, 1024 * 1024 * 1024);
    assert.throws(() => queue.enqueue(payload('queue-full')), e => e.status === 507); fs.unlinkSync(quota);
    const corrupt = JSON.parse(saved); corrupt.photoBase64 = Buffer.alloc(5).toString('base64');
    await writeFile(join(dir, file), JSON.stringify(corrupt));
    assert.equal(queue.status()[0].phase, 'corrupt');
    assert.equal(queueModule.delayFor(1), 60000); assert.equal(queueModule.delayFor(99), 1800000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('durable worker recovers every idle fault without duplicate entries or lost checkpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capturism-durable-idle-')), twin = await createTwin({ root, port: 0, worker: false });
  try {
    for (const scenario of ['normal','idle_sign','idle_put','idle_join','idle_ack','idle_persist']) await t.test(scenario, async () => {
      await twin.simulator.start({ scenario }); let clock = Date.now();
      const directory = join(root, 'queue-' + scenario);
      const options = { directory, relayUrl: twin.baseUrl, boothId: 'local-twin', boothKey: 'local-only', bytesPerSecond: 1024 * 1024, now: () => clock };
      let queue = queueModule.createPoolQueue(options); const body = payload('idle-' + scenario); queue.enqueue(body);
      await queue.tick(); queue.stop(); // discard the queue object, just like losing process memory
      queue = queueModule.createPoolQueue(options); clock += 60001; await queue.tick();
      // Some scenarios need a first-use signing retry, then a first-use PUT retry.
      clock += 120001; await queue.tick();
      assert.equal(queue.status()[0].phase, 'done');
      const state = await twin.simulator.snapshot(); assert.equal(Object.keys(state.pool).length, 1);
      assert.equal(state.events.filter(e => e.stage === 'pool-persist').length, 1);
      if (['idle_join','idle_ack','idle_persist'].includes(scenario)) assert.equal(state.events.filter(e => e.stage === 'put-done').length, 1);
      assert.equal(queue.enqueue(body).delivered, true);
      const receipt = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), 'utf8'));
      assert.equal(receipt.photoBase64, undefined); assert.equal(receipt.code, undefined); assert.equal(receipt.sessionId, undefined);
    });
    await t.test('outage backoff and expired jobs retain portrait for attention', async () => {
      await twin.simulator.start({ scenario: 'offline' }); let clock = Date.now(); const directory = join(root, 'expiry');
      const queue = queueModule.createPoolQueue({ directory, relayUrl: twin.baseUrl, boothId: 'local-twin', boothKey: 'local', now: () => clock });
      queue.enqueue(payload('expiry')); await queue.tick(); assert.equal(queue.status()[0].attempts, 1);
      await queue.tick(); assert.equal(queue.status()[0].attempts, 1, 'must not busy-loop');
      clock += 25 * 3600000; await queue.tick(); assert.equal(queue.status()[0].phase, 'blocked');
      const job = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), 'utf8')); assert.ok(job.photoBase64);
    });
    await t.test('stale pending backup is cancelled after withdrawal and local sensitive bytes are scrubbed', async () => {
      await twin.simulator.start({ scenario: 'normal' });
      const directory = join(root, 'withdrawn-queue');
      const options = { directory, relayUrl: twin.baseUrl, boothId: 'local-twin', boothKey: 'local-only', bytesPerSecond: 1024 * 1024 };
      const queue = queueModule.createPoolQueue(options), body = payload('withdrawn-backup'); queue.enqueue(body);
      const file = join(directory, (await readdir(directory))[0]), backup = await readFile(file, 'utf8');
      await queue.tick(); assert.equal(queue.status()[0].phase, 'done');
      const id = Object.keys(twin.simulator.run.pool)[0];
      const res = await fetch(twin.baseUrl + '/lab/pool-withdraw', { method: 'POST', body: JSON.stringify({ entryId: id }) }); assert.equal(res.status, 200);
      await writeFile(file, backup);
      const restarted = queueModule.createPoolQueue(options); await restarted.tick();
      assert.equal(restarted.status()[0].phase, 'withdrawn');
      const receipt = JSON.parse(await readFile(file, 'utf8')); assert.equal(receipt.photoBase64, undefined); assert.equal(receipt.code, undefined);
      assert.equal(Object.keys(twin.simulator.run.pool).length, 0);
      assert.throws(() => restarted.enqueue(body), e => e.status === 410);
    });
    await t.test('old uploaded checkpoints migrate through v2 without a new identity or duplicate', async () => {
      await twin.simulator.start({ scenario: 'normal' });
      const directory = join(root, 'old-uploaded');
      const options = { directory, relayUrl: twin.baseUrl, boothId: 'local-twin', boothKey: 'local-only', bytesPerSecond: 1024 * 1024 };
      const queue = queueModule.createPoolQueue(options), body = payload('old-uploaded'); queue.enqueue(body);
      const file = join(directory, (await readdir(directory))[0]), pending = JSON.parse(await readFile(file, 'utf8'));
      pending.phase = 'uploaded'; pending.entryId = pending.id.slice(0, 16); pending.key = `pool-portraits/${pending.entryId}.jpg`;
      await writeFile(file, JSON.stringify(pending));
      const restarted = queueModule.createPoolQueue(options); await restarted.tick();
      assert.equal(restarted.status()[0].phase, 'done');
      assert.deepEqual(Object.keys(twin.simulator.run.pool), [pending.entryId]);
      assert.equal(restarted.enqueue(body).delivered, true);
      assert.equal(twin.simulator.events.filter(e => e.stage === 'pool-persist').length, 1);
    });
  } finally { await twin.close(); await rm(root, { recursive: true, force: true }); }
});

test('acknowledged portrait survives abrupt bridge death during PUT; new process delivers once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capturism-durable-process-')), twin = await createTwin({ root, port: 0 });
  try {
    await twin.simulator.start({ scenario: 'normal' });
    const body = payload('process-crash');
    const enqueue = async () => fetch(twin.baseUrl + '/api/pool-queue', { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await enqueue()).status, 200);
    // Browser is now absent: all subsequent delivery is owned by child processes.
    twin.simulator.uplink.rate = 100;
    await twin.simulator.stopWorker(); await twin.simulator.startWorker();
    await waitFor(() => twin.simulator.events.some(e => e.stage === 'put-start'));
    const old = twin.simulator.worker, died = once(old, 'exit'); old.kill('SIGKILL'); await died;
    await twin.simulator.stopWorker(); twin.simulator.uplink.rate = 1024 * 1024;
    await twin.simulator.startWorker(); assert.notEqual(twin.simulator.worker.pid, old.pid);
    await waitFor(async () => (await twin.simulator.snapshot()).poolQueue.some(j => j.phase === 'done'));
    assert.equal(Object.keys(twin.simulator.run.pool).length, 1);
    assert.equal(twin.simulator.events.filter(e => e.stage === 'pool-persist').length, 1);
    assert.equal((await enqueue()).status, 200);
    assert.equal((await twin.simulator.snapshot()).poolQueue.length, 1);
  } finally { await twin.close(); await rm(root, { recursive: true, force: true }); }
});

test('actual browser handoff retries a lost local ACK and survives browser disappearance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capturism-durable-browser-')), twin = await createTwin({ root, port: 0 });
  const oldFetch = global.fetch, oldImage = global.Image, oldDocument = global.document, oldReader = global.FileReader;
  global.Image = class { naturalWidth = 100; naturalHeight = 100; set src(_) { queueMicrotask(() => this.onload()); } };
  global.document = { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: cb => cb(new Blob([Buffer.alloc(16000, 7)], { type: 'image/jpeg' })) }) };
  global.FileReader = class { readAsDataURL(blob) { void blob.arrayBuffer().then(buffer => { this.result = 'data:image/jpeg;base64,' + Buffer.from(buffer).toString('base64'); this.onload(); }); } };
  const file = join(root, 'browser.mjs');
  await build({ entryPoints: [resolve('candidate/capturism-app/src/lib/linconnu.ts')], outfile: file, bundle: true, platform: 'node', format: 'esm' });
  let acks = 0;
  global.fetch = async (url, options) => {
    const u = new URL(url, twin.baseUrl); assert.equal(u.hostname, '127.0.0.1');
    const response = await oldFetch(u, options);
    if (url === '/api/pool-queue' && ++acks === 1) { await response.arrayBuffer(); throw new TypeError('Lost local acknowledgement'); }
    return response;
  };
  try {
    await twin.simulator.start({ scenario: 'normal' });
    const browser = await import(pathToFileURL(file));
    const args = { portraitDataUrl: 'synthetic', code: '000000', sessionId: 'closed-browser', seed: true };
    assert.deepEqual(await Promise.all([browser.joinPool(args), browser.joinPool(args)]), [true, true]);
    assert.equal(acks, 2);
    assert.equal((await twin.simulator.snapshot()).poolQueue.length, 1);
    // Restore the browser environment: no client remains to finish delivery.
    global.fetch = oldFetch; global.Image = oldImage; global.document = oldDocument; global.FileReader = oldReader;
    await twin.simulator.stopWorker(); await twin.simulator.startWorker();
    await waitFor(async () => (await twin.simulator.snapshot()).poolQueue.some(j => j.phase === 'done'));
    assert.equal(Object.keys(twin.simulator.run.pool).length, 1);
  } finally {
    global.fetch = oldFetch; global.Image = oldImage; global.document = oldDocument; global.FileReader = oldReader;
    await twin.close(); await rm(root, { recursive: true, force: true });
  }
});

test('generic HTTP 410 never erases an acknowledged portrait', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(410); res.end('Generic gateway error'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const directory = await mkdtemp(join(tmpdir(), 'capturism-gone-'));
  try {
    const queue = queueModule.createPoolQueue({ directory, relayUrl: `http://127.0.0.1:${server.address().port}`, boothId: 'local', boothKey: 'local' });
    const body = payload('generic-gone'); queue.enqueue(body); await queue.tick();
    assert.equal(queue.status()[0].phase, 'blocked');
    const job = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), 'utf8')); assert.equal(job.photoBase64, body.photoBase64);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }); }
});
