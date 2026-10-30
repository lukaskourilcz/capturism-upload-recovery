'use strict';
const crypto = require('crypto');
function uploadIdentity(boothId, sessionId, code) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || !/^\d{6}$/.test(String(code))) {
    throw Object.assign(new Error('Invalid pool upload identity'), { status: 400 });
  }
  return crypto.createHash('sha256').update(JSON.stringify([boothId, sessionId, String(code)])).digest('hex').slice(0, 16);
}
function createJoinCoordinator({ entries, persist }) {
  const pending = new Map();
  function same(a, b) { return a.id === b.id && a.boothId === b.boothId && a.sessionId === b.sessionId && a.portraitKey === b.portraitKey; }
  function conflict() { throw Object.assign(new Error('Pool upload identity conflict'), { status: 409 }); }
  return async function join(entry) {
    const key = JSON.stringify([entry.boothId, entry.sessionId]);
    if (pending.has(key)) { const stored = await pending.get(key); if (!same(stored, entry)) conflict(); return stored; }
    const existing = entries.get(entry.id) || [...entries.values()].find(e => e.boothId === entry.boothId && e.sessionId === entry.sessionId);
    if (existing) { if (!same(existing, entry)) conflict(); return existing; }
    const save = (async () => {
      // Do not expose an entry in the in-memory pool until durable save succeeds.
      await persist(entry); entries.set(entry.id, entry); return entry;
    })();
    pending.set(key, save);
    try { return await save; } finally { pending.delete(key); }
  };
}
module.exports = { uploadIdentity, createJoinCoordinator };
