import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTwin } from '../server.mjs';

test('QR shared deadline and recovery against local slow/idle HTTP services', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capturism-qr-network-')), twin = await createTwin({ root, port: 0, worker: false });
  const originalFetch = global.fetch, results = [], file = join(root, 'client.mjs');
  await build({ stdin: { contents: `export * from './candidate/capturism-app/src/lib/relayUpload';
    export * from './candidate/capturism-app/src/lib/qrUploadState';
    export { resetSession } from './src/adapters';`, resolveDir: resolve('.') }, outfile: file, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'loopback-only', setup(b) {
      b.onResolve({ filter: /^(\.\/boothRelay|\.\.\/store\/sessionStore)$/ }, () => ({ path: resolve('src/adapters.ts') }));
    } }] });
  global.fetch = (url, init) => { const target = new URL(url, twin.baseUrl); assert.equal(target.hostname, '127.0.0.1'); return originalFetch(target, init); };
  const client = await import(pathToFileURL(file));
  const photo = new Blob([new Uint8Array(128 * 1024)], { type: 'image/jpeg' });
  try {
    await t.test('slow photo reaches deadline, aborts transport, then recovers with same token', async () => {
      await twin.simulator.start({ scenario: 'studio', kbps: 32 }); twin.simulator.run.cfg.latency = 10;
      const start = Date.now();
      await assert.rejects(client.uploadSessionToCloud({ photo, retryForMs: 300 }), { name: 'UploadDeadlineError' });
      assert.ok(Date.now() - start < 1000);
      // Let the real HTTP disconnect reach the local storage model.
      for (let n = 0; n < 200 && twin.simulator.uplink.jobs.size; n++) await new Promise(r => setTimeout(r, 10));
      let state = await twin.simulator.snapshot(); assert.equal(Object.keys(state.sessions).length, 0); assert.equal(twin.simulator.uplink.jobs.size, 0);
      const firstToken = state.events.find(e => e.stage === 'sign').token;
      twin.simulator.uplink.rate = 1024 * 1024;
      assert.equal(await client.retryQrUpload(), firstToken);
      state = await twin.simulator.snapshot(); assert.equal(Object.keys(state.sessions).length, 1);
      assert.equal(new Set(state.events.filter(e => e.stage === 'sign').map(e => e.token)).size, 1);
      results.push({ scenario: 'slow-timeout-and-explicit-recovery', deadlineMs: 300, events: state.events }); client.resetSession();
    });
    for (const scenario of ['idle_sign','idle_put','qr_idle_confirm','qr_idle_ack','qr_idle_save']) await t.test(scenario, async () => {
      await twin.simulator.start({ scenario }); twin.simulator.run.cfg.latency = 10;
      const start = Date.now(), token = await client.uploadSessionToCloud({ photo: new Blob([new Uint8Array(16384)]), retryForMs: 5000 });
      assert.ok(Date.now() - start < 5000);
      const state = await twin.simulator.snapshot(); assert.ok(state.sessions[token]); assert.equal(Object.keys(state.sessions).length, 1);
      assert.equal(state.events.filter(e => e.stage === 'put-done').length, 1);
      assert.equal(new Set(state.events.filter(e => e.stage === 'sign').map(e => e.token)).size, 1);
      const metadata = state.sessions[token];
      assert.equal((await originalFetch(twin.baseUrl + '/lab/restart-relay', { method: 'POST' })).status, 200);
      const afterRestart = await originalFetch(twin.baseUrl + '/api/download/' + token);
      assert.equal(afterRestart.status, 200); assert.deepEqual(await afterRestart.json(), metadata);
      results.push({ scenario, budgetMs: 5000, elapsedMs: Date.now() - start, events: state.events }); client.resetSession();
    });
    await t.test('cold signing wait expires without late QR, then works when relay wakes', async () => {
      await twin.simulator.start({ scenario: 'cold' }); twin.simulator.run.cfg.latency = 10; twin.simulator.run.coldUntil = Date.now() + 300;
      await assert.rejects(client.uploadSessionToCloud({ photo, retryForMs: 100 }), { name: 'UploadDeadlineError' });
      assert.equal(client.getQrUploadState().phase, 'failed');
      const token = await client.retryQrUpload(); assert.ok((await twin.simulator.snapshot()).sessions[token]); client.resetSession();
    });
    await writeFile('test-results/qr-network-recovery.json', JSON.stringify({ note: 'Real local HTTP/bytes and aborts. Shortened budgets/cold-start interval; not real Windows idle or provider behavior.', results }, null, 2));
  } finally { global.fetch = originalFetch; await twin.close(); await rm(root, { recursive: true, force: true }); }
});
