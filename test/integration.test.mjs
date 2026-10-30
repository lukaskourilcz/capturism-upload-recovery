import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createTwin } from '../server.mjs';
import { Uplink } from '../simulator.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nativeFetch = global.fetch;
async function waitFor(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(100); }
  throw new Error('Condition did not become true');
}

test('pinned production source remains byte-for-byte intact', async () => {
  const manifest = JSON.parse(await readFile(new URL('../vendor/provenance.json', import.meta.url)));
  for (const [name, hash] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL('../vendor/' + name, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name);
  }
});

test('original queue regression tests pass in a disposable directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-queue-'));
  try {
    await copyFile(new URL('../vendor/video-queue.cjs', import.meta.url), join(dir, 'video-queue.js'));
    await copyFile(new URL('../vendor/video-queue.test.cjs', import.meta.url), join(dir, 'video-queue.test.js'));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', join(dir, 'video-queue.test.js')], { env });
    assert.match(stdout, /pass 5/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('simulated bandwidth is shared across concurrent uploads', async () => {
  const link = new Uplink(100 * 1024), start = Date.now();
  try {
    await Promise.all([link.transfer(100 * 1024), link.transfer(100 * 1024)]);
    assert.ok(Date.now() - start >= 1800, 'two uploads must share capacity instead of each getting full speed');
    const controller = new AbortController();
    const pending = link.transfer(1000000, controller.signal); controller.abort();
    await assert.rejects(pending, /aborted/); assert.equal(link.jobs.size, 0);
  } finally { link.close(); }
});

test('original browser uploader works against local relay/storage boundaries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capturism-twin-'));
  const twin = await createTwin({ port: 0, root });
  const post = async (path, body) => {
    const res = await nativeFetch(twin.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200); return res.json();
  };
  const bundle = join(root, 'uploader.mjs');
  await build({ stdin: { contents: "export * from './vendor/relayUpload.ts'; export {resetSession} from './src/adapters.ts';", resolveDir: resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'test-boundaries', setup(b) { b.onResolve({ filter: /^(\.\/boothRelay|\.\.\/store\/sessionStore)$/ }, () => ({ path: resolve('src/adapters.ts') })); } }] });
  global.fetch = (url, options) => {
    const target = new URL(url, twin.baseUrl);
    assert.equal(target.hostname, '127.0.0.1', 'uploader and queue proxy must never leave local services');
    return nativeFetch(target, options);
  };
  try {
    const uploader = await import(pathToFileURL(bundle));
    await uploader.probeCloudUploadConfigured();
    const photo = new Blob([new Uint8Array(100 * 1024)], { type: 'image/jpeg' });
    await t.test('photo is stored before token returns and download resolves it', async () => {
      await post('/lab/start', { scenario: 'normal' });
      const token = await uploader.uploadSessionToCloud({ photo });
      const state = await twin.simulator.snapshot();
      assert.ok(state.sessions[token]);
      const stages = state.events.map(e => e.stage);
      assert.ok(stages.indexOf('put-done') < stages.indexOf('confirmed'));
      const download = await nativeFetch(twin.baseUrl + '/api/download/' + token);
      assert.equal(download.status, 200);
      const session = await download.json();
      const object = await nativeFetch(twin.baseUrl + '/lab/object?key=' + encodeURIComponent(session.photoKey));
      assert.equal((await object.arrayBuffer()).byteLength, photo.size);
    });
    await t.test('five confirmation failures trigger retries and eventual recovery', async () => {
      await post('/lab/start', { scenario: 'confirm' });
      const token = await uploader.uploadSessionToCloud({ photo, retryForMs: 60000 });
      const state = await twin.simulator.snapshot();
      assert.equal(state.events.filter(e => e.stage === 'commit-failed').length, 5);
      assert.ok(state.sessions[token]);
      assert.equal(new Set(state.events.filter(e => e.stage === 'sign').map(e => e.token)).size, 1, 'outer retry must preserve token');
    });
    await t.test('reset during a slow photo upload rejects the late token', async () => {
      await post('/lab/start', { scenario: 'studio', kbps: 50 });
      const result = uploader.uploadSessionToCloud({ photo });
      const rejected = assert.rejects(result, /session ended before the upload finished/);
      await sleep(250); uploader.resetSession(); await rejected;
      assert.ok((await twin.simulator.snapshot()).events.some(e => e.stage === 'confirmed'), 'server may commit; browser must refuse late token');
    });
    await t.test('temporary outage recovers through the original signing retries', async () => {
      await post('/lab/start', { scenario: 'offline' });
      twin.simulator.run.cfg.offline = 2; // Short fault duration; uploader timings remain unchanged.
      const token = await uploader.uploadSessionToCloud({ photo });
      const state = await twin.simulator.snapshot();
      assert.ok(state.events.some(e => e.stage === 'network'));
      assert.ok(state.sessions[token]);
    });
    await t.test('original video queue survives a process restart and delivers both clips', async () => {
      await post('/lab/start', { scenario: 'normal' });
      const video = new Blob([new Uint8Array(20000)], { type: 'video/webm' });
      const token = await uploader.uploadSessionToCloud({ photo, layoutVideo: video, storyVideo: video });
      await waitFor(async () => (await twin.simulator.snapshot()).queue.length === 2);
      await post('/lab/restart-bridge', {});
      assert.equal((await twin.simulator.snapshot()).queue.length, 2);
      await waitFor(async () => {
        const session = (await twin.simulator.snapshot()).sessions[token];
        return !!(session.layoutVideoKey && session.storyVideoKey);
      });
      assert.equal((await twin.simulator.snapshot()).queue.length, 0);
    });
    await t.test('local service rejects cross-origin control and traversal', async () => {
      const cross = await nativeFetch(twin.baseUrl + '/lab/start', { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' });
      assert.equal(cross.status, 403);
      const bad = await nativeFetch(twin.baseUrl + '/api/relay/sign-upload', { method: 'POST', body: JSON.stringify({ token: '../secrets', kind: 'photo', contentType: 'image/jpeg' }) });
      assert.equal(bad.status, 400);
    });
  } finally { global.fetch = nativeFetch; await twin.close(); await rm(root, { recursive: true, force: true }); }
});
