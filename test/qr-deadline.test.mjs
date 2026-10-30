import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('QR absolute deadline and same-session recovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capturism-qr-budget-'));
  const file = join(directory, 'qr.mjs'), originalFetch = global.fetch;
  await build({ stdin: { contents: `export * from './candidate/capturism-app/src/lib/relayUpload';
    export * from './candidate/capturism-app/src/lib/qrUploadState';
    export * from './candidate/capturism-app/src/lib/qrWaitPolicy';
    export { resetSession, getSessionEpoch } from './src/adapters';`, resolveDir: resolve('.') }, outfile: file, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'local-only', setup(b) {
      b.onResolve({ filter: /^(\.\/boothRelay|\.\.\/store\/sessionStore)$/ }, () => ({ path: resolve('src/adapters.ts') }));
    } }] });
  const json = body => new Response(JSON.stringify(body));
  const photo = new Blob([new Uint8Array(100)], { type: 'image/jpeg' });
  let serial = 0;
  async function setup(handler = () => {}) {
    const calls = { sign: 0, put: 0, confirm: 0, signals: [] };
    global.fetch = async (url, init = {}) => {
      const path = String(url);
      if (path.includes('diagnostics') || path.includes('configured')) return json({ configured: true });
      const stage = path.includes('sign-upload') ? 'sign' : init.method === 'PUT' ? 'put' : 'confirm';
      calls[stage]++; calls.signals.push(init.signal);
      const value = handler(stage, calls, init);
      if (value !== undefined) return value;
      return stage === 'sign' ? json({ token: 'same-token', key: 'sessions/same-token/photo.jpg', uploadUrl: 'https://storage.invalid/photo' }) : json({ ok: true });
    };
    const client = await import(pathToFileURL(file).href + '?' + serial++);
    return { client, calls };
  }
  try {
    for (const boundary of ['sign', 'put', 'confirm', 'sign-body', 'confirm-body']) await t.test(`stalled ${boundary} cannot outlive the whole-flow deadline`, async () => {
      const { client, calls } = await setup(stage => {
        if (stage === boundary) return new Promise(() => {}); // deliberately ignores abort
        if (boundary === stage + '-body') return { ok: true, json: () => new Promise(() => {}), text: () => new Promise(() => {}) };
      });
      const start = Date.now();
      await assert.rejects(client.uploadSessionToCloud({ photo, retryForMs: 120 }), { name: 'UploadDeadlineError' });
      assert.ok(Date.now() - start < 700);
      assert.equal(client.getQrUploadState().phase, 'failed'); assert.equal(client.getQrUploadState().reason, 'timeout');
      assert.equal(client.getQrUploadState().canRetry, true);
      assert.ok(calls.signals.at(-1).aborted);
      client.resetSession(); assert.equal(client.getQrUploadState().phase, 'idle');
    });
    await t.test('the same deadline includes multiple stages and backoff; touch never renews it', async () => {
      const { client, calls } = await setup(stage => stage === 'put' ? new Response('', { status: 503 }) : undefined);
      const pending = client.uploadSessionToCloud({ photo, retryForMs: 120 });
      const rejected = assert.rejects(pending, { name: 'UploadDeadlineError' });
      const { deadlineAt } = client.getQrUploadState();
      assert.equal(client.qrInactivityDelay({ needsQr: true, hasToken: false, deadlineAt, now: deadlineAt - 20 }), 20);
      await rejected;
      assert.equal(calls.sign, 1); assert.equal(calls.put, 1); assert.equal(calls.confirm, 0);
      assert.equal(client.qrInactivityDelay({ needsQr: true, hasToken: false, failed: true }), 300000);
      client.resetSession();
    });
    await t.test('lost confirmation response recovers without re-uploading, re-signing or creating another token', async () => {
      let recover = false;
      const { client, calls } = await setup(stage => stage === 'confirm' && !recover ? new Promise(() => {}) : undefined);
      await assert.rejects(client.uploadSessionToCloud({ photo, retryForMs: 120 }), { name: 'UploadDeadlineError' });
      recover = true;
      const token = await client.retryQrUpload();
      assert.equal(token, 'same-token'); assert.equal(calls.sign, 1); assert.equal(calls.put, 1); assert.equal(calls.confirm, 2);
      assert.equal(client.getQrUploadState().phase, 'ready');
      await assert.rejects(client.retryQrUpload(), /No QR retry/);
      client.resetSession();
    });
    await t.test('recovery after a PUT timeout keeps its token and concurrent retry taps start one flow', async () => {
      let recover = false; const signTokens = [];
      const { client, calls } = await setup((stage, _, init) => {
        if (stage === 'sign') signTokens.push(JSON.parse(init.body).token);
        if (stage === 'put' && !recover) return new Promise(() => {});
      });
      await assert.rejects(client.uploadSessionToCloud({ photo, retryForMs: 120 }), { name: 'UploadDeadlineError' });
      recover = true; const first = client.retryQrUpload(); const duplicate = client.retryQrUpload().catch(error => error);
      assert.equal(await first, 'same-token'); await duplicate;
      assert.deepEqual(signTokens, [undefined, 'same-token']); assert.equal(calls.put, 2); assert.equal(calls.confirm, 1);
      client.resetSession();
    });
    await t.test('restart cancels a stuck request and clears recovery before the next customer', async () => {
      const { client, calls } = await setup(() => new Promise(() => {}));
      const pending = client.uploadSessionToCloud({ photo, retryForMs: 600000 });
      const rejected = assert.rejects(pending, /session ended/); client.resetSession(); await rejected;
      assert.equal(client.getQrUploadState().phase, 'idle'); assert.ok(calls.signals[0].aborted);
      await assert.rejects(client.retryQrUpload(), /No QR retry/);
      await assert.rejects(client.uploadSessionToCloud({ photo, sessionEpoch: client.getSessionEpoch() - 1 }), /session ended/);
    });
    await t.test('late non-cooperative success never publishes a QR after expiry/reset', async () => {
      let resolve;
      const { client } = await setup(stage => stage === 'confirm' ? new Promise(r => { resolve = r; }) : undefined);
      await assert.rejects(client.uploadSessionToCloud({ photo, retryForMs: 120 }), { name: 'UploadDeadlineError' });
      client.resetSession(); resolve(json({ ok: true }));
      await new Promise(r => setImmediate(r));
      assert.equal(client.getQrUploadState().phase, 'idle'); assert.equal(client.getQrUploadState().token, undefined);
    });
    await t.test('default legacy path has one two-minute budget and no automatic outer retry', async () => {
      const { client } = await setup(() => new Promise(() => {}));
      const before = Date.now(), pending = client.uploadSessionToCloud({ photo }), after = Date.now();
      const rejected = assert.rejects(pending, /session ended/);
      try {
        const deadlineAt = client.getQrUploadState().deadlineAt;
        // Root creation is synchronous but not necessarily in the same
        // clock millisecond as the caller's first timestamp.
        assert.ok(deadlineAt >= before + client.DEFAULT_UPLOAD_DEADLINE_MS);
        assert.ok(deadlineAt <= after + client.DEFAULT_UPLOAD_DEADLINE_MS);
        assert.equal(client.DEFAULT_UPLOAD_DEADLINE_MS, 120000);
      } finally { client.resetSession(); await rejected; }
    });
    await t.test('preparation failure exposes studio help without inventing a retry or download URL', async () => {
      const { client } = await setup(); client.expireQrUpload();
      assert.equal(client.getQrUploadState().phase, 'failed'); assert.equal(client.getQrUploadState().canRetry, false);
      await assert.rejects(client.retryQrUpload()); client.resetSession();
    });
  } finally { global.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});
