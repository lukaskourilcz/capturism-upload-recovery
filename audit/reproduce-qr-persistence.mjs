// Evidence of a pre-existing relay boundary not modeled by the upload twin.
// Success here means the unsafe acknowledgement was reproduced, not fixed.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

class PutObjectCommand { constructor(input) { this.input = input; } }
class GetObjectCommand { constructor(input) { this.input = input; } }
function functions(source) {
  const handler = source.slice(source.indexOf('function handlePhotosReady('), source.indexOf('/**\n * POST /api/dev/seed'));
  const storage = source.slice(source.indexOf('async function storeSession('), source.indexOf('/**\n * Presign an R2 GET.'));
  const download = source.slice(source.indexOf('async function handleGetDownload('), source.indexOf('/**\n * GET /api/proxy/:token/'));
  assert.match(handler, /function handlePhotosReady/); assert.match(storage, /async function loadSession/);
  assert.match(download, /async function handleGetDownload/);
  return handler + '\n' + storage + '\n' + download;
}
function relay(code, objects, failWrites) {
  const context = {
    sessions: new Map(), SESSION_TTL_MS: 86400000, R2_BUCKET: 'isolated-local-fixture',
    PutObjectCommand, GetObjectCommand, Buffer, Date, console: { log() {}, warn() {}, error() {} },
    authenticateBooth: () => 'synthetic-booth', broadcastToAdmins() {},
    readBody: (req, callback) => { void callback(JSON.stringify(req.body)); },
    jsonResponse: (res, status, body) => res.resolve({ status, body }),
    r2Client: { async send(command) {
      const { Key, Body } = command.input;
      if (command instanceof PutObjectCommand) {
        if (failWrites) throw new Error('Injected metadata storage outage');
        objects.set(Key, Body); return {};
      }
      if (!objects.has(Key)) throw Object.assign(new Error('No such key'), { name: 'NoSuchKey' });
      return { Body: [Buffer.from(objects.get(Key))] };
    } },
  };
  vm.createContext(context); vm.runInContext(code, context); return context;
}
const results = [];
for (const [version, path] of [
  ['baseline', new URL('../../diagnosis-2026-10-30/capturism-main/capturism-relay/server.js', import.meta.url)],
  ['candidate', new URL('../candidate/capturism-relay/server.js', import.meta.url)],
]) {
  const code = functions(await readFile(path, 'utf8')), objects = new Map();
  const first = relay(code, objects, true), body = { token: 'synthetic-token', photoKey: 'sessions/synthetic-token/photo.jpg' };
  objects.set(body.photoKey, Buffer.alloc(32, 7)); // earlier photo PUT succeeded
  const ack = await new Promise(resolve => first.handlePhotosReady({ body }, { resolve }));
  const visibleBeforeRestart = Boolean(await first.loadSession(body.token));
  const afterRestart = relay(code, objects, false);
  const visibleAfterRestart = Boolean(await afterRestart.loadSession(body.token));
  const downloadAfterRestart = await new Promise(resolve => { void afterRestart.handleGetDownload({}, { resolve }, body.token); });
  assert.equal(ack.status, 200); assert.equal(ack.body.ok, true);
  assert.equal(visibleBeforeRestart, true); assert.equal(visibleAfterRestart, false);
  assert.equal(downloadAfterRestart.status, 404);
  results.push({ version, metadataSaveFailed: true, acknowledgement: ack.status, ok: ack.body.ok,
    visibleBeforeRestart, visibleAfterRestart, downloadAfterRestartStatus: downloadAfterRestart.status,
    photoStillStored: objects.has(body.photoKey), durableMetadataObjects: [...objects.keys()].filter(key => key.endsWith('/meta.json')).length });
}
console.log(JSON.stringify({ interpretation: 'Unsafe behavior reproduced in baseline and candidate; not a passing durability guarantee. No network/provider calls.', results }, null, 2));
