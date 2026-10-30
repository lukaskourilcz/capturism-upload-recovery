import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import queueModule from '../candidate/pool-queue.cjs';
import diagnostics from '../candidate/diagnostics.cjs';

test('new local endpoints reject cross-origin and forwarded/tunnel requests before mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-ingress-'));
  const queue = queueModule.createPoolQueue({ directory: join(dir, 'queue'), boothId: 'local' });
  const logger = diagnostics.createDiagnostics({ directory: join(dir, 'logs') });
  const server = http.createServer((req, res) => { void (req.url === '/queue' ? queue.handle(req, res) : diagnostics.receiveDiagnostics(req, res, logger)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = { sessionId: 'local-only', code: '000000', seed: true, photoBase64: Buffer.alloc(16).toString('base64') };
    for (const headers of [ { Origin: 'https://public.example' }, { Origin: 'http://localhost:5173', 'X-Forwarded-For': '203.0.113.5' }, { 'CF-Connecting-IP': '203.0.113.5' }, { Forwarded: 'for=203.0.113.5' }, { Host: 'attacker.example' } ]) {
      for (const path of ['/queue','/diagnostics']) {
        const status = await new Promise((resolve, reject) => {
          const request = http.request(base + path, { method: 'POST', headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
          request.on('error', reject); request.end(JSON.stringify(path === '/queue' ? body : [{ stage: 'page.boot' }]));
        });
        assert.equal(status, 403, JSON.stringify({ headers, path }));
      }
    }
    assert.equal((await fetch(base + '/queue', { method: 'POST', headers: { Origin: 'https://localhost:5173' }, body: JSON.stringify(body) })).status, 200);
    assert.equal(queue.status().length, 1);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); }
});

test('recovery metadata corruption cannot redirect an uploaded checkpoint or disable expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-checkpoint-'));
  try {
    const queue = queueModule.createPoolQueue({ directory: dir, boothId: 'local' });
    queue.enqueue({ sessionId: 'checkpoint', code: '000000', seed: true, photoBase64: Buffer.alloc(16).toString('base64') });
    const file = join(dir, (await readdir(dir))[0]), original = JSON.parse(await readFile(file, 'utf8'));
    for (const changes of [ { phase: 'uploaded', entryId: '0'.repeat(16), key: 'pool-portraits/wrong.jpg' }, { attempts: -1 }, { queuedAt: null }, { nextAttemptAt: 'never' }, { seed: 'true' } ]) {
      await writeFile(file, JSON.stringify({ ...original, ...changes }));
      assert.equal(queue.status()[0].phase, 'corrupt');
      await queue.tick();
      assert.equal(queue.status()[0].phase, 'corrupt');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
