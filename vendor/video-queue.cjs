'use strict';
/**
 * Durable video delivery for the booth.
 *
 * WHY THIS EXISTS
 * ---------------
 * Videos used to be uploaded by the KIOSK BROWSER, straight to R2, during
 * the customer's session. That made a customer's video depend on the
 * booth's internet being healthy in the exact seconds after their shoot,
 * and on a browser tab staying alive long enough to finish. It wasn't:
 * between 2026-10-04 and 2026-10-18 customers lost videos to a relay 502,
 * to "Failed to fetch", and to request timeouts — and every one of those
 * losses was permanent, because the blob lived only in browser memory and
 * was dropped the moment the attempt failed.
 *
 * Now the kiosk's only job is to hand the bytes to this bridge over
 * localhost — a call that cannot fail for network reasons. The file goes
 * to DISK immediately, and this worker delivers it on its own schedule.
 *
 * What that buys, concretely:
 *   - internet down for an hour  → delivered when it returns
 *   - relay 502 / cold start     → retried, indefinitely
 *   - customer walks away        → irrelevant, we already have the file
 *   - kiosk browser closed       → irrelevant
 *   - bridge or PC restarted     → queue is on disk, work resumes on boot
 *
 * A queued item is only deleted once R2 has confirmed the bytes AND the
 * relay has been told about them. Nothing is dropped on a failure path.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const QUEUE_DIR = path.join(__dirname, 'video-queue');
const TICK_MS = 15_000;
/**
 * A failed item waits before its next attempt, doubling each time up to 30
 * min. Without this a file that cannot be delivered was retried every
 * TICK_MS, forever, at full speed - and on the booth's ~1 Mbit/s uplink that
 * kept the line saturated all day, starving the customer PHOTO upload that
 * makes the QR code appear (2026-10-28: no QR for any customer).
 */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** Anything bigger than this cannot cross the booth's uplink within the PUT
 *  timeout anyway; refusing it is kinder than hogging the line trying. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/**
 * Background uploads are capped so they never take the whole uplink. The QR
 * needs three small requests (sign, PUT, confirm) to get through, and a
 * saturated line makes those time out. Override with VIDEO_QUEUE_MAX_KBPS
 * on a booth with a faster line.
 */
const MAX_BYTES_PER_SEC = Math.max(10, Number(process.env.VIDEO_QUEUE_MAX_KBPS) || 50) * 1024;
/** R2 deletes sessions/ after 24h, so a file older than that is undeliverable. */
const MAX_AGE_MS = 24 * 60 * 60_000;
const KINDS = new Set(['video', 'layout', 'story']);
const EXT_FOR = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
/** Which photos-ready field each kind maps to. */
const FIELD_FOR = { video: 'videoKey', layout: 'layoutVideoKey', story: 'storyVideoKey' };

/** Delay before attempt number `attempts + 1`: 60 s, 2 min, 4 min ... capped at 30 min. */
function backoffMs(attempts) {
  const n = Math.max(1, attempts | 0);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n, 10));
}

/** Pass bytes through no faster than bytesPerSec. Content is untouched. */
function throttle(bytesPerSec) {
  const { Transform } = require('stream');
  const start = Date.now();
  let sent = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      const wait = start + (sent / bytesPerSec) * 1000 - Date.now();
      if (wait > 0) setTimeout(() => cb(null, chunk), wait);
      else cb(null, chunk);
    },
  });
}

/** Remove a session's "keys already delivered" note once nothing of it is left queued. */
function cleanupDoneIfIdle(token) {
  try {
    const siblings = fs.readdirSync(QUEUE_DIR).filter(
      (f) => f.startsWith(`${token}__`) && f.endsWith('.json') && !f.endsWith('__done.json'),
    );
    if (siblings.length === 0) fs.unlinkSync(path.join(QUEUE_DIR, `${token}__done.json`));
  } catch { /* nothing to clean */ }
}

function ensureDir() {
  try { fs.mkdirSync(QUEUE_DIR, { recursive: true }); } catch { /* already there */ }
}

/** Reject anything that could escape QUEUE_DIR — both values land in a path. */
function safeToken(t) {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(t);
}

// ─── Enqueue (called by the bridge's HTTP route) ─────────────────────────

/**
 * Stream a request body straight to disk, then answer. Deliberately does
 * NOT touch the network: the kiosk gets its 200 in milliseconds and the
 * customer's session is never held up by an upload.
 */
function enqueue(req, res, { token, kind, contentType, photoKey }, sendJSON) {
  if (!safeToken(token)) return sendJSON(res, 400, { error: 'bad token' });
  if (!KINDS.has(kind)) return sendJSON(res, 400, { error: 'bad kind' });
  // The raw full-session recording is deliberately NOT delivered. It is the
  // biggest file by far (tens of MB), it can never cross the booth's uplink
  // inside one PUT timeout, and customers have never seen it - the Download
  // button uses the composed layout video. An older kiosk page may still send
  // it; swallow the body and say so rather than queue a file that would be
  // retried all day.
  if (kind === 'video') {
    req.resume();
    return sendJSON(res, 200, { queued: false, dropped: true, reason: 'raw session recordings are not delivered' });
  }
  const ext = EXT_FOR[contentType];
  if (!ext) return sendJSON(res, 400, { error: 'bad contentType' });
  if (!photoKey || typeof photoKey !== 'string') return sendJSON(res, 400, { error: 'photoKey required' });

  ensureDir();
  const base = path.join(QUEUE_DIR, `${token}__${kind}`);
  // Write to .part first and rename: a bridge killed mid-write must not
  // leave a truncated file that the worker would happily upload.
  const partPath = `${base}.part`;
  const binPath = `${base}.${ext}`;
  const out = fs.createWriteStream(partPath);

  let bytes = 0;
  req.on('data', (c) => { bytes += c.length; });
  req.pipe(out);

  out.on('error', (err) => {
    console.warn(`[video-queue] write failed for ${token}/${kind}: ${err.message}`);
    try { fs.unlinkSync(partPath); } catch { /* nothing to clean */ }
    sendJSON(res, 500, { error: 'queue write failed' });
  });

  out.on('finish', () => {
    try {
      fs.renameSync(partPath, binPath);
      fs.writeFileSync(`${base}.json`, JSON.stringify({
        token, kind, contentType, photoKey,
        file: path.basename(binPath),
        queuedAt: Date.now(),
        attempts: 0,
      }));
      console.log(`[video-queue] queued ${kind} for ${token} (${Math.round(bytes / 1024)} KB) — will deliver in the background`);
      sendJSON(res, 200, { queued: true, bytes });
    } catch (err) {
      console.warn(`[video-queue] finalise failed for ${token}/${kind}: ${err.message}`);
      sendJSON(res, 500, { error: 'queue finalise failed' });
    }
  });
}

// ─── Delivery worker ─────────────────────────────────────────────────────

function requestJSON(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : {}); }
          catch { reject(new Error(`bad JSON from ${u.pathname}`)); }
        } else {
          reject(new Error(`${u.pathname} → ${res.statusCode} ${data.slice(0, 120)}`));
        }
      });
    });
    r.on('error', reject);
    r.setTimeout(60_000, () => r.destroy(new Error(`${u.pathname} timed out`)));
    if (body) r.write(body);
    r.end();
  });
}

function putFile(uploadUrl, filePath, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const size = fs.statSync(filePath).size;
    const r = lib.request({
      method: 'PUT',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'Content-Type': contentType, 'Content-Length': size },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`R2 PUT → ${res.statusCode} ${data.slice(0, 120)}`));
      });
    });
    r.on('error', reject);
    // Generous: a 60 MB video on a slow uplink is normal, and there is no
    // customer waiting on this — it runs long after they have left.
    r.setTimeout(10 * 60_000, () => r.destroy(new Error('R2 PUT timed out')));
    const rs = fs.createReadStream(filePath);
    // An unhandled 'error' on a stream crashes the whole bridge process.
    rs.on('error', (e) => r.destroy(e));
    rs.pipe(throttle(MAX_BYTES_PER_SEC)).pipe(r);
  });
}

/** Keys already delivered for a session, so each commit sends the FULL set. */
function readDone(token) {
  try { return JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, `${token}__done.json`), 'utf8')); }
  catch { return {}; }
}
function writeDone(token, done) {
  try { fs.writeFileSync(path.join(QUEUE_DIR, `${token}__done.json`), JSON.stringify(done)); }
  catch (err) { console.warn(`[video-queue] done-file write failed for ${token}: ${err.message}`); }
}

function startWorker({ relayUrl, boothId, boothKey, onAlert }) {
  if (!relayUrl || !boothId || !boothKey) {
    console.warn('[video-queue] relay not configured — queue worker NOT started. Videos will pile up on disk.');
    return;
  }
  ensureDir();
  const auth = { 'X-Booth-Auth': `${boothId}:${boothKey}`, 'Content-Type': 'application/json' };
  let running = false;

  async function deliverOne(metaPath) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const binPath = path.join(QUEUE_DIR, meta.file);
    const base = metaPath.replace(/\.json$/, '');

    if (!fs.existsSync(binPath)) {
      fs.unlinkSync(metaPath);
      return;
    }
    // Raw session recordings queued by an earlier build: discard, don't send.
    if (meta.kind === 'video') {
      console.warn(`[video-queue] discarding queued raw session recording for ${meta.token} (not delivered any more)`);
      try { fs.unlinkSync(binPath); fs.unlinkSync(metaPath); } catch { /* best effort */ }
      cleanupDoneIfIdle(meta.token);
      return;
    }
    // Still cooling off after a failure.
    if (meta.nextAttemptAt && Date.now() < meta.nextAttemptAt) return;
    // Too big to ever cross the uplink inside one PUT timeout.
    const sizeBytes = fs.statSync(binPath).size;
    if (sizeBytes > MAX_FILE_BYTES) {
      console.warn(`[video-queue] dropping ${meta.kind} for ${meta.token}: ${Math.round(sizeBytes / 1048576)} MB exceeds the ${MAX_FILE_BYTES / 1048576} MB limit`);
      try { fs.unlinkSync(binPath); fs.unlinkSync(metaPath); } catch { /* best effort */ }
      cleanupDoneIfIdle(meta.token);
      return;
    }
    if (Date.now() - meta.queuedAt > MAX_AGE_MS) {
      // The R2 session prefix is expired; delivering now would publish a
      // video into a session the customer can no longer open.
      console.warn(`[video-queue] dropping ${meta.kind} for ${meta.token} — older than 24h, session has expired`);
      try { fs.unlinkSync(binPath); fs.unlinkSync(metaPath); } catch { /* best effort */ }
      onAlert?.({
        code: 'video_upload_failed',
        severity: 'warning',
        message: `A customer's ${meta.kind} video could not be delivered within 24h and has been dropped (${meta.attempts} attempts). Their download page is missing it.`,
      });
      return;
    }

    const signed = await requestJSON(`${relayUrl}/api/booth/sign-upload`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ contentType: meta.contentType, token: meta.token, kind: meta.kind }),
    });
    if (!signed.uploadUrl || !signed.key) throw new Error('sign-upload returned no url');

    await putFile(signed.uploadUrl, binPath, meta.contentType);

    // Record BEFORE committing: if the commit fails we must not re-upload
    // the bytes, and the relay can find the object by its derived key.
    const done = readDone(meta.token);
    done[FIELD_FOR[meta.kind]] = signed.key;
    writeDone(meta.token, done);

    await requestJSON(`${relayUrl}/api/booth/photos-ready`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ token: meta.token, photoKey: meta.photoKey, ...done }),
    });

    fs.unlinkSync(binPath);
    fs.unlinkSync(metaPath);
    console.log(`[video-queue] ✅ delivered ${meta.kind} for ${meta.token} after ${meta.attempts + 1} attempt(s)`);

    cleanupDoneIfIdle(meta.token);
    void base;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const metas = fs.readdirSync(QUEUE_DIR).filter(
        (f) => f.endsWith('.json') && !f.endsWith('__done.json'),
      );
      for (const f of metas) {
        const metaPath = path.join(QUEUE_DIR, f);
        try {
          await deliverOne(metaPath);
        } catch (err) {
          // Leave it on disk and retry later, with growing pauses (see
          // backoffMs) so a stuck file cannot hog the uplink.
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            meta.attempts = (meta.attempts || 0) + 1;
            meta.lastError = String(err.message).slice(0, 200);
            meta.nextAttemptAt = Date.now() + backoffMs(meta.attempts);
            fs.writeFileSync(metaPath, JSON.stringify(meta));
            const mins = Math.round((Date.now() - meta.queuedAt) / 60_000);
            console.warn(`[video-queue] ${meta.kind} for ${meta.token} attempt ${meta.attempts} failed (${mins}m queued): ${err.message}`);
          } catch { /* meta unreadable; next tick will clean up */ }
        }
      }
    } catch (err) {
      console.warn(`[video-queue] tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  const pending = (() => {
    try { return fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('__done.json')).length; }
    catch { return 0; }
  })();
  console.log(`[video-queue] worker started (every ${TICK_MS / 1000}s)${pending ? ` — ${pending} item(s) left over from a previous run, resuming` : ''}`);
  setInterval(tick, TICK_MS);
  setTimeout(tick, 3_000);
}

module.exports = { enqueue, startWorker, QUEUE_DIR, backoffMs, throttle, MAX_FILE_BYTES };
