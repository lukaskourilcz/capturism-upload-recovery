/**
 * pool.js — the l'INCONNU pool (formerly "Lost Connection"; renamed by
 * spec amendment 1 — internal identifiers keep the original names so the
 * revenue category and R2 prefixes stay stable).
 *
 * A visitor who completed the phone quiz (quiz.js) and confirmed at the
 * booth leaves behind their portrait, first name, Instagram handle and
 * quiz answers. Future compatible visitors receive that entry as their
 * second print. Not a dating product — the framing everywhere is "the
 * compatible stranger".
 *
 * Persistence — one R2 object per record, mirrored in memory (same pattern
 * as reviewPipeline.js):
 *   pool/<id>.json            — the entry record (see shape below)
 *   pool-portraits/<id>.jpg   — the portrait (uploaded via presigned PUT)
 *   pool-matches/<id>.json    — append-only match log
 *
 * ⚠️ These prefixes are deliberately OUTSIDE sessions/ — that prefix has a
 * 24h R2 lifecycle rule. Pool data must persist until withdrawal.
 *
 * Entry record:
 *   { id, boothId, firstName, handle, answers: [{questionId, answerId}],
 *     sessionId, language, seed, portraitKey, createdAt,
 *     ageConfirmed, marketingConsent,
 *     consent: { pool: {agreedAt, text}, marketing: {agreedAt, text}|null,
 *                confirmedInStudioAt },
 *     distributionCount, distributions: [{sessionId, score, at}],
 *     status: "active" | "retired" }
 *
 * Consent provenance: identity + consents are copied from the REDEEMED
 * quiz record server-side at join (the kiosk only sends the code), so a
 * pool entry can never exist without a consented quiz submission — strict
 * reciprocity is structural, not a UI promise.
 *
 * GDPR: deletion (deleteEntry) is REAL — both R2 objects are removed and the
 * in-memory entry dropped. Triggered manually from the admin dashboard when
 * someone emails paris@capturism.com.
 *
 * Config (env, all optional):
 *   POOL_MAX_DISTRIBUTIONS      default 3 — entry retires after N handouts
 *   POOL_MIN_ACTIVE             default 25 — mode hidden on kiosk below this
 *   POOL_REQUIRE_OPTIN_TO_RECEIVE  default true (amendment B1 — strict
 *                               reciprocity; "false" re-enables generous mode)
 *   POOL_MATCH_FLOOR            default 3 — min shared answers, else Waiting Card
 */

"use strict";

const crypto = require("crypto");
const { uploadIdentity, createJoinCoordinator } = require("./pool-retry.cjs");
const {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const quiz = require("./quiz");
const backup = require("./backup");

// ── Config ──────────────────────────────────────────────────────────
const MAX_DISTRIBUTIONS = Number(process.env.POOL_MAX_DISTRIBUTIONS || 3);
const MIN_ACTIVE = Number(process.env.POOL_MIN_ACTIVE || 25);
const REQUIRE_OPTIN_TO_RECEIVE = process.env.POOL_REQUIRE_OPTIN_TO_RECEIVE !== "false";
const MATCH_FLOOR = Number(process.env.POOL_MATCH_FLOOR || 3);

const ENTRY_PREFIX = "pool/";
const PORTRAIT_PREFIX = "pool-portraits/";
const MATCH_PREFIX = "pool-matches/";
const SIGNED_UPLOAD_TTL_S = 300;

const PORTRAIT_CONTENT_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
]);

// Injected once from server.js via init()
let r2Client = null;
let R2_BUCKET = "";
let jsonResponse = null;
let readBody = null;

// In-memory mirror (id → entry). Hydrated from R2 on boot.
const entries = new Map();
let hydrated = false;
let hydrationPromise = null;
function ensureHydrated() {
  if (hydrated) return Promise.resolve(true);
  if (!hydrationPromise) hydrationPromise = hydrate().then(ok => { hydrated = ok; return ok; }).finally(() => { hydrationPromise = null; });
  return hydrationPromise;
}
const joinOnce = createJoinCoordinator({ entries, persist: entry => persistEntry(entry, true) });

// ── Public API ──────────────────────────────────────────────────────

/** Wire up storage + helpers and hydrate. Call once at boot. */
function init({ client, bucket, jsonResponse: jsonFn, readBody: readFn }) {
  r2Client = client;
  R2_BUCKET = bucket;
  jsonResponse = jsonFn;
  readBody = readFn;
  console.log(
    `[pool] max_distributions=${MAX_DISTRIBUTIONS} min_active=${MIN_ACTIVE} require_optin_to_receive=${REQUIRE_OPTIN_TO_RECEIVE}`,
  );
  void ensureHydrated();
}

function activeCount() {
  let n = 0;
  for (const e of entries.values()) if (e.status === "active") n += 1;
  return n;
}

// ── Booth endpoints (auth done by caller in server.js) ──────────────

/**
 * POST /api/booth/pool/sign-upload — body { contentType }
 * Mints an entry id + presigned PUT for the portrait. The entry itself is
 * only created by /join; an uploaded portrait with no join is inert junk.
 */
function handleSignUpload(req, res, boothId) {
  if (!r2Client) return jsonResponse(res, 500, { error: "Storage not configured" });
  readBody(req, async (body) => {
    let data;
    try { data = JSON.parse(body); }
    catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

    if (data.retryVersion === 1 && !(await ensureHydrated())) return jsonResponse(res, 503, { error: "Pool storage not ready" });
    const ext = PORTRAIT_CONTENT_TYPES.get(data.contentType);
    if (!ext) return jsonResponse(res, 400, { error: "Unsupported contentType" });

    let entryId;
    if (data.retryVersion === 1) {
      const record = quiz.getRecordByCode(data.code);
      if (!record || record.status !== "redeemed" || (record.redeemedBy && record.redeemedBy !== boothId)) return jsonResponse(res, 400, { error: "No redeemed quiz record" });
      try { entryId = uploadIdentity(boothId, data.sessionId, data.code); }
      catch { return jsonResponse(res, 400, { error: "Invalid pool upload identity" }); }
    } else entryId = crypto.randomBytes(8).toString("hex");
    const key = `${PORTRAIT_PREFIX}${entryId}.${ext}`;
    try {
      const uploadUrl = await getSignedUrl(
        r2Client,
        new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: data.contentType }),
        { expiresIn: SIGNED_UPLOAD_TTL_S },
      );
      console.log(`[pool] signed portrait upload for ${boothId} → ${key}`);
      jsonResponse(res, 200, { entryId, key, uploadUrl, expiresIn: SIGNED_UPLOAD_TTL_S, retryVersion: data.retryVersion === 1 ? 1 : undefined });
    } catch (err) {
      console.error(`[pool] sign-upload failed: ${err.message}`);
      jsonResponse(res, 500, { error: "Failed to sign upload URL" });
    }
  });
}

/**
 * POST /api/booth/pool/join — create the entry after the portrait PUT and
 * the FINAL in-studio confirmation.
 * Body: { entryId, portraitKey, code, sessionId, seed? }
 * Identity + answers + consents come from the redeemed quiz record (looked
 * up by code server-side) — never from the kiosk payload.
 */
function handlePoolJoin(req, res, boothId) {
  if (!r2Client) return jsonResponse(res, 500, { error: "Storage not configured" });
  readBody(req, async (body) => {
    let data;
    try { data = JSON.parse(body); }
    catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

    if (data.retryVersion === 1 && !(await ensureHydrated())) return jsonResponse(res, 503, { error: "Pool storage not ready" });
    const entryId = typeof data.entryId === "string" && /^[a-f0-9]{16}$/.test(data.entryId)
      ? data.entryId : null;
    const portraitKey = typeof data.portraitKey === "string" && data.portraitKey.startsWith(PORTRAIT_PREFIX)
      ? data.portraitKey : null;
    if (!entryId || !portraitKey) return jsonResponse(res, 400, { error: "Missing entryId/portraitKey" });
    if (data.retryVersion !== 1 && entries.has(entryId)) return jsonResponse(res, 409, { error: "Entry already exists" });

    const record = quiz.getRecordByCode(data.code);
    if (!record || record.status !== "redeemed" || (record.redeemedBy && record.redeemedBy !== boothId)) {
      return jsonResponse(res, 400, { error: "No redeemed quiz record for this code" });
    }

    if (data.retryVersion === 1) {
      let expected;
      try { expected = uploadIdentity(boothId, data.sessionId, data.code); }
      catch { return jsonResponse(res, 400, { error: "Invalid pool upload identity" }); }
      if (entryId !== expected || portraitKey !== `${PORTRAIT_PREFIX}${entryId}.jpg`) return jsonResponse(res, 409, { error: "Pool upload identity conflict" });
    }
    const entry = {
      id: entryId,
      boothId,
      firstName: record.firstName,
      handle: record.handle,
      answers: record.answers,
      sessionId: String(data.sessionId || ""),
      language: record.language,
      seed: data.seed === true,
      portraitKey,
      createdAt: new Date().toISOString(),
      ageConfirmed: record.ageConfirmed === true,
      marketingConsent: record.marketingConsent === true,
      consent: {
        ...record.consent,
        confirmedInStudioAt: new Date().toISOString(),
      },
      distributionCount: 0,
      distributions: [],
      status: "active",
    };
    try {
      if (data.retryVersion === 1) await joinOnce(entry);
      else { await persistEntry(entry, true); entries.set(entry.id, entry); }
    } catch (err) {
      return jsonResponse(res, err.status === 409 ? 409 : 503, { error: err.status === 409 ? "Pool upload identity conflict" : "Pool entry not saved; retry confirmation" });
    }
    console.log(`[pool] joined: ${entry.firstName} (@${entry.handle}) — ${activeCount()} active`);
    jsonResponse(res, 200, { ok: true, entryId: entry.id, activeCount: activeCount() });
  });
}

/**
 * POST /api/booth/pool/match — body { answers, sessionId, joined }
 * Runs the matching algorithm and CONSUMES one distribution on the chosen
 * entry. Returns { match: {...} } or { match: null, reason }.
 */
function handlePoolMatch(req, res, boothId) {
  readBody(req, async (body) => {
    let data;
    try { data = JSON.parse(body); }
    catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

    const answers = sanitizeAnswers(data.answers);
    const sessionId = String(data.sessionId || "");
    if (!answers) return jsonResponse(res, 400, { error: "Invalid answers" });

    if (REQUIRE_OPTIN_TO_RECEIVE && data.joined !== true) {
      return jsonResponse(res, 200, { match: null, reason: "optin_required" });
    }

    const picked = pickMatch(answers, sessionId);
    if (!picked) {
      console.log(`[pool] no candidate for session ${sessionId} (${activeCount()} active)`);
      return jsonResponse(res, 200, { match: null, reason: "empty_pool" });
    }

    const { entry, score, sharedAnswers } = picked;
    entry.distributionCount += 1;
    entry.distributions.push({ sessionId, score, at: new Date().toISOString() });
    if (entry.distributionCount >= MAX_DISTRIBUTIONS) entry.status = "retired";
    await persistEntry(entry);
    void logMatch({ boothId, entryId: entry.id, visitorSessionId: sessionId, score, sharedAnswers });

    console.log(
      `[pool] match: session ${sessionId} ← ${entry.firstName} (@${entry.handle}) score=${score} dist=${entry.distributionCount}/${MAX_DISTRIBUTIONS}${entry.status === "retired" ? " (retired)" : ""}`,
    );
    jsonResponse(res, 200, {
      match: {
        entryId: entry.id,
        firstName: entry.firstName,
        handle: entry.handle,
        createdAt: entry.createdAt,
        score,
        sharedAnswers,
      },
    });
  });
}

/** GET /api/booth/pool/status — feature gating info for the kiosk. */
function handlePoolStatus(req, res) {
  const active = activeCount();
  jsonResponse(res, 200, {
    activeCount: active,
    minPool: MIN_ACTIVE,
    featureEnabled: active >= MIN_ACTIVE,
    requireOptinToReceive: REQUIRE_OPTIN_TO_RECEIVE,
  });
}

/**
 * GET portrait bytes by entry id (used by both booth print flow and admin
 * preview — auth is the caller's job). Streams through the relay so the
 * kiosk never needs R2 CORS and the admin never sees a raw R2 URL.
 */
async function streamPortrait(req, res, entryId) {
  const entry = entries.get(String(entryId || ""));
  if (!entry) return jsonResponse(res, 404, { error: "Unknown entry" });
  if (!r2Client) return jsonResponse(res, 500, { error: "Storage not configured" });
  try {
    const r = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: entry.portraitKey }));
    res.writeHead(200, {
      "Content-Type": r.ContentType || "image/jpeg",
      "Cache-Control": "private, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      ...(r.ContentLength ? { "Content-Length": r.ContentLength } : {}),
    });
    r.Body.pipe(res);
    r.Body.on("error", (err) => {
      console.error(`[pool] portrait stream error ${entry.portraitKey}: ${err.message}`);
      try { res.destroy(); } catch {}
    });
  } catch (err) {
    console.error(`[pool] portrait fetch failed ${entry.portraitKey}: ${err.message}`);
    if (!res.headersSent) jsonResponse(res, 500, { error: "Could not fetch portrait" });
  }
}

// ── Admin endpoints (JWT verified by caller in server.js) ───────────

/** GET /api/admin/pool — full list (minus portraits) + stats. */
function handleAdminList(req, res) {
  const list = [...entries.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((e) => ({
      id: e.id,
      firstName: e.firstName,
      handle: e.handle,
      answers: e.answers,
      language: e.language,
      seed: e.seed,
      createdAt: e.createdAt,
      consentAgreedAt: (e.consent && (e.consent.confirmedInStudioAt || e.consent.agreedAt)) || null,
      // Only entries with this flag may appear in Capturism's own
      // communications — queryable here per amendment B5.
      marketingConsent: e.marketingConsent === true,
      distributionCount: e.distributionCount,
      status: e.status,
    }));

  let retired = 0;
  let distributions = 0;
  const answerProfiles = {};
  for (const e of entries.values()) {
    if (e.status === "retired") retired += 1;
    distributions += e.distributionCount;
    // Profile signature: answers joined in question order, to spot thin
    // regions of the answer space (e.g. "q1:a|q2:b|…": 4 entries).
    const sig = e.answers.map((a) => `${a.questionId}:${a.answerId}`).join("|");
    answerProfiles[sig] = (answerProfiles[sig] || 0) + 1;
  }

  jsonResponse(res, 200, {
    stats: {
      active: activeCount(),
      retired,
      total: entries.size,
      distributions,
      minPool: MIN_ACTIVE,
      maxDistributions: MAX_DISTRIBUTIONS,
      answerProfiles,
      lastBackupAt: backup.status().lastBackupAt,
    },
    entries: list,
  });
}

/**
 * POST /api/admin/pool/delete — body { entryId } or { handle }.
 * REAL deletion: portrait object + record object + memory. This is the
 * GDPR withdrawal path — a soft flag is not acceptable here.
 */
function handleAdminDelete(req, res) {
  readBody(req, async (body) => {
    let data;
    try { data = JSON.parse(body); }
    catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

    let entry = null;
    if (data.entryId) entry = entries.get(String(data.entryId));
    else if (data.handle) {
      const h = normalizeHandle(data.handle);
      entry = [...entries.values()].find((e) => e.handle === h) || null;
    }
    if (!entry) return jsonResponse(res, 404, { error: "Entry not found" });

    try {
      await deleteEntry(entry);
      // Amendment 2 §1: log the deletion EVENT — date + entry id only.
      // Deliberately no name/handle anywhere (including this console line):
      // after a withdrawal, no personal data may survive in any log.
      void logDeletion(entry.id);
      console.log(`[pool] DELETED entry ${entry.id} — withdrawal`);
      jsonResponse(res, 200, { ok: true, deleted: entry.id });
    } catch (err) {
      console.error(`[pool] delete failed for ${entry.id}: ${err.message}`);
      jsonResponse(res, 500, { error: "Deletion failed — entry NOT fully removed, retry" });
    }
  });
}

// ── Matching ────────────────────────────────────────────────────────

/**
 * Score = number of identical answer_ids across the 5 questions.
 * (A per-question "compatible-but-different" map can slot in here later —
 * score contributions would come from the question config instead of
 * strict equality.)
 */
function scoreAgainst(visitorAnswers, entry) {
  const byQuestion = new Map(entry.answers.map((a) => [a.questionId, a.answerId]));
  let score = 0;
  const sharedAnswers = [];
  for (const a of visitorAnswers) {
    if (byQuestion.get(a.questionId) === a.answerId) {
      score += 1;
      sharedAnswers.push({ questionId: a.questionId, answerId: a.answerId });
    }
  }
  return { score, sharedAnswers };
}

/**
 * Amendment B6 — RELATIVE band, not absolute:
 *   1. Floor: candidates need ≥ MATCH_FLOOR shared answers (else Waiting Card).
 *   2. Near-match preferred over identical: perfect scores (all answers
 *      identical) are EXCLUDED when a non-perfect candidate exists within
 *      2 points of perfect.
 *   3. Top band = candidates within 1 point of the (remaining) maximum.
 *   4. Random within the band — the randomness is part of the product.
 */
function pickMatch(visitorAnswers, sessionId) {
  let scored = [];
  for (const entry of entries.values()) {
    if (entry.status !== "active") continue;
    if (entry.distributionCount >= MAX_DISTRIBUTIONS) continue;
    // No self-match / same group session, and never hand the same visitor
    // the same entry twice.
    if (sessionId && entry.sessionId === sessionId) continue;
    if (sessionId && entry.distributions.some((d) => d.sessionId === sessionId)) continue;
    const { score, sharedAnswers } = scoreAgainst(visitorAnswers, entry);
    if (score >= MATCH_FLOOR) scored.push({ entry, score, sharedAnswers });
  }
  if (!scored.length) return null;

  const perfect = visitorAnswers.length;
  let max = Math.max(...scored.map((c) => c.score));
  if (max === perfect) {
    const nearMatches = scored.filter((c) => c.score < perfect && c.score >= perfect - 2);
    if (nearMatches.length) {
      scored = scored.filter((c) => c.score < perfect);
      max = Math.max(...scored.map((c) => c.score));
    }
  }

  const band = scored.filter((c) => c.score >= max - 1);
  return band[Math.floor(Math.random() * band.length)];
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Strip @, lowercase, validate plausible IG handle. Returns null if bad. */
function normalizeHandle(raw) {
  const h = String(raw || "").trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(h)) return null;
  return h;
}

/** Validate [{questionId, answerId}] with 1..20 short string entries. */
function sanitizeAnswers(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return null;
  const out = [];
  for (const a of raw) {
    if (!a || typeof a.questionId !== "string" || typeof a.answerId !== "string") return null;
    if (a.questionId.length > 40 || a.answerId.length > 40) return null;
    out.push({ questionId: a.questionId, answerId: a.answerId });
  }
  return out;
}

// ── R2 persistence ──────────────────────────────────────────────────

async function persistEntry(entry, strict = false) {
  if (!r2Client) { if (strict) throw new Error("Storage not configured"); return; }
  try {
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `${ENTRY_PREFIX}${entry.id}.json`,
      Body: JSON.stringify(entry),
      ContentType: "application/json",
    }));
  } catch (err) {
    console.error(`[pool] R2 persist failed for ${entry.id}: ${err.message}`);
    if (strict) throw err;
  }
}

async function deleteEntry(entry) {
  // Portrait first: if this throws, the record survives and the admin can
  // retry; the reverse order could orphan an unfindable portrait.
  await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: entry.portraitKey }));
  await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: `${ENTRY_PREFIX}${entry.id}.json` }));
  entries.delete(entry.id);
}

/** Withdrawal audit trail: { entryId, deletedAt } — nothing else, ever. */
async function logDeletion(entryId) {
  if (!r2Client) return;
  try {
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `pool-deletions/${entryId}.json`,
      Body: JSON.stringify({ entryId, deletedAt: new Date().toISOString() }),
      ContentType: "application/json",
    }));
  } catch (err) {
    console.error(`[pool] deletion log failed for ${entryId}: ${err.message}`);
  }
}

async function logMatch(match) {
  if (!r2Client) return;
  const id = crypto.randomBytes(8).toString("hex");
  try {
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `${MATCH_PREFIX}${id}.json`,
      Body: JSON.stringify({ id, ...match, at: new Date().toISOString() }),
      ContentType: "application/json",
    }));
  } catch (err) {
    console.error(`[pool] match log failed: ${err.message}`);
  }
}

async function hydrate() {
  if (!r2Client) {
    console.log("[pool] R2 not configured — pool runs in-memory only (dev).");
    return false;
  }
  try {
    let failed = false;
    let token;
    do {
      const page = await r2Client.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: ENTRY_PREFIX,
        ContinuationToken: token,
      }));
      for (const obj of page.Contents || []) {
        try {
          const got = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key }));
          const entry = JSON.parse(await got.Body.transformToString());
          if (entry && entry.id) entries.set(entry.id, entry);
        } catch (err) {
          console.error(`[pool] hydrate skip ${obj.Key}: ${err.message}`);
          failed = true;
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    console.log(`[pool] hydrated — ${entries.size} entrie(s), ${activeCount()} active.`);
    return !failed;
  } catch (err) {
    console.error(`[pool] hydration failed: ${err.message}`);
    return false;
  }
}

module.exports = {
  init,
  handleSignUpload,
  handlePoolJoin,
  handlePoolMatch,
  handlePoolStatus,
  streamPortrait,
  handleAdminList,
  handleAdminDelete,
};
