'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Readable, Transform } = require('stream');
const { isLocalRequest } = require('./local-request.cjs');
const MAX_PHOTO = 20 * 1024 * 1024;
const MAX_DISK = 1024 * 1024 * 1024;
const MAX_AGE = 24 * 3600_000;
const delayFor = attempts => Math.min(30 * 60_000, 60_000 * 2 ** Math.min(10, Math.max(0, attempts - 1)));

function atomicJSON(file, value) {
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.part`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    // Directory fsync is supported on Unix, but not all Windows filesystems.
    try { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* file has been synced */ }
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch { /* already renamed */ } }
}
function createPoolQueue({ directory = path.join(__dirname, 'pool-queue'), relayUrl, boothId, boothKey, onEvent = () => {}, now = Date.now, tickMs = 15000, bytesPerSecond = 25 * 1024 }) {
  let running = false, timer, stopped = false;
  const active = new Set();
  const event = detail => { try { onEvent(detail); } catch { /* logging cannot break delivery */ } };
  const files = () => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); for (const f of fs.readdirSync(directory)) if (/^[a-f0-9]{64}\.json\.[a-f0-9]{12}\.part$/.test(f)) fs.unlinkSync(path.join(directory, f)); return fs.readdirSync(directory).filter(f => /^[a-f0-9]{64}\.json$/.test(f)); };
  const read = file => {
    const job = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (job.id !== file.slice(0, -5) || !/^[a-f0-9]{64}$/.test(job.digest || '') || !['pending','uploaded','done','blocked'].includes(job.phase)) throw new Error('Invalid queue record');
    if (typeof job.seed !== 'boolean') throw new Error('Invalid queue seed flag');
    if (job.phase === 'done' && (!Number.isFinite(job.deliveredAt) || job.deliveredAt < 0)) throw new Error('Invalid queue receipt');
    if (job.phase !== 'done') {
      if (!Number.isInteger(job.attempts) || job.attempts < 0 || !Number.isFinite(job.queuedAt) || job.queuedAt < 0 || !Number.isFinite(job.nextAttemptAt) || job.nextAttemptAt < 0) throw new Error('Invalid queue recovery metadata');
      if (job.entryId !== undefined || job.phase === 'uploaded') {
        if (job.entryId !== job.id.slice(0, 16) || job.key !== `pool-portraits/${job.entryId}.jpg`) throw new Error('Invalid uploaded checkpoint');
      }
      const identity = crypto.createHash('sha256').update(JSON.stringify([boothId, job.sessionId, job.code])).digest('hex');
      if (identity !== job.id || typeof job.photoBase64 !== 'string' || crypto.createHash('sha256').update(Buffer.from(job.photoBase64, 'base64')).digest('hex') !== job.digest) throw new Error('Pool queue checksum mismatch');
    }
    return job;
  };
  const save = job => atomicJSON(path.join(directory, `${job.id}.json`), job);
  function enqueue(body) {
    if (!body || !/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId || '') || !/^\d{6}$/.test(body.code || '') || typeof body.seed !== 'boolean' || typeof body.photoBase64 !== 'string' || body.photoBase64.length > Math.ceil(MAX_PHOTO / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.photoBase64)) throw Object.assign(new Error('Invalid pool queue request'), { status: 400 });
    const photo = Buffer.from(body.photoBase64, 'base64');
    if (!photo.length || photo.length > MAX_PHOTO || photo.toString('base64') !== body.photoBase64) throw Object.assign(new Error('Invalid portrait bytes'), { status: 400 });
    const id = crypto.createHash('sha256').update(JSON.stringify([boothId, body.sessionId, body.code])).digest('hex');
    const digest = crypto.createHash('sha256').update(photo).digest('hex');
    const names = files(), file = `${id}.json`;
    if (names.includes(file)) {
      const old = read(file);
      if (old.digest !== digest || old.seed !== body.seed) throw Object.assign(new Error('Pool queue identity conflict'), { status: 409 });
      return { queued: true, delivered: old.phase === 'done', needsAttention: old.phase === 'blocked' };
    }
    const used = fs.readdirSync(directory).reduce((total, f) => total + fs.statSync(path.join(directory, f)).size, 0);
    if (used + body.photoBase64.length + 4096 > MAX_DISK) throw Object.assign(new Error('Pool queue is full'), { status: 507 });
    // One atomic file contains both bytes and identity. A partial request or
    // crash before rename can never become an acknowledged queue entry.
    save({ id, digest, sessionId: body.sessionId, code: body.code, seed: body.seed, photoBase64: body.photoBase64, queuedAt: now(), attempts: 0, nextAttemptAt: 0, phase: 'pending' });
    event('Pool portrait saved to local queue');
    return { queued: true, delivered: false };
  }
  function request(url, { method = 'POST', body, contentType = 'application/json', auth = false, timeout = 60000, throttle = false } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Invalid upstream protocol'));
      if (!auth && u.protocol !== 'https:' && !['127.0.0.1','localhost','[::1]'].includes(u.hostname)) return reject(new Error('Insecure portrait destination'));
      const headers = { 'Content-Type': contentType, 'Content-Length': body?.length || 0 };
      if (auth) headers['X-Booth-Auth'] = `${boothId}:${boothKey}`;
      const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers }, res => {
        let output = ''; res.setEncoding('utf8');
        res.on('data', chunk => { output += chunk; if (output.length > 65536) req.destroy(new Error('Upstream response too large')); });
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode;
          if (status < 200 || status >= 300) return reject(Object.assign(new Error('Pool upstream request failed'), { status, permanent: auth && status >= 400 && status < 500 && ![408,429].includes(status) }));
          if (method === 'PUT') return resolve({});
          try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid pool response')); }
        });
      });
      active.add(req);
      req.on('close', () => active.delete(req)); req.on('error', reject);
      req.setTimeout(timeout, () => req.destroy(new Error('Pool request timed out')));
      // Socket timeout measures inactivity; absolute deadline also bounds
      // a server that keeps sending tiny chunks forever.
      const deadline = setTimeout(() => req.destroy(new Error('Pool request deadline')), timeout);
      req.on('close', () => clearTimeout(deadline));
      if (!throttle) { req.end(body); return; }
      let sent = 0, scheduled; const start = Date.now();
      const paced = new Transform({ transform(chunk, _encoding, cb) {
        sent += chunk.length; const wait = start + sent / bytesPerSecond * 1000 - Date.now();
        scheduled = setTimeout(() => cb(null, chunk), Math.max(0, wait));
      } });
      paced.once('close', () => clearTimeout(scheduled));
      const chunks = function* () { for (let i = 0; i < body.length; i += 16384) yield body.subarray(i, i + 16384); };
      const source = Readable.from(chunks());
      req.on('close', () => { source.destroy(); paced.destroy(); });
      source.on('error', err => req.destroy(err)); paced.on('error', err => req.destroy(err));
      source.pipe(paced).pipe(req);
    });
  }
  const call = (endpoint, payload) => request(`${relayUrl}${endpoint}`, { auth: true, body: Buffer.from(JSON.stringify(payload)) });
  async function deliver(job) {
    const identity = { retryVersion: 1, code: job.code, sessionId: job.sessionId };
    if (job.phase === 'pending') {
      const signed = await call('/api/booth/pool/sign-upload', { ...identity, contentType: 'image/jpeg' });
      if (signed.retryVersion !== 1 || !/^[a-f0-9]{16}$/.test(signed.entryId || '') || signed.key !== `pool-portraits/${signed.entryId}.jpg` || !signed.uploadUrl) throw Object.assign(new Error('Pool retry protocol unavailable'), { permanent: true });
      if (job.entryId && (job.entryId !== signed.entryId || job.key !== signed.key)) throw Object.assign(new Error('Pool identity changed'), { permanent: true });
      job.entryId = signed.entryId; job.key = signed.key; save(job);
      await request(signed.uploadUrl, { method: 'PUT', body: Buffer.from(job.photoBase64, 'base64'), contentType: 'image/jpeg', timeout: 20 * 60_000, throttle: true });
      job.phase = 'uploaded'; save(job);
    }
    const result = await call('/api/booth/pool/join', { ...identity, entryId: job.entryId, portraitKey: job.key, seed: job.seed });
    if (result.ok !== true || result.entryId !== job.entryId) throw Object.assign(new Error('Pool identity mismatch'), { permanent: true });
    // Receipt replaces sensitive payload before success is considered final.
    save({ id: job.id, digest: job.digest, seed: job.seed, phase: 'done', deliveredAt: now() });
    event('Pool portrait delivered; local bytes removed');
  }
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      for (const file of files()) {
        if (stopped) break;
        let job;
        try { job = read(file); } catch { event('Unreadable pool queue item; operator attention required'); continue; }
        if (!['pending','uploaded'].includes(job.phase) || job.nextAttemptAt > now()) continue;
        if (now() - job.queuedAt > MAX_AGE) { job.phase = 'blocked'; job.reason = 'expired'; save(job); event('Pool queue item expired; portrait retained for operator review'); continue; }
        try { await deliver(job); }
        catch (err) {
          if (stopped) break;
          job.attempts++; job.nextAttemptAt = now() + delayFor(job.attempts);
          if (err.permanent || (err.status >= 400 && err.status < 500 && ![403,408,429].includes(err.status))) { job.phase = 'blocked'; job.reason = 'permanent'; }
          try { save(job); } catch { /* previous checkpoint remains recoverable */ }
          event(job.phase === 'blocked' ? 'Pool delivery blocked; operator attention required' : 'Pool delivery deferred; will retry');
        }
      }
    } finally { running = false; }
  }
  function start() { if (timer) return; stopped = false; timer = setInterval(() => { void tick().catch(() => event('Pool queue worker error')); }, tickMs); void tick().catch(() => event('Pool queue worker error')); }
  function stop() { stopped = true; clearInterval(timer); timer = undefined; for (const req of active) req.destroy(new Error('Pool worker stopped')); }
  const status = () => files().map(file => { try { const j = read(file); return { phase: j.phase, attempts: j.attempts || 0, nextAttemptAt: j.nextAttemptAt || 0 }; } catch { return { phase: 'corrupt' }; } });
  async function handle(req, res) {
    const reply = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } };
    if (!isLocalRequest(req)) return reply(403, {});
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > Math.ceil(MAX_PHOTO / 3) * 4 + 4096) return reply(413, {}); chunks.push(chunk); }
      const result = enqueue(JSON.parse(Buffer.concat(chunks).toString('utf8'))); reply(200, result);
    } catch (err) { reply(err.status || 500, { error: err.status ? err.message : 'Pool queue could not save portrait' }); }
  }
  return { enqueue, tick, start, stop, status, handle };
}
module.exports = { createPoolQueue, atomicJSON, delayFor };
