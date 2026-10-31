'use strict';
const { createHash } = require('node:crypto');
const mediaScope = require('./qr-media-scope.cjs');

const failure = (status, message) => Object.assign(new Error(message), { status });
const missing = err => err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
const conflict = err => err?.name === 'PreconditionFailed' || err?.$metadata?.httpStatusCode === 412;
const MEDIA = ['videoKey', 'layoutVideoKey', 'storyVideoKey'];
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 1024 && !/[\x00-\x1f]/.test(key);

function createSessionMetadataStore({ client, bucket, commands, cache, ttlMs, now = Date.now }) {
  const { GetObjectCommand, PutObjectCommand } = commands;
  const locks = new Map();
  const keyFor = token => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) throw failure(400, 'Invalid download token');
    return `sessions/${token}/meta.json`;
  };
  async function exclusive(token, operation) {
    const previous = locks.get(token) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation); locks.set(token, current);
    try { return await current; } finally { if (locks.get(token) === current) locks.delete(token); }
  }
  function validate(data) {
    if (!data || typeof data !== 'object' || !validKey(data.photoKey) || typeof data.boothId !== 'string' || !data.boothId ||
        !Number.isFinite(data.createdAt) || !Number.isFinite(data.expiresAt) || data.expiresAt <= data.createdAt ||
        (data.videoWaitStartedAt !== undefined && (!Number.isFinite(data.videoWaitStartedAt) || data.videoWaitStartedAt < data.createdAt || data.videoWaitStartedAt >= data.expiresAt)) ||
        MEDIA.some(field => data[field] !== undefined && !validKey(data[field]))) throw failure(503, 'Invalid stored download metadata');
  }
  async function readObject(key, validator) {
    if (!client || !bucket) throw failure(503, 'Download storage unavailable');
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.ETag) throw failure(503, 'Download storage version unavailable');
      const chunks = []; let size = 0;
      for await (const chunk of response.Body) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 64 * 1024) throw failure(503, 'Stored download metadata exceeds limit');
        chunks.push(bytes);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); validator(data);
      return { data, etag: response.ETag };
    } catch (err) { if (missing(err)) return null; throw err; }
  }
  const read = token => readObject(keyFor(token), validate);
  const readApproval = async key => (await readObject(key, () => {}))?.data;
  const authorize = (token, data) => mediaScope.authorize(token, data, readApproval);
  const ensureAuthorized = async (token, data) => {
    keyFor(token); validate(data);
    if (data.expiresAt <= now()) throw failure(410, 'Download session expired');
    await authorize(token, data);
    if (data.expiresAt <= now()) throw failure(410, 'Download session expired');
  };
  const hash = value => createHash('sha256').update(value).digest('hex');
  const identity = data => hash(JSON.stringify([data.boothId, data.photoKey]));
  const expiryKey = token => { keyFor(token); return `qr-expiry/v1/${hash(token)}.json`; };
  function validateExpiry(data) {
    if (!data || data.version !== 1 || !/^[a-f0-9]{64}$/.test(data.identityHash) ||
        !Number.isFinite(data.createdAt) || !Number.isFinite(data.expiresAt) ||
        data.expiresAt <= data.createdAt || data.expiresAt - data.createdAt > ttlMs) throw failure(503, 'Invalid download expiry record');
  }
  async function authority(token, stored, fresh) {
    // This immutable, minimal record must be excluded from sessions/ cleanup.
    // Only a server-minted token may establish a new clock. A caller-supplied
    // token without either proof or legacy durable metadata is never reissued.
    const key = expiryKey(token);
    let candidate;
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await readObject(key, validateExpiry);
      if (existing) {
        const proof = existing.data;
        if (stored && (identity(stored) !== proof.identityHash || stored.createdAt !== proof.createdAt || stored.expiresAt !== proof.expiresAt)) throw failure(503, 'Download expiry record conflict');
        return proof;
      }
      if (!candidate) {
        const createdAt = now();
        const original = stored || (fresh && { ...fresh, createdAt, expiresAt: createdAt + ttlMs });
        if (!original) return null;
        candidate = { version: 1, identityHash: identity(original), createdAt: original.createdAt, expiresAt: original.expiresAt };
        validateExpiry(candidate);
      }
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(candidate), ContentType: 'application/json', IfNoneMatch: '*' }));
        return candidate;
      } catch (err) { if (!conflict(err)) throw err; }
    }
    throw failure(503, 'Download expiry record contention');
  }
  function live(token, proof) {
    if (!proof || proof.expiresAt <= now()) { cache.delete(token); throw failure(410, 'Download session expired or unissued'); }
  }
  async function issue(token, input, { fresh = false } = {}) {
    keyFor(token);
    if (!input || !validKey(input.photoKey) || typeof input.boothId !== 'string' || !input.boothId) throw failure(400, 'Invalid photo identity');
    mediaScope.assertAsset('photoKey', input.photoKey);
    if (fresh && !mediaScope.canonical(token, 'photoKey', input.photoKey)) throw failure(403, 'Download media not authorized');
    return exclusive(token, async () => {
      const old = (await read(token))?.data;
      if (old) await ensureAuthorized(token, old);
      const proof = await authority(token, old, fresh ? input : null);
      live(token, proof);
      if (identity(input) !== proof.identityHash) throw failure(409, 'Download identity conflict');
      return proof;
    });
  }
  async function videoClock(token, proof, startedAt) {
    // Separate create-only clock: metadata cleanup/replay cannot restart waiting.
    // Legacy or partial restores use their earliest known durable creation time.
    const key = `qr-video-wait/v1/${hash(token)}.json`;
    const validateClock = data => {
      validateExpiry(data);
      if (data.identityHash !== proof.identityHash || data.createdAt !== proof.createdAt || data.expiresAt !== proof.expiresAt ||
          !Number.isFinite(data.startedAt) || data.startedAt < proof.createdAt || data.startedAt >= proof.expiresAt) throw failure(503, 'Invalid video wait clock');
    };
    let candidate;
    for (let attempt = 0; attempt < 5; attempt++) {
      const stored = await readObject(key, validateClock);
      if (stored) {
        if (startedAt !== undefined && stored.data.startedAt !== startedAt) throw failure(503, 'Video wait clock conflict');
        return stored.data.startedAt;
      }
      if (startedAt === undefined) return null;
      if (!candidate) {
        if (startedAt >= proof.expiresAt) { cache.delete(token); throw failure(410, 'Download session expired'); }
        candidate = { version: 1, identityHash: proof.identityHash, createdAt: proof.createdAt, expiresAt: proof.expiresAt, startedAt };
        validateClock(candidate);
      }
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(candidate), ContentType: 'application/json', IfNoneMatch: '*' }));
        return candidate.startedAt;
      } catch (err) { if (!conflict(err)) throw err; }
    }
    throw failure(503, 'Video wait clock contention');
  }
  async function change(token, input, patchOnly) {
    keyFor(token);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure(400, 'Invalid download metadata');
    for (const field of MEDIA) if (input[field] != null && input[field] !== '' && !validKey(input[field])) throw failure(400, 'Invalid media key');
    if (!patchOnly && (!validKey(input.photoKey) || typeof input.boothId !== 'string' || !input.boothId)) throw failure(400, 'Invalid photo identity');
    if (input.videosPending !== undefined && typeof input.videosPending !== 'boolean') throw failure(400, 'Invalid video state');
    for (const field of mediaScope.FIELDS) if (input[field] != null && input[field] !== '') mediaScope.assertAsset(field, input[field]);
    return exclusive(token, async () => {
      // Always read durable state after locking. A warm cache cannot prove
      // that a previous writer saved, or that another relay has not updated it.
      for (let attempt = 0; attempt < 5; attempt++) {
        const stored = await read(token), old = stored?.data;
        if (old) await ensureAuthorized(token, old);
        const proof = await authority(token, old);
        live(token, proof);
        if (!patchOnly && identity(input) !== proof.identityHash) throw failure(409, 'Download identity conflict');
        if (!old && patchOnly) throw failure(503, 'Download metadata missing');
        if (old && !patchOnly && (old.photoKey !== input.photoKey || old.boothId !== input.boothId)) throw failure(409, 'Download identity conflict');
        const next = old ? { ...old } : { photoKey: input.photoKey, boothId: input.boothId, createdAt: proof.createdAt, expiresAt: proof.expiresAt };
        if (!old) {
          // Reconstruct only from independently approved, exact assets bound
          // to this original identity/lifetime. Approval cannot issue a clock.
          const approved = await mediaScope.legacyAssets(token, next, readApproval, { optional: true });
          for (const field of MEDIA) if (approved[field]) next[field] = approved[field];
        }
        for (const field of MEDIA) {
          if (!input[field]) continue;
          if (next[field] && next[field] !== input[field]) throw failure(409, 'Download media conflict');
          next[field] = input[field];
        }
        const savedClock = await videoClock(token, proof);
        const videoWaitStartedAt = savedClock ?? old?.videoWaitStartedAt ?? old?.createdAt ?? now();
        if (old?.videoWaitStartedAt !== undefined && old.videoWaitStartedAt !== videoWaitStartedAt) throw failure(503, 'Video wait clock conflict');
        if (videoWaitStartedAt >= proof.expiresAt) { cache.delete(token); throw failure(410, 'Download session expired'); }
        live(token, proof);
        if (!old) next.videoWaitStartedAt = videoWaitStartedAt;
        // Omitted fields and photo-only replays cannot erase completed videos
        // or restart the original waiting/retention clocks.
        if (input.videosPending === true) next.videosPending = true;
        validate(next);
        await authorize(token, next);
        if (!old || JSON.stringify(next) !== JSON.stringify(old)) {
          try {
            await client.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(token), Body: JSON.stringify(next), ContentType: 'application/json',
              ...(stored ? { IfMatch: stored.etag } : { IfNoneMatch: '*' }) }));
          } catch (err) { if (conflict(err)) continue; throw err; }
        }
        // No false-success cache mutation: only an acknowledged PUT or a fresh
        // durable read of an already-identical commit reaches this point.
        if (next.expiresAt <= now()) { cache.delete(token); throw failure(410, 'Download session expired'); }
        // Only a durable metadata commit establishes first confirmation. Failed
        // metadata attempts leave no clock behind; a lost ACK is reconciled from
        // the timestamp in that commit. The independent record survives cleanup.
        if (savedClock === null) await videoClock(token, proof, videoWaitStartedAt);
        live(token, proof);
        // A slow save may overlap approval revocation. Public reads also
        // recheck scope; do not acknowledge/promote a now-denied mapping.
        await ensureAuthorized(token, next);
        const committed = { ...next, videoWaitStartedAt };
        cache.set(token, committed);
        return committed;
      }
      throw failure(503, 'Download metadata contention');
    });
  }
  async function load(token, { fresh = false } = {}) {
    keyFor(token);
    let data = fresh ? null : cache.get(token);
    if (!data) {
      const stored = await read(token); data = stored?.data;
      if (data) {
        if (data.expiresAt <= now()) { cache.delete(token); return null; }
        await authorize(token, data);
        const proof = await authority(token, data);
        if (!proof || proof.expiresAt <= now()) return null;
        const savedClock = await videoClock(token, proof);
        const startedAt = savedClock ?? data.videoWaitStartedAt ?? data.createdAt;
        if (data.videoWaitStartedAt !== undefined && data.videoWaitStartedAt !== startedAt) throw failure(503, 'Video wait clock conflict');
        data = { ...data, videoWaitStartedAt: savedClock ?? await videoClock(token, proof, startedAt) };
      }
    }
    if (!data || data.expiresAt <= now()) { cache.delete(token); return null; }
    await authorize(token, data);
    cache.set(token, data); return data;
  }
  return { authorize: ensureAuthorized, issue, save: (token, input) => change(token, input, false), patch: (token, input) => change(token, input, true), load };
}
module.exports = { createSessionMetadataStore };
