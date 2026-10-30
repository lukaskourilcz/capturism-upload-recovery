import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTwin } from '../server.mjs';
import diagnostics from '../candidate/diagnostics.cjs';

test('persistent diagnostics are bounded, redact payloads, survive reopen and fail safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capturism-logs-'));
  try {
    const config = { directory, maxBytes: 350, backups: 2 };
    const log = diagnostics.createDiagnostics(config);
    for (let n = 0; n < 30; n++) log.write({ stage: 'pool.put', status: 503, outcome: 'error', durationMs: 20, url: 'https://secret/?token=PRIVATE', message: 'BOOTH_KEY=PRIVATE', code: '123456', portrait: 'PRIVATE', trace: 'PRIVATE' });
    const reopened = diagnostics.createDiagnostics(config); assert.ok(reopened.write({ stage: 'page.boot', outcome: 'ok' }));
    const files = await readdir(directory); assert.ok(files.length <= 3);
    const text = (await Promise.all(files.map(f => readFile(join(directory, f), 'utf8')))).join('');
    assert.ok(!text.includes('PRIVATE')); assert.match(text, /page.boot/);
    assert.equal(log.write({ stage: 'unknown', message: 'PRIVATE' }), false);
    const blocked = diagnostics.createDiagnostics({ directory: join(log.file, 'impossible') });
    assert.equal(blocked.write({ stage: 'pool.join' }), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real pool client and QR uploader under injected first-use failures after idle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capturism-pool-')), twin = await createTwin({ root, port: 0, worker: true });
  const nativeFetch = global.fetch, oldImage = global.Image, oldDocument = global.document;
  // Node has no canvas. Only image decoding/JPEG rasterization is stubbed;
  // actual browser canvas is exercised separately in Chrome.
  global.Image = class { naturalWidth = 100; naturalHeight = 100; set src(_) { queueMicrotask(() => this.onload()); } };
  global.document = { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: callback => callback(new Blob([new Uint8Array(16 * 1024)], { type: 'image/jpeg' })) }) };
  const file = join(root, 'clients.mjs');
  await build({ stdin: { contents: "export {joinPool} from './candidate/capturism-app/src/lib/linconnu.ts'; export {uploadSessionToCloud} from './candidate/capturism-app/src/lib/relayUpload.ts';", resolveDir: resolve('.') }, outfile: file, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'adapters', setup(b) { b.onResolve({ filter: /^(\.\/boothRelay|\.\.\/store\/sessionStore)$/ }, () => ({ path: resolve('src/adapters.ts') })); } }] });
  global.fetch = (url, init) => { const u = new URL(url, twin.baseUrl); assert.equal(u.hostname, '127.0.0.1'); return nativeFetch(u, init); };
  try {
    const client = await import(pathToFileURL(file));
    for (const scenario of ['normal','idle_sign','idle_put','idle_join','idle_ack','idle_persist']) await t.test(scenario, async () => {
      await twin.simulator.start({ scenario });
      const [pool, token] = await Promise.all([
        client.joinPool({ portraitDataUrl: 'synthetic', code: '000000', sessionId: `local-test-${scenario}`, seed: true }),
        client.uploadSessionToCloud({ photo: new Blob([new Uint8Array(32 * 1024)], { type: 'image/jpeg' }) }),
      ]);
      assert.equal(pool, true); assert.ok(token);
      const state = await twin.simulator.snapshot();
      assert.equal(Object.keys(state.pool).length, 1);
      assert.equal(state.events.filter(e => e.stage === 'pool-persist').length, 1, 'only one durable entry save');
      if (['idle_join','idle_ack','idle_persist'].includes(scenario)) assert.equal(state.events.filter(e => e.stage === 'put-done' && e.key.startsWith('pool-portraits/')).length, 1, 'confirmation retries must not upload again');
      if (scenario !== 'normal') assert.ok(state.events.some(e => e.stage === 'idle-fault'));
      // A separate consenting session remains independent after recovery.
      assert.equal(await client.joinPool({ portraitDataUrl: 'synthetic', code: '000000', sessionId: `next-local-test-${scenario}`, seed: true }), true);
    });
    await t.test('concurrent and repeated calls use one entry and one PUT', async () => {
      await twin.simulator.start({ scenario: 'normal' });
      const args = { portraitDataUrl: 'synthetic', code: '000000', sessionId: 'concurrent', seed: true };
      assert.deepEqual(await Promise.all([client.joinPool(args), client.joinPool(args)]), [true, true]);
      assert.equal(await client.joinPool(args), true);
      const state = await twin.simulator.snapshot();
      assert.equal(Object.keys(state.pool).length, 1);
      assert.equal(state.events.filter(e => e.stage === 'pool-sign').length, 1);
      assert.equal(state.events.filter(e => e.stage === 'pool-persist').length, 1);
    });
    for (const boundary of ['sign','put','expired','permanent','exhausted','legacy']) await t.test(`pool retry boundary: ${boundary}`, async () => {
      await twin.simulator.start({ scenario: 'normal' });
      const localFetch = global.fetch; let injected = false, joins = 0;
      global.fetch = async (url, init) => {
        const u = new URL(url, twin.baseUrl);
        if (u.pathname === '/api/relay/pool/join') {
          joins++;
          if (boundary === 'permanent') return new Response('{}', { status: 400 });
          if (boundary === 'exhausted') return new Response('{}', { status: 503 });
        }
        const poolPut = u.pathname.startsWith('/storage/') && twin.simulator.run.signed.get(u.pathname.split('/')[2])?.key.startsWith('pool-portraits/');
        if (boundary === 'expired' && poolPut && !injected) { injected = true; return new Response('{}', { status: 403 }); }
        const response = await localFetch(url, init);
        if (boundary === 'legacy' && u.pathname.endsWith('/pool/sign-upload')) {
          const body = await response.json(); delete body.retryVersion;
          return new Response(JSON.stringify(body), { status: 200 });
        }
        if (!injected && ((boundary === 'sign' && u.pathname.endsWith('/pool/sign-upload')) || (boundary === 'put' && poolPut))) {
          injected = true; await response.arrayBuffer(); throw new TypeError('Injected lost response');
        }
        return response;
      };
      try {
        const ok = await client.joinPool({ portraitDataUrl: 'synthetic', code: '000000', sessionId: `boundary-${boundary}`, seed: true });
        assert.equal(ok, !['permanent','exhausted','legacy'].includes(boundary));
        const state = await twin.simulator.snapshot();
        assert.equal(Object.keys(state.pool).length, ok ? 1 : 0);
        assert.equal(joins, boundary === 'legacy' ? 0 : boundary === 'exhausted' ? 5 : 1);
        assert.equal(new Set([...twin.simulator.run.signed.values()].map(v => v.key)).size, 1, 'all signing and PUT retries must keep the same object');
      } finally { global.fetch = localFetch; }
    });
    await t.test('diagnostic events persist through bridge process restart and reject oversized batches', async () => {
      const body = [{ stage: 'pool.put', outcome: 'error', status: 503, trace: '12345678-abcd', uploadUrl: 'PRIVATE' }];
      const res = await nativeFetch(twin.baseUrl + '/api/diagnostics', { method: 'POST', body: JSON.stringify(body) }); assert.equal(res.status, 204);
      const oldPid = twin.simulator.worker.pid;
      await twin.simulator.stopWorker(); await twin.simulator.startWorker();
      assert.notEqual(twin.simulator.worker.pid, oldPid);
      const text = await readFile(twin.simulator.diagnostics.file, 'utf8'); assert.match(text, /12345678-abcd/); assert.ok(!text.includes('PRIVATE'));
      const oversized = await nativeFetch(twin.baseUrl + '/api/diagnostics', { method: 'POST', body: JSON.stringify(Array(51).fill(body[0])) }); assert.equal(oversized.status, 400);
    });
    // Flush best-effort diagnostics before disposing local server.
    await new Promise(r => setTimeout(r, 100));
  } finally { global.fetch = nativeFetch; global.Image = oldImage; global.document = oldDocument; await twin.close(); await rm(root, { recursive: true, force: true }); }
});
