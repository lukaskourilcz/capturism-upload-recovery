import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import diagnosticsModule from './candidate/diagnostics.cjs';
import poolRetry from './candidate/capturism-relay/pool-retry.cjs';
import publicationModule from './candidate/capturism-relay/pool-publication.cjs';
import { localPoolStorage, poolCommands } from './local-pool-store.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const presets = {
  normal: { label: 'Healthy connection', kbps: 1024, latency: 40, offline: 0, cold: 0, commitFailures: 0, contention: 0 },
  studio: { label: 'Slow studio connection · about 1 Mbps', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 0, contention: 0 },
  congested: { label: 'Slow connection + competing traffic', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 0, contention: 90 },
  cold: { label: 'Relay waking up · 55 seconds', kbps: 125, latency: 150, offline: 0, cold: 55, commitFailures: 0, contention: 0 },
  offline: { label: 'Connection lost for 20 seconds', kbps: 125, latency: 150, offline: 20, cold: 0, commitFailures: 0, contention: 0 },
  confirm: { label: 'Photo lands, confirmation fails five times', kbps: 1024, latency: 40, offline: 0, cold: 0, commitFailures: 5, contention: 0 },
  idle_sign: { label: 'After idle: first signing requests fail', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 0, contention: 0 },
  idle_put: { label: 'After idle: first direct PUTs fail', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 0, contention: 0 },
  idle_join: { label: 'After idle: first pool confirmation fails', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 0, contention: 0 },
  idle_ack: { label: 'After idle: pool saved but response lost', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 0, contention: 0 },
  idle_persist: { label: 'After idle: first pool record save fails', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 0, contention: 0 },
  qr_idle_confirm: { label: 'After idle: first QR confirmation fails', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 1, contention: 0 },
  qr_idle_ack: { label: 'After idle: QR saved, response lost', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 0, contention: 0 },
  qr_idle_save: { label: 'After idle: first QR record save fails', kbps: 125, latency: 150, offline: 0, cold: 0, commitFailures: 1, contention: 0 },
};

export async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request exceeds local test limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export const json = (res, code, body) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

// Shared throughput budget across every local R2 PUT, not a per-request delay.
// Competing traffic reserves bandwidth; it models congestion, not TCP packet loss.
export class Uplink {
  constructor(bytesPerSecond) {
    this.rate = bytesPerSecond; this.jobs = new Set(); this.credit = 0;
    this.timer = setInterval(() => {
      let budget = this.rate / 20 + this.credit;
      while (this.jobs.size && budget > 0) {
        const share = budget / this.jobs.size;
        for (const j of this.jobs) {
          const spent = Math.min(j.left, share); j.left -= spent; budget -= spent;
          if (j.left <= 0) { this.jobs.delete(j); j.cleanup(); j.resolve(); }
        }
        if (budget < .001) break;
      }
      this.credit = Math.min(this.rate / 20, budget);
    }, 50);
  }
  transfer(size, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { this.jobs.delete(job); job.cleanup(); reject(new Error('Upload aborted')); };
      const job = { left: size, resolve, cleanup: () => signal?.removeEventListener('abort', abort) };
      if (signal?.aborted) return reject(new Error('Upload aborted'));
      signal?.addEventListener('abort', abort, { once: true }); this.jobs.add(job);
    });
  }
  close() {
    clearInterval(this.timer);
    for (const j of this.jobs) { j.cleanup(); j.resolve(); }
    this.jobs.clear();
  }
}

export class Simulator {
  constructor({ root, baseUrl, worker = true }) {
    this.root = root; this.baseUrl = baseUrl; this.workerEnabled = worker;
    this.run = null; this.worker = null; this.events = [];
    this.uplink = null; this.generation = 0;
    this.diagnostics = diagnosticsModule.createDiagnostics({ directory: join(root, 'diagnostic-logs') });
  }
  event(stage, detail, extra = {}) {
    const event = { at: new Date().toISOString(), elapsed: this.run ? Date.now() - this.run.started : 0, stage, detail, ...extra };
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
  }
  async start({ scenario = 'normal', kbps, contention } = {}) {
    if (!presets[scenario]) throw new Error('Unknown scenario');
    await this.stopWorker(); this.generation++;
    this.uplink?.close();
    const cfg = { ...presets[scenario] };
    if (kbps !== undefined) cfg.kbps = Math.min(10240, Math.max(10, Number(kbps) || cfg.kbps));
    if (contention !== undefined) cfg.contention = Math.min(cfg.kbps - 1, Math.max(0, Number(contention) || 0));
    this.events = [];
    const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
    const dir = join(this.root, id);
    await mkdir(join(dir, 'objects'), { recursive: true });
    await copyFile(new URL('./vendor/video-queue.cjs', import.meta.url), join(dir, 'video-queue.cjs'));
    this.run = { id, dir, scenario, cfg, started: Date.now(), coldUntil: Date.now() + cfg.cold * 1000, sessions: {}, pool: {}, faults: new Set(), objects: {}, signed: new Map(), commitFailures: cfg.commitFailures };
    const run = this.run;
    run.poolEntries = new Map();
    run.joinOnce = poolRetry.createJoinCoordinator({ entries: run.poolEntries, persist: async entry => {
      if (run.scenario === 'idle_persist' && !run.faults.has('pool.persist')) {
        run.faults.add('pool.persist'); this.event('idle-fault', 'pool.persist: injected disk/storage error'); throw new Error('Injected storage failure');
      }
      await writeFile(join(dir, `pool-${entry.id}.json`), JSON.stringify(entry));
      this.event('pool-persist', 'Synthetic pool record durably saved');
    } });
    run.protectedStorage = localPoolStorage(join(dir, 'protected-pool'), {
      beforePut: async input => {
        if (input.Key.startsWith('pool/') && JSON.parse(input.Body.toString()).status === 'active' && ['idle_join','idle_persist'].includes(run.scenario) && !run.faults.has('protected.commit')) {
          run.faults.add('protected.commit'); this.event('idle-fault', 'Injected protected pool publication failure'); throw new Error('Simulated pool persistence failure');
        }
      },
      onPut: (key, bytes) => {
        if (key.startsWith('pool-portraits/')) this.event('put-done', 'Protected pool portrait stored once', { key, bytes: bytes.length });
        if (key.startsWith('pool/') && JSON.parse(bytes.toString()).status === 'active') this.event('pool-persist', 'Protected pool record published');
      },
    });
    run.publication = publicationModule.createPublicationStore({ client: run.protectedStorage, bucket: 'local-only', commands: poolCommands,
      onPublished: entry => { run.pool[entry.id] = { portraitKey: entry.portraitKey }; },
      onWithdrawn: id => { delete run.pool[id]; },
    });
    this.uplink = new Uplink(Math.max(1, cfg.kbps - cfg.contention) * 1024);
    this.event('run', cfg.label);
    if (scenario.startsWith('idle_')) this.event('idle-model', 'Injected first-use fault after modeled 2-hour idle; no Windows/Chrome idle is emulated');
    await this.startWorker();
    return { id, cfg };
  }
  async startWorker() {
    if (!this.workerEnabled || !this.run) return;
    this.worker = fork(new URL('./worker.cjs', import.meta.url), [this.run.dir, this.baseUrl], {
      env: { PATH: process.env.PATH, VIDEO_QUEUE_MAX_KBPS: '50' }, silent: true,
    });
    this.worker.stdout.on('data', b => this.event('bridge', b.toString().trim()));
    this.worker.stderr.on('data', b => this.event('bridge', b.toString().trim()));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local bridge did not start')), 5000);
      this.worker.once('message', msg => { clearTimeout(timer); this.workerPort = msg.port; resolve(); });
      this.worker.once('error', err => { clearTimeout(timer); reject(err); });
    });
  }
  async stopWorker() {
    const child = this.worker; this.worker = null; this.workerPort = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
  }
  async close() { await this.stopWorker(); this.generation++; this.uplink?.close(); }
  async snapshot() {
    let queue = [];
    const poolQueue = this.workerPort ? await fetch(`http://127.0.0.1:${this.workerPort}/api/pool-queue/status`).then(r => r.json()).catch(() => []) : [];
    if (this.run) {
      const dir = join(this.run.dir, 'video-queue');
      const names = await readdir(dir).catch(() => []);
      queue = (await Promise.all(names.filter(n => n.endsWith('.json') && !n.endsWith('__done.json')).map(n => readFile(join(dir, n), 'utf8').then(JSON.parse).catch(() => null)))).filter(Boolean);
    }
    return { run: this.run && { id: this.run.id, scenario: this.run.scenario, cfg: this.run.cfg }, events: this.events, queue, poolQueue, sessions: this.run?.sessions || {}, pool: this.run?.pool || {}, activeUploads: this.uplink?.jobs.size || 0, workerRunning: !!this.worker };
  }
  fault(point, res) {
    const run = this.run;
    if (!run || run.faults.has(point)) return false;
    const active = (run.scenario === 'idle_sign' && point.endsWith('.sign')) ||
      (run.scenario === 'idle_put' && point.endsWith('.put')) ||
      (run.scenario === 'idle_join' && point === 'pool.join');
    if (!active) return false;
    run.faults.add(point); this.event('idle-fault', `${point}: injected first-use HTTP 503`);
    json(res, 503, { error: 'Injected first request failure after idle' }); return true;
  }
  async cloudReady(res) {
    const run = this.run;
    if (!run) { json(res, 503, { error: 'Start a local scenario first' }); return false; }
    await sleep(run.cfg.latency);
    if (Date.now() < run.started + run.cfg.offline * 1000) {
      this.event('network', 'Injected outage → HTTP 503'); json(res, 503, { error: 'Simulated network outage' }); return false;
    }
    return true;
  }
  async handle(req, res, url) {
    const p = url.pathname;
    if (p === '/api/diagnostics' && req.method === 'POST') return diagnosticsModule.receiveDiagnostics(req, res, this.diagnostics);
    if (p === '/api/relay/configured') return json(res, 200, { configured: true });
    if (p === '/lab/state') return json(res, 200, await this.snapshot());
    if (p === '/lab/start' && req.method === 'POST') return json(res, 200, await this.start(JSON.parse(await readBody(req, 4096))));
    if (p === '/lab/client-event' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 16384)); this.event('kiosk', String(body.message || body.code || '').slice(0, 2000)); return json(res, 200, { ok: true });
    }
    if (p === '/lab/restart-bridge' && req.method === 'POST') {
      await this.stopWorker(); await this.startWorker(); this.event('bridge', 'Bridge restarted; durable queue preserved'); return json(res, 200, { ok: true });
    }
    if (p === '/lab/report') return json(res, 200, await this.snapshot());
    if (!this.run) return json(res, 503, { error: 'Start a local scenario first' });
    const run = this.run, generation = this.generation;
    if (p === '/lab/pool-withdraw' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 4096));
      await run.publication.withdraw(body.entryId); this.event('pool-withdrawn', 'Synthetic pool entry withdrawn');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/booth/pool/upload' && req.method === 'POST') {
      let publicationIdentity;
      try {
        if (!(await this.cloudReady(res)) || this.fault('pool.sign', res)) { req.resume(); return; }
        const data = JSON.parse(Buffer.from(req.headers['x-pool-upload'] || '', 'base64').toString('utf8'));
        const identity = run.publication.identify('local-twin', data); publicationIdentity = identity;
        const state = await run.publication.reserve(identity, () => {});
        if (['active','retired'].includes(state.data.status)) { req.resume(); return json(res, 200, { ok: true, entryId: identity.id, publicationVersion: 2 }); }
        if (this.fault('pool.put', res)) { req.resume(); return; }
        this.event('put-start', `pool-portraits/${identity.id}.jpg`);
        const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length; if (bytes > publicationModule.MAX_PHOTO) throw Object.assign(new Error('Too large'), { status: 413 });
          await this.uplink.transfer(chunk.length, controller.signal); chunks.push(chunk);
        }
        const entry = await run.publication.publish(identity, Buffer.concat(chunks), () => ({ ...identity, portraitKey: `pool-portraits/${identity.id}.jpg`, status: 'active', distributions: [], distributionCount: 0 }));
        if (run.scenario === 'idle_ack' && !run.faults.has('protected.ack')) { run.faults.add('protected.ack'); this.event('idle-fault', 'Protected pool saved; response lost'); res.destroy(); return; }
        return json(res, 200, { ok: true, entryId: entry.id, publicationVersion: 2 });
      } catch (err) { req.resume(); return json(res, err.status || 503, { error: 'Protected pool publication unavailable', ...(err.status === 410 && publicationIdentity ? { withdrawn: true, entryId: publicationIdentity.id, publicationVersion: 2 } : {}) }); }
    }
    if (p === '/api/pool-queue' && req.method === 'POST') {
      if (!this.workerPort) return json(res, 503, { error: 'Local bridge stopped' });
      const body = await readBody(req);
      const response = await fetch(`http://127.0.0.1:${this.workerPort}/api/pool-queue`, { method: 'POST', body });
      return json(res, response.status, await response.json());
    }
    if (['/api/relay/pool/sign-upload','/api/booth/pool/sign-upload'].includes(p) && req.method === 'POST') {
      if (!(await this.cloudReady(res)) || this.fault('pool.sign', res)) return;
      const body = JSON.parse(await readBody(req, 4096));
      const entryId = body.retryVersion === 1 ? poolRetry.uploadIdentity('local-twin', body.sessionId, body.code) : randomBytes(8).toString('hex');
      const key = `pool-portraits/${entryId}.jpg`, sig = randomBytes(12).toString('hex');
      run.signed.set(sig, { key, contentType: 'image/jpeg', expires: Date.now() + 600000 });
      this.event('pool-sign', 'Pool portrait upload URL issued');
      return json(res, 200, { entryId, key, retryVersion: body.retryVersion === 1 ? 1 : undefined, uploadUrl: `${this.baseUrl}/storage/${sig}` });
    }
    if (['/api/relay/pool/join','/api/booth/pool/join'].includes(p) && req.method === 'POST') {
      if (!(await this.cloudReady(res)) || this.fault('pool.join', res)) return;
      const body = JSON.parse(await readBody(req, 4096));
      if (!run.objects[body.portraitKey]) return json(res, 400, { error: 'Pool portrait not stored' });
      // Synthetic pool only: no identity, consent, matching or real quiz validation.
      try {
        if (body.retryVersion === 1) {
          if (body.entryId !== poolRetry.uploadIdentity('local-twin', body.sessionId, body.code) || body.portraitKey !== `pool-portraits/${body.entryId}.jpg`) return json(res, 409, { error: 'Identity conflict' });
          await run.joinOnce({ id: body.entryId, boothId: 'local-twin', sessionId: body.sessionId, portraitKey: body.portraitKey });
        }
        run.pool[body.entryId] = { portraitKey: body.portraitKey };
      } catch (err) { return json(res, err.status || 503, { error: 'Pool confirmation failed' }); }
      this.event('pool-joined', 'Synthetic pool portrait registered');
      if (run.scenario === 'idle_ack' && !run.faults.has('pool.ack')) {
        run.faults.add('pool.ack'); this.event('idle-fault', 'Pool saved; confirmation response lost'); res.destroy(); return;
      }
      return json(res, 200, { ok: true, entryId: body.entryId });
    }
    if (p === '/api/video-queue' && req.method === 'POST') {
      if (!this.workerPort) return json(res, 503, { error: 'Local bridge stopped' });
      const body = await readBody(req);
      const upstream = await fetch(`http://127.0.0.1:${this.workerPort}/api/video-queue${url.search}`, { method: 'POST', body, headers: { 'Content-Type': req.headers['content-type'] || 'video/webm' } });
      return json(res, upstream.status, await upstream.json());
    }
    if (p === '/api/relay/sign-upload' || p === '/api/booth/sign-upload') {
      if (!(await this.cloudReady(res))) return;
      if (this.fault('photo.sign', res)) return;
      const wait = Math.max(0, run.coldUntil - Date.now());
      if (wait) { this.event('relay', `Simulated cold start: waiting ${Math.ceil(wait / 1000)}s`); await sleep(wait); }
      if (generation !== this.generation) return json(res, 409, { error: 'Scenario ended' });
      const b = JSON.parse(await readBody(req, 4096));
      const token = b.token || randomBytes(12).toString('base64url');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(token) || !['photo', 'layout', 'story', 'video'].includes(b.kind)) return json(res, 400, { error: 'Invalid token or kind' });
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'video/webm': 'webm' }[b.contentType];
      if (!ext) return json(res, 415, { error: 'Unsupported media' });
      const key = `sessions/${token}/${b.kind}.${ext}`;
      const sig = randomBytes(12).toString('hex'); run.signed.set(sig, { key, contentType: b.contentType, expires: Date.now() + 600000 });
      this.event('sign', `${b.kind}: upload URL issued`, { token, key });
      return json(res, 200, { token, key, uploadUrl: `${this.baseUrl}/storage/${sig}`, expiresIn: 600 });
    }
    if (p.startsWith('/storage/') && req.method === 'PUT') {
      if (!(await this.cloudReady(res))) return;
      const signed = run.signed.get(p.split('/')[2]);
      if (!signed || signed.expires < Date.now()) return json(res, 403, { error: 'Expired local upload URL' });
      if (this.fault(signed.key.startsWith('pool-portraits/') ? 'pool.put' : 'photo.put', res)) return;
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const started = Date.now(); const chunks = []; let bytes = 0;
      this.event('put-start', signed.key);
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) return json(res, 413, { error: 'Local test limit 32 MiB' });
          await this.uplink.transfer(chunk.length, controller.signal);
          if (generation !== this.generation) throw new Error('Scenario ended');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks), hash = createHash('sha256').update(signed.key).digest('hex');
        await writeFile(join(run.dir, 'objects', hash), body);
        run.objects[signed.key] = { file: hash, bytes, contentType: signed.contentType };
        this.event('put-done', `${Math.round(bytes / 1024)} KiB stored in ${((Date.now() - started) / 1000).toFixed(1)}s`, { key: signed.key, bytes });
        return json(res, 200, { ok: true });
      } catch (err) { this.event('put-abort', `${signed.key}: ${err.message}`); return json(res, 499, { error: err.message }); }
    }
    if (p === '/api/relay/photos-ready' || p === '/api/booth/photos-ready') {
      if (!(await this.cloudReady(res))) return;
      const b = JSON.parse(await readBody(req, 8192));
      if (run.commitFailures-- > 0) { this.event('commit-failed', 'Injected confirmation failure → HTTP 503', { token: b.token }); return json(res, 503, { error: 'Simulated confirmation failure' }); }
      if (!run.objects[b.photoKey]) return json(res, 400, { error: 'Photo is not stored' });
      // Explicitly simplified relay: merge keys; no R2 recovery, auth or expiry sweep.
      run.sessions[b.token] = { ...run.sessions[b.token], ...b };
      this.event('confirmed', 'Session registered; download available', { token: b.token });
      if (run.scenario === 'qr_idle_ack' && !run.faults.has('photo.ack')) {
        run.faults.add('photo.ack'); this.event('idle-fault', 'Photo confirmation saved, HTTP acknowledgement lost'); res.destroy(); return;
      }
      return json(res, 200, { ok: true, downloadUrl: `${this.baseUrl}/d/${b.token}` });
    }
    if (p.startsWith('/api/download/')) {
      const session = run.sessions[p.split('/')[3]];
      return json(res, session ? 200 : 404, session || { error: 'Session not confirmed' });
    }
    if (p === '/lab/object') {
      const key = url.searchParams.get('key'), object = run.objects[key];
      if (!object) return json(res, 404, { error: 'Local object not found' });
      res.writeHead(200, { 'Content-Type': object.contentType, 'Cache-Control': 'no-store' });
      return res.end(await readFile(join(run.dir, 'objects', object.file)));
    }
    return false;
  }
}
