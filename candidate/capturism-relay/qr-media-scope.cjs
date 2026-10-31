'use strict';
const { createHash } = require('node:crypto');
const FIELDS = ['photoKey', 'videoKey', 'layoutVideoKey', 'storyVideoKey'];
const KIND = { photoKey: 'photo', videoKey: 'video', layoutVideoKey: 'layout', storyVideoKey: 'story' };
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const denied = () => Object.assign(new Error('Download media not authorized'), { status: 403 });
const identity = data => hash(JSON.stringify([data.boothId, data.photoKey]));
function approvalKey(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw denied();
  return `qr-media-authorizations/v1/${hash(token)}.json`;
}
function canonical(token, field, key) {
  if (typeof token !== 'string' || !TOKEN.test(token) || !FIELDS.includes(field) || typeof key !== 'string') return false;
  return (field === 'photoKey' ? ['jpg','png'] : ['mp4','webm']).some(ext => key === `sessions/${token}/${KIND[field]}.${ext}`);
}
function safeAsset(field, key) {
  if (!FIELDS.includes(field) || typeof key !== 'string') return false;
  // Legacy approval is deliberately limited to actual session-media shapes.
  // Private/admin namespaces, traversal, encoded paths and disguised JSON never qualify.
  return field === 'photoKey'
    ? /^sessions\/[A-Za-z0-9_-]{8,64}\/photo\.(jpg|jpeg|png)$/.test(key)
    : /^sessions\/[A-Za-z0-9_-]{8,64}\/(video|layout|story)\.(mp4|webm)$/.test(key);
}
function assertAsset(field, key) { if (!safeAsset(field, key)) throw denied(); }
function validateApproval(token, session, approval) {
  if (!approval || approval.version !== 1 || approval.tokenHash !== hash(token) || approval.identityHash !== identity(session) ||
      approval.createdAt !== session.createdAt || approval.expiresAt !== session.expiresAt ||
      !approval.assets || typeof approval.assets !== 'object' || Array.isArray(approval.assets) || approval.assets.photoKey !== session.photoKey ||
      Object.keys(approval.assets).some(field => !FIELDS.includes(field))) throw denied();
  for (const [field, key] of Object.entries(approval.assets)) assertAsset(field, key);
}
function buildLegacyApproval(token, session) {
  approvalKey(token);
  if (!session || typeof session.boothId !== 'string' || !session.boothId || !Number.isFinite(session.createdAt) ||
      !Number.isFinite(session.expiresAt) || session.expiresAt <= session.createdAt) throw denied();
  const assets = {};
  for (const field of FIELDS) if (session[field] !== undefined) { assertAsset(field, session[field]); assets[field] = session[field]; }
  if (!assets.photoKey) throw denied();
  return { version: 1, tokenHash: hash(token), identityHash: identity(session), createdAt: session.createdAt, expiresAt: session.expiresAt, assets };
}
async function legacyAssets(token, session, readApproval, { optional = false } = {}) {
  const key = approvalKey(token);
  let approval;
  try { approval = await readApproval(key); }
  catch { throw Object.assign(new Error('Media authorization temporarily unavailable'), { mediaAuthorization: true, status: 503 }); }
  // Only a confirmed missing object is optional, never an unreadable approval.
  if (approval === undefined && optional) return {};
  validateApproval(token, session, approval);
  return { ...approval.assets };
}
async function authorize(token, session, readApproval) {
  approvalKey(token);
  const legacy = [];
  for (const field of FIELDS) {
    const key = session[field];
    if (key === undefined && field !== 'photoKey') continue;
    assertAsset(field, key);
    if (!canonical(token, field, key)) legacy.push(field);
  }
  if (!legacy.length) return;
  const assets = await legacyAssets(token, session, readApproval);
  for (const field of legacy) if (assets[field] !== session[field]) throw denied();
}
module.exports = { FIELDS, approvalKey, canonical, assertAsset, authorize, legacyAssets, buildLegacyApproval };
