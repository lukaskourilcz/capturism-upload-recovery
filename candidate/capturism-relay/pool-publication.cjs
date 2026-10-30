'use strict';
const crypto = require('crypto');
const { uploadIdentity } = require('./pool-retry.cjs');
const failure = (status, message) => Object.assign(new Error(message), { status });
const missing = err => err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey';
const precondition = err => err?.$metadata?.httpStatusCode === 412 || err?.name === 'PreconditionFailed';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_PHOTO = 20 * 1024 * 1024;
async function collect(body, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) throw failure(413, 'Pool object exceeds limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function createPublicationStore({ client, bucket, commands, onPublished = () => {}, onWithdrawn = () => {} }) {
  const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = commands;
  const locks = new Map();
  async function exclusive(id, operation) {
    const previous = locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation); locks.set(id, current);
    try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
  }
  async function get(key, limit = 256 * 1024) {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.ETag) throw failure(503, 'Pool storage version unavailable');
      return { bytes: await collect(response.Body, limit), etag: response.ETag };
    } catch (err) { if (missing(err)) return null; throw err; }
  }
  async function raw(id) {
    const object = await get(`pool/${id}.json`);
    return object && { data: JSON.parse(object.bytes.toString('utf8')), etag: object.etag };
  }
  async function lookup(id) {
    const marker = await get(`pool-deletions/${id}.json`);
    if (marker) return { data: { id, status: 'withdrawn' }, etag: null };
    return raw(id);
  }
  function identify(boothId, data) {
    if (!data || data.retryVersion !== 2 || !/^[a-f0-9]{64}$/.test(data.photoDigest || '') || typeof data.seed !== 'boolean') throw failure(400, 'Invalid pool publication request');
    return { id: uploadIdentity(boothId, data.sessionId, data.code), boothId, sessionId: data.sessionId, seed: data.seed, photoDigest: data.photoDigest };
  }
  async function compatible(state, identity) {
    if (state.status === 'withdrawn') throw failure(410, 'Pool entry withdrawn');
    if (state.id !== identity.id || state.boothId !== identity.boothId || state.sessionId !== identity.sessionId || state.seed !== identity.seed) throw failure(409, 'Pool identity conflict');
    let photoDigest = state.photoDigest;
    if (!photoDigest && ['active','retired'].includes(state.status)) {
      const photo = await get(state.portraitKey, MAX_PHOTO);
      if (!photo) throw failure(503, 'Published portrait unavailable');
      photoDigest = digest(photo.bytes);
    }
    if (photoDigest !== identity.photoDigest) throw failure(409, 'Pool portrait content conflict');
  }
  async function putState(id, value, expected) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `pool/${id}.json`, Body: JSON.stringify(value), ContentType: 'application/json', ...(expected ? { IfMatch: expected } : { IfNoneMatch: '*' }) }));
  }
  async function reserve(identity, validateConsent) {
    return exclusive(identity.id, async () => {
      for (let n = 0; n < 5; n++) {
        const state = await lookup(identity.id);
        if (state) { await compatible(state.data, identity); if (['active','retired'].includes(state.data.status)) onPublished(state.data); return state; }
        validateConsent();
        const pending = { ...identity, status: 'pending', createdAt: new Date().toISOString(), publicationVersion: 2 };
        try { await putState(identity.id, pending); } catch (err) { if (precondition(err)) continue; throw err; }
        const saved = await lookup(identity.id);
        if (!saved) throw failure(503, 'Pool reservation unavailable');
        await compatible(saved.data, identity); return saved;
      }
      throw failure(503, 'Pool reservation contention');
    });
  }
  async function removePortrait(id, extension = 'jpg') {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `pool-portraits/${id}.${extension}` }));
  }
  async function publish(identity, bytes, buildEntry) {
    if (!bytes.length || bytes.length > MAX_PHOTO || digest(bytes) !== identity.photoDigest) throw failure(422, 'Pool portrait digest mismatch');
    return exclusive(identity.id, async () => {
      const state = await lookup(identity.id);
      if (!state) throw failure(503, 'Pool reservation missing');
      await compatible(state.data, identity);
      if (['active','retired'].includes(state.data.status)) { onPublished(state.data); return state.data; }
      if (state.data.status !== 'pending') throw failure(409, 'Invalid pool state');
      const key = `pool-portraits/${identity.id}.jpg`;
      const entry = { ...buildEntry(), ...identity, portraitKey: key, status: 'active', publicationVersion: 2 };
      // No client ever receives this write capability. An existing final
      // object is verified and reused; it is never overwritten.
      try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'image/jpeg', IfNoneMatch: '*' })); }
      catch (err) {
        if (!precondition(err)) throw err;
        const existing = await get(key, MAX_PHOTO);
        if (!existing || digest(existing.bytes) !== identity.photoDigest) throw failure(409, 'Published portrait content conflict');
      }
      try { await putState(identity.id, entry, state.etag); }
      catch (err) {
        if (!precondition(err)) throw err;
        const latest = await lookup(identity.id);
        if (latest?.data.status === 'withdrawn') { await removePortrait(identity.id); throw failure(410, 'Pool entry withdrawn'); }
        if (latest) { await compatible(latest.data, identity); if (['active','retired'].includes(latest.data.status)) { onPublished(latest.data); return latest.data; } }
        throw failure(503, 'Pool publication contention');
      }
      // Catch a withdrawal performed by another relay while this writer
      // was waiting on storage. The canonical tombstone can never be
      // replaced by a stale conditional publication.
      const latest = await lookup(identity.id);
      if (latest?.data.status === 'withdrawn') { await removePortrait(identity.id); throw failure(410, 'Pool entry withdrawn'); }
      if (!latest) throw failure(503, 'Pool confirmation unavailable');
      onPublished(latest.data);
      return latest.data;
    });
  }
  async function withdraw(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) throw failure(400, 'Invalid pool entry id');
    return exclusive(id, async () => {
      let tombstone;
      for (let n = 0; n < 5; n++) {
        const state = await raw(id);
        if (state?.data.status === 'withdrawn') { tombstone = state.data; break; }
        const key = state?.data.portraitKey || `pool-portraits/${id}.jpg`;
        const match = key.match(new RegExp(`^pool-portraits/${id}\\.(jpg|png)$`));
        if (!match) throw failure(409, 'Legacy portrait key requires review');
        tombstone = { id, status: 'withdrawn', deletedAt: new Date().toISOString(), portraitExtension: match[1] };
        try { await putState(id, tombstone, state?.etag); break; }
        catch (err) { if (precondition(err)) { tombstone = null; continue; } throw err; }
      }
      if (!tombstone) throw failure(503, 'Pool withdrawal contention');
      onWithdrawn(id);
      // The occupied canonical slot is the primary durable fence. This
      // audit marker is also persisted before deletion is acknowledged.
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: `pool-deletions/${id}.json`, Body: JSON.stringify({ entryId: id, deletedAt: tombstone.deletedAt }), ContentType: 'application/json' }));
      await removePortrait(id, tombstone.portraitExtension || 'jpg');
      return tombstone;
    });
  }
  async function update(entry) {
    return exclusive(entry.id, async () => {
      const state = await lookup(entry.id);
      if (!state || state.data.status === 'withdrawn') throw failure(410, 'Pool entry withdrawn');
      // A normal metadata update must not change a published identity,
      // portrait or already-recorded distribution history.
      if (state.data.portraitKey !== entry.portraitKey || state.data.boothId !== entry.boothId || state.data.sessionId !== entry.sessionId || state.data.seed !== entry.seed || (state.data.photoDigest && state.data.photoDigest !== entry.photoDigest) || (state.data.distributionCount || 0) > (entry.distributionCount || 0)) throw failure(409, 'Pool update conflict');
      const history = state.data.distributions || [];
      if (JSON.stringify((entry.distributions || []).slice(0, history.length)) !== JSON.stringify(history)) throw failure(409, 'Pool history conflict');
      await putState(entry.id, entry, state.etag);
      onPublished(entry);
    });
  }
  return { identify, reserve, publish, withdraw, lookup, update, collect, MAX_PHOTO };
}
module.exports = { createPublicationStore, collect, MAX_PHOTO };
