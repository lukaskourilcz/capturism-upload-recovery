import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import metadata from '../../candidate/capturism-relay/session-metadata.cjs';
import { storageCommands } from './relay-fixture.mjs';

const candidate = await readFile(new URL('../../candidate/capturism-relay/server.js', import.meta.url), 'utf8');
export const TOKEN = 'synthetic-token';
export const PHOTO = `sessions/${TOKEN}/photo.jpg`;
export const BODY = { token: TOKEN, photoKey: PHOTO };
export function qrFunctions(source, { probeVideos = true } = {}) {
  const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
  };
  const code = section('async function handleProxyAsset(', '/**\n * Validate the X-Booth-Auth') +
    section('function handleSubscribe(', '/**\n * GET /api/admin/subscriptions.xlsx') +
    section('function handleSignUpload(', '/**\n * POST /api/booth/photos-ready') +
    section('function handlePhotosReady(', '/**\n * POST /api/dev/seed') +
    section('function handleDevSeed(', '/**\n * POST /api/subscribe') +
    section('async function storeSession(', '/**\n * Presign an R2 GET.') +
    section('async function patchSession(', '/**\n * Look for a session') +
    section('async function handleGetDownload(', '/**\n * GET /api/proxy/:token/');
  const ws = section('    // booth:photos_ready — store token', '    // Persist session_complete');
  return code + (probeVideos ? section('async function probeForVideos(', 'async function handleGetDownload(') : '') + '\nasync function handleWsPhotosReady(msg, boothId) {\n' + ws + '\n}';
}
export function makeQrRelay(store, { probeTimeoutMs = 15000, probeVideos = true, code = candidate, boothId = 'synthetic-booth', now = Date.now, signR2Url = async key => 'http://127.0.0.1/synthetic-object/' + encodeURIComponent(key) } = {}) {
  const cache = new Map(), notifications = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } }
  const context = { sessions: cache, SESSION_TTL_MS: 86400000, VIDEO_PENDING_GRACE_MS: 600000,
    R2_BUCKET: 'isolated-local-fixture', r2Client: store, ...storageCommands,
    Buffer, crypto, Date: Clock, AbortController, setTimeout, clearTimeout, videoProbes: new Map(), videoProbeNegatives: new WeakMap(), VIDEO_PROBE_TIMEOUT_MS: probeTimeoutMs, ALLOWED_UPLOAD_CONTENT_TYPES: new Set(['image/jpeg', 'image/png', 'video/mp4', 'video/webm']),
    CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'video/webm': 'webm' }, SIGNED_UPLOAD_TTL_S: 300,
    getSignedUrl: async (_, cmd) => 'http://127.0.0.1/upload/' + encodeURIComponent(cmd.input.Key), console: { log() {}, warn() {}, error() {} }, DEV_SEED_KEY: 'synthetic',
    authenticateBooth: () => boothId, broadcastToAdmins: event => notifications.push(event),
    readBody(req, callback) {
      void (async () => {
        if (Object.hasOwn(req, 'body')) return callback(JSON.stringify(req.body));
        let body = ''; for await (const chunk of req) body += chunk;
        return callback(body);
      })().catch(error => req.fail ? req.fail(error) : req.destroy?.(error));
    },
    jsonResponse(res, status, body) {
      if (res.resolve) res.resolve({ status, body });
      else { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    },
    signR2Url,
    probeForVideos: async (_, session) => session,
    sessionMetadata: metadata.createSessionMetadataStore({ client: store, bucket: 'isolated-local-fixture', commands: storageCommands, cache, ttlMs: 86400000, now }),
  };
  vm.createContext(context); vm.runInContext(qrFunctions(code, { probeVideos }), context);
  return { ...context, cache, notifications,
    issue: (token = TOKEN, photoKey = PHOTO) => context.sessionMetadata.issue(token, { boothId, photoKey }, { fresh: true }),
    sign: body => new Promise((resolve, reject) => context.handleSignUpload({ body, fail: reject }, { resolve })),
    confirm: body => new Promise((resolve, reject) => context.handlePhotosReady({ body, fail: reject }, { resolve })),
    download: token => new Promise((resolve, reject) => { void context.handleGetDownload({}, { resolve }, token).catch(reject); }),
  };
}
