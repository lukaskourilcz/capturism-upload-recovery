'use strict';
// Run with:  node --test video-queue.test.js
//
// 2026-10-28: the queue retried one ~40 MB raw recording every few minutes,
// forever, at full speed on a ~1 Mbit/s uplink, so no customer photo could
// finish uploading and no QR appeared. These pin the three guards down.
const { test } = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('stream');
const fs = require('fs');
const { enqueue, backoffMs, throttle, QUEUE_DIR, MAX_FILE_BYTES } = require('./video-queue');

test('backoff grows and is capped, so a stuck file cannot retry every 15 s', () => {
  const waits = [1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs);
  for (let i = 1; i < waits.length; i++) assert.ok(waits[i] >= waits[i - 1], 'never shrinks');
  assert.ok(waits[0] >= 60_000, 'first retry waits at least a minute');
  assert.ok(waits[waits.length - 1] <= 30 * 60_000, 'capped at 30 minutes');
});

test('the throttle keeps every byte, unchanged', async () => {
  const src = Buffer.alloc(300_000, 7);
  const out = [];
  await new Promise((resolve, reject) => {
    Readable.from([src.subarray(0, 100_000), src.subarray(100_000, 200_000), src.subarray(200_000)])
      .pipe(throttle(10 * 1024 * 1024))
      .pipe(new Writable({ write(c, _e, cb) { out.push(c); cb(); } }))
      .on('finish', resolve).on('error', reject);
  });
  assert.ok(Buffer.concat(out).equals(src));
});

test('the throttle really slows the upload down to the cap', async () => {
  const rate = 200 * 1024;                    // 200 KB/s
  const chunk = Buffer.alloc(100 * 1024, 1);  // 5 x 100 KB = 500 KB -> ~2.5 s at 200 KB/s
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    Readable.from([chunk, chunk, chunk, chunk, chunk])
      .pipe(throttle(rate))
      .pipe(new Writable({ write(_c, _e, cb) { cb(); } }))
      .on('finish', resolve).on('error', reject);
  });
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs >= 2.0, `took ${secs.toFixed(2)}s - should be held to ~2.5s, not run at full speed`);
  assert.ok(secs < 4.5, `took ${secs.toFixed(2)}s - should not be wildly slower than the cap`);
});

test('a raw session recording is swallowed, not queued', async () => {
  const before = fs.existsSync(QUEUE_DIR) ? fs.readdirSync(QUEUE_DIR).length : 0;
  let status = null, body = null, drained = false;
  const req = Readable.from([Buffer.alloc(50_000, 9)]);
  req.on('end', () => { drained = true; });
  const sendJSON = (_res, code, data) => { status = code; body = data; };

  enqueue(req, {}, { token: 'AbCdEfGh12345678', kind: 'video', contentType: 'video/webm', photoKey: 'sessions/x/photo.jpg' }, sendJSON);
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(status, 200);
  assert.strictEqual(body.queued, false);
  assert.strictEqual(body.dropped, true);
  assert.ok(drained, 'the request body must be consumed or the kiosk hangs');
  const after = fs.existsSync(QUEUE_DIR) ? fs.readdirSync(QUEUE_DIR).length : 0;
  assert.strictEqual(after, before, 'nothing may be written to the queue folder');
});

test('size limit is below what one PUT can carry at the capped speed', () => {
  // 10 min PUT timeout at the default 50 KB/s cap carries ~29 MB.
  assert.ok(MAX_FILE_BYTES <= 25 * 1024 * 1024);
});
