import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import diagnostics from '../candidate/diagnostics.cjs';

test('actual candidate bridge HTTP proxy persists correlated status without request data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capturism-proxy-'));
  const logger = diagnostics.createDiagnostics({ directory: dir });
  const relay = http.createServer((req, res) => { req.resume(); res.writeHead(503); res.end('PRIVATE response body'); });
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  const source = await readFile(new URL('../candidate/payment-bridge.js', import.meta.url), 'utf8');
  const start = source.indexOf('function forwardToRelay('), end = source.indexOf('// ─── Shelly proxy watchdog', start);
  const context = { http, https: http, URL, Date, RELAY_CONFIGURED: true, RELAY_URL: `http://127.0.0.1:${relay.address().port}`, BOOTH_ID: 'local', BOOTH_KEY: 'PRIVATE', diagnostics: logger, console, sendJSON: (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const bridge = http.createServer((req, res) => context.forwardToRelay(req, res, '/api/pool/join'));
  await new Promise(r => bridge.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${bridge.address().port}/`, { method: 'POST', body: 'PRIVATE request body', headers: { 'X-Capturism-Trace': '12345678-abcd' } });
    assert.equal(res.status, 503); await res.text();
    const text = await readFile(logger.file, 'utf8'), event = JSON.parse(text.trim());
    assert.equal(event.trace, '12345678-abcd'); assert.equal(event.stage, 'pool.join'); assert.equal(event.status, 503); assert.equal(event.outcome, 'error');
    assert.ok(event.durationMs >= 0); assert.ok(!text.includes('PRIVATE'));
  } finally {
    bridge.closeAllConnections(); relay.closeAllConnections();
    await Promise.all([new Promise(r => bridge.close(r)), new Promise(r => relay.close(r))]);
    await rm(dir, { recursive: true, force: true });
  }
});
