'use strict';

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
        MEDIA.some(field => data[field] !== undefined && !validKey(data[field]))) throw failure(503, 'Invalid stored download metadata');
  }
  async function read(token) {
    const key = keyFor(token);
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
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); validate(data);
      return { data, etag: response.ETag };
    } catch (err) { if (missing(err)) return null; throw err; }
  }
  async function change(token, input, patchOnly) {
    keyFor(token);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure(400, 'Invalid download metadata');
    for (const field of MEDIA) if (input[field] != null && input[field] !== '' && !validKey(input[field])) throw failure(400, 'Invalid media key');
    if (!patchOnly && (!validKey(input.photoKey) || typeof input.boothId !== 'string' || !input.boothId)) throw failure(400, 'Invalid photo identity');
    if (input.videosPending !== undefined && typeof input.videosPending !== 'boolean') throw failure(400, 'Invalid video state');
    return exclusive(token, async () => {
      // Always read durable state after locking. A warm cache cannot prove
      // that a previous writer saved, or that another relay has not updated it.
      for (let attempt = 0; attempt < 5; attempt++) {
        const stored = await read(token), old = stored?.data;
        if (old && old.expiresAt <= now()) { cache.delete(token); throw failure(410, 'Download session expired'); }
        if (!old && patchOnly) throw failure(503, 'Download metadata missing');
        if (old && !patchOnly && (old.photoKey !== input.photoKey || old.boothId !== input.boothId)) throw failure(409, 'Download identity conflict');
        const createdAt = old?.createdAt ?? now();
        const next = old ? { ...old } : { photoKey: input.photoKey, boothId: input.boothId, createdAt, expiresAt: createdAt + ttlMs };
        for (const field of MEDIA) {
          if (input[field] == null || input[field] === '') continue;
          if (old?.[field] && old[field] !== input[field]) throw failure(409, 'Download media conflict');
          next[field] = input[field];
        }
        // Omitted fields and photo-only replays cannot erase completed videos
        // or restart the original waiting/retention clocks.
        if (input.videosPending === true) next.videosPending = true;
        if (!old || JSON.stringify(next) !== JSON.stringify(old)) {
          try {
            await client.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(token), Body: JSON.stringify(next), ContentType: 'application/json',
              ...(stored ? { IfMatch: stored.etag } : { IfNoneMatch: '*' }) }));
          } catch (err) { if (conflict(err)) continue; throw err; }
        }
        // No false-success cache mutation: only an acknowledged PUT or a fresh
        // durable read of an already-identical commit reaches this point.
        if (next.expiresAt <= now()) { cache.delete(token); throw failure(410, 'Download session expired'); }
        cache.set(token, next);
        return next;
      }
      throw failure(503, 'Download metadata contention');
    });
  }
  async function load(token) {
    keyFor(token);
    let data = cache.get(token);
    if (!data) { const stored = await read(token); data = stored?.data; }
    if (!data || data.expiresAt <= now()) { cache.delete(token); return null; }
    cache.set(token, data); return data;
  }
  return { save: (token, input) => change(token, input, false), patch: (token, input) => change(token, input, true), load };
}
module.exports = { createSessionMetadataStore };
