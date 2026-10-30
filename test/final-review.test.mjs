import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import url from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import queueModule from '../candidate/pool-queue.cjs';

const payload = sessionId => ({ sessionId, code: '000000', seed: false, photoBase64: Buffer.alloc(32, 3).toString('base64') });
const entryId = identity => crypto.createHash('sha256').update(JSON.stringify(['local', identity.sessionId, identity.code])).digest('hex').slice(0, 16);
async function endpoint(handler) {
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

test('a deferred or corrupt pool item does not prevent another due item from delivering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capturism-review-fairness-'));
  const received = [];
  const relay = await endpoint(async (req, res) => {
    const identity = JSON.parse(Buffer.from(req.headers['x-pool-upload'], 'base64').toString());
    for await (const _ of req) { /* actual local HTTP body */ }
    received.push(identity.sessionId);
    res.writeHead(identity.sessionId === 'deferred' ? 503 : 200);
    res.end(JSON.stringify({ ok: true, publicationVersion: 2, entryId: entryId(identity) }));
  });
  try {
    const queue = queueModule.createPoolQueue({ directory, relayUrl: relay.base, boothId: 'local', boothKey: 'synthetic', bytesPerSecond: 1024 * 1024 });
    queue.enqueue(payload('deferred')); queue.enqueue(payload('healthy'));
    await writeFile(join(directory, 'f'.repeat(64) + '.json'), '{}');
    await queue.tick();
    assert.deepEqual(received.sort(), ['deferred','healthy']);
    assert.equal(queue.status().filter(job => job.phase === 'done').length, 1);
    assert.equal(queue.status().filter(job => job.phase === 'pending' && job.attempts === 1).length, 1);
    assert.equal(queue.status().filter(job => job.phase === 'corrupt').length, 1);
    await queue.tick(); assert.equal(received.length, 2, 'backoff must skip the failed job');
  } finally { await relay.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed local completion receipt after a remote ACK recovers after restart with one identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capturism-review-receipt-'));
  const committed = new Set(); let calls = 0, clock = Date.now();
  const relay = await endpoint(async (req, res) => {
    const identity = JSON.parse(Buffer.from(req.headers['x-pool-upload'], 'base64').toString());
    for await (const _ of req) { /* consume retained portrait */ }
    const id = entryId(identity); committed.add(id); calls++;
    res.end(JSON.stringify({ ok: true, publicationVersion: 2, entryId: id }));
  });
  try {
    const options = { directory, relayUrl: relay.base, boothId: 'local', boothKey: 'synthetic', bytesPerSecond: 1024 * 1024, now: () => clock };
    const queue = queueModule.createPoolQueue(options); queue.enqueue(payload('receipt'));
    const file = join(directory, (await readdir(directory))[0]);
    const rename = fs.renameSync; let failed = false;
    try {
      fs.renameSync = (from, to) => {
        if (to === file && JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'done' && !failed) { failed = true; throw new Error('Injected receipt disk failure'); }
        return rename(from, to);
      };
      await queue.tick();
    } finally { fs.renameSync = rename; }
    assert.equal(failed, true); assert.equal(committed.size, 1);
    const retained = JSON.parse(await readFile(file, 'utf8')); assert.equal(retained.phase, 'pending'); assert.ok(retained.photoBase64);
    queue.stop(); clock += 60001;
    const restarted = queueModule.createPoolQueue(options); await restarted.tick();
    assert.equal(calls, 2); assert.equal(committed.size, 1); assert.equal(restarted.status()[0].phase, 'done');
    const receipt = JSON.parse(await readFile(file, 'utf8')); assert.equal(receipt.photoBase64, undefined); assert.equal(receipt.code, undefined);
  } finally { await relay.close(); await rm(directory, { recursive: true, force: true }); }
});

test('actual relay HTTP router authenticates the v2 pool path before handler entry', async () => {
  const source = await readFile(new URL('../candidate/capturism-relay/server.js', import.meta.url), 'utf8');
  const routerStart = source.indexOf('const server = http.createServer(');
  const routerEnd = source.indexOf('/**\n * Verify the admin JWT.', routerStart);
  const authStart = source.indexOf('function authenticateBooth(');
  const authEnd = source.indexOf('/**\n * POST /api/booth/sign-upload', authStart);
  assert.ok(routerStart > 0 && routerEnd > routerStart && authEnd > authStart);
  let entries = 0;
  const context = { http, url, setTimeout, clearTimeout, Date, BOOTH_API_KEYS: new Map([['local','synthetic']]),
    jsonResponse: (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); },
    pool: { handlePoolUpload(req, res, boothId) { entries++; req.resume(); assert.equal(boothId, 'local'); res.end('{}'); } },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(authStart, authEnd) + source.slice(routerStart, routerEnd) + '\nglobalThis.reviewServer = server;', context);
  const server = context.reviewServer; await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const path = `http://127.0.0.1:${server.address().port}/api/booth/pool/upload`;
    for (const headers of [{}, { 'X-Booth-Auth': 'local:wrong' }, { 'X-Booth-Auth': 'unknown:synthetic' }]) {
      const res = await fetch(path, { method: 'POST', headers, body: 'synthetic' }); assert.equal(res.status, 401); await res.text();
    }
    assert.equal(entries, 0);
    const response = await fetch(path, { method: 'POST', headers: { 'X-Booth-Auth': 'local:synthetic' }, body: 'synthetic' });
    assert.equal(response.status, 200); await response.text(); assert.equal(entries, 1);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
