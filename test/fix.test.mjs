import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createTwin } from '../server.mjs';

test('missing QR reproduction and candidate fix against the same slow uplink', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capturism-fix-'));
  const twin = await createTwin({ port: 0, root, worker: false });
  const nativeFetch = global.fetch, results = [];
  const bundle = join(root, 'comparison.mjs');
  await build({ stdin: { contents: `export * as baseline from './vendor/relayUpload.ts';
    export * as candidate from './candidate/capturism-app/src/lib/relayUpload.ts';
    export { resetSession } from './src/adapters.ts';
    export * from './candidate/capturism-app/src/lib/qrWaitPolicy.ts';`, resolveDir: resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'local-boundaries', setup(b) {
      b.onResolve({ filter: /^(\.\/boothRelay|\.\.\/store\/sessionStore)$/ }, () => ({ path: resolve('src/adapters.ts') }));
    } }] });
  global.fetch = (url, options) => {
    const target = new URL(url, twin.baseUrl);
    assert.equal(target.hostname, '127.0.0.1'); return nativeFetch(target, options);
  };
  const modules = await import(pathToFileURL(bundle));
  const photo = new Blob([new Uint8Array(1024 * 1024)], { type: 'image/jpeg' });
  try {
    for (const version of ['baseline', 'candidate']) await t.test(`${version}: 1 MiB photo, 125 KiB/s, shortened 4-second idle window`, async () => {
      await twin.simulator.start({ scenario: 'studio' }); modules.resetSession();
      const resetMs = version === 'candidate'
        ? modules.qrInactivityDelay({ needsQr: true, hasToken: false, scanWindowMs: 4000 }) : 4000;
      const start = Date.now(); let reset = false;
      const timer = setTimeout(() => { reset = true; modules.resetSession(); }, resetMs);
      let token, error;
      try { token = await modules[version].uploadSessionToCloud({ photo, retryForMs: 60000 }); }
      catch (e) { error = e.message; }
      finally { clearTimeout(timer); }
      const snapshot = await twin.simulator.snapshot();
      assert.equal(snapshot.events.filter(e => e.stage === 'confirmed').length, 1, 'both runs must actually finish storing the same-size photo');
      if (version === 'baseline') { assert.equal(reset, true); assert.match(error, /session ended/); assert.equal(token, undefined); }
      else { assert.equal(reset, false); assert.ok(token); assert.equal(error, undefined); }
      results.push({ version, photoBytes: photo.size, uplinkKiBps: 125, originalIdleWindowMs: 4000, pendingTimeoutMs: resetMs, elapsedMs: Date.now() - start, qrReady: !!token, reset, error, events: snapshot.events });
    });
    await t.test('candidate retries confirmation without uploading the photo twice', async () => {
      await twin.simulator.start({ scenario: 'confirm' }); modules.resetSession();
      const token = await modules.candidate.uploadSessionToCloud({ photo: new Blob([new Uint8Array(100 * 1024)]), retryForMs: 60000 });
      const snapshot = await twin.simulator.snapshot();
      assert.equal(snapshot.events.filter(e => e.stage === 'commit-failed').length, 5);
      assert.equal(snapshot.events.filter(e => e.stage === 'put-done').length, 1);
      assert.equal(snapshot.events.filter(e => e.stage === 'sign').length, 1);
      assert.ok(snapshot.sessions[token]);
    });
    await t.test('candidate still rejects a late token after explicit restart', async () => {
      await twin.simulator.start({ scenario: 'studio' }); modules.resetSession();
      const pending = modules.candidate.uploadSessionToCloud({ photo: new Blob([new Uint8Array(125 * 1024)]) });
      const rejected = assert.rejects(pending, /session ended before the upload finished/);
      setTimeout(modules.resetSession, 100); await rejected;
    });
    await t.test('real production timer values: pending 10 minutes, fresh scanning window 5 minutes', () => {
      assert.equal(modules.qrInactivityDelay({ needsQr: true, hasToken: false }), 600000);
      assert.equal(modules.qrInactivityDelay({ needsQr: true, hasToken: true }), 300000);
      assert.equal(modules.qrInactivityDelay({ needsQr: false, hasToken: false }), 300000);
    });
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/slow-upload-comparison.json', JSON.stringify({ note: 'Accelerated 4-second kiosk deadline; real bytes, real uplink and uploader retry timings. Production has 5/10-minute windows. This reproduces a failure mechanism, not the exact historical incident.', results }, null, 2));
  } finally { global.fetch = nativeFetch; await twin.close(); await rm(root, { recursive: true, force: true }); }
});
