import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRelay, storage, call } from './helpers/relay-fixture.mjs';
import queueModule from '../candidate/pool-queue.cjs';

test('protocol 2 rollout rejects the unsafe legacy browser protocol', async () => {
  const relay = makeRelay(storage());
  const signed = await call(relay, 'handleSignUpload', { contentType: 'image/jpeg' });
  assert.equal(signed.status, 426);
  assert.equal(signed.body.uploadUrl, undefined);
});

test('legacy relay rollback blocks v2 delivery but preserves every acknowledged byte', async () => {
  const source = await readFile(new URL('../../diagnosis-2026-10-30/capturism-main/capturism-relay/pool.js', import.meta.url), 'utf8');
  const legacy = makeRelay(storage(), source);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/booth/pool/upload') { req.resume(); res.writeHead(404); res.end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const result = await call(legacy, 'handleSignUpload', JSON.parse(body), 'local-twin');
    res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body));
  });
  const directory = await mkdtemp(join(tmpdir(), 'capturism-rollback-'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const photoBase64 = Buffer.alloc(16000, 7).toString('base64');
    const queue = queueModule.createPoolQueue({ directory, relayUrl: `http://127.0.0.1:${server.address().port}`, boothId: 'local-twin', boothKey: 'local-only' });
    assert.equal(queue.enqueue({ sessionId: 'rollback-session', code: '000000', seed: true, photoBase64 }).queued, true);
    await queue.tick();
    assert.equal(queue.status()[0].phase, 'blocked');
    const record = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), 'utf8'));
    assert.equal(record.photoBase64, photoBase64); assert.equal(record.phase, 'blocked');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }); }
});
