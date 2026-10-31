/**
 * Capturism Relay Server
 *
 * WebSocket relay that bridges photo booth machines in shops
 * with the admin dashboard. Booths and admins connect outbound
 * via WSS; the relay forwards messages between them.
 */

require("dotenv").config();

// ─── Sentry init (must run BEFORE other imports for instrumentation) ────
const Sentry = require("@sentry/node");
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "production",
    tracesSampleRate: 0.01,
    // Don't ship request bodies — they can contain photo URLs / tokens.
    sendDefaultPii: false,
  });
  console.log("[sentry] relay error reporting enabled");
} else {
  console.log("[sentry] SENTRY_DSN unset — relay error reporting disabled");
}

const http = require("http");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const url = require("url");
const crypto = require("crypto");
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const XLSX = require("xlsx");
const { buildAndSendDailyReport, sendViaResend, aggregateForDay, formatReportText } = require("./dailyReport");
const { normalizeCompReason, isComp, rollupRevenue } = require("./comp");
const reviewPipeline = require("./reviewPipeline");
const pool = require("./pool");
const quiz = require("./quiz");
const backup = require("./backup");
const { createSessionMetadataStore } = require("./session-metadata.cjs");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3002;
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// Admin dashboard origins that may call the admin endpoints. The dashboard
// moved from GitHub Pages → Cloudflare Pages, so BOTH the custom domain and
// the *.pages.dev URL must work — plus anything set in CORS_ORIGIN (which can
// be a comma-separated list). We reflect the request's Origin when it's on the
// allowlist (a single Access-Control-Allow-Origin can't list multiple values).
const ADMIN_ALLOWED_ORIGINS = new Set(
  [
    "https://admin.capturism.com",
    "https://capturism-admin.pages.dev",
    ...CORS_ORIGIN.split(",").map((s) => s.trim()),
  ].filter((o) => o && o !== "*"),
);

/** Pick the Access-Control-Allow-Origin value for an admin (non-public) request. */
function adminAllowOrigin(reqOrigin) {
  if (CORS_ORIGIN === "*") return "*";
  if (reqOrigin && ADMIN_ALLOWED_ORIGINS.has(reqOrigin)) return reqOrigin;
  return CORS_ORIGIN.split(",")[0].trim() || "https://admin.capturism.com";
}
const JWT_EXPIRY = "30d";
const HEARTBEAT_TIMEOUT_MS = 90_000; // 90 seconds
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 5;

// Session/download token config
const videoProbeNegatives = new WeakMap(); // Completed negatives belong only to this validated session object.
const videoProbes = new Map(); // Per-token in-flight discovery only; entries settle within 15s.
const VIDEO_PROBE_TIMEOUT_MS = 15_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SIGNED_URL_TTL_S = 3600; // 1 hour
const SIGNED_UPLOAD_TTL_S = 300; // 5 minutes — booth must upload promptly after signing
const DEV_SEED_KEY = process.env.DEV_SEED_KEY || ""; // if empty, /api/dev/seed disabled

// ─── Daily report config ──────────────────────────────────────────────────
// Once-a-day end-of-day summary email to the operator. See
// ./dailyReport.js for the setup instructions.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const DAILY_REPORT_EMAIL = process.env.DAILY_REPORT_EMAIL || "acson@aurm.group";
const DAILY_REPORT_FROM = process.env.DAILY_REPORT_FROM || "Capturism Reports <onboarding@resend.dev>";
const DAILY_REPORT_TIMEZONE = process.env.DAILY_REPORT_TIMEZONE || "Europe/Paris";
const DAILY_REPORT_HOUR = parseInt(process.env.DAILY_REPORT_HOUR || "23", 10);
const DAILY_REPORT_MINUTE = parseInt(process.env.DAILY_REPORT_MINUTE || "30", 10);
const DAILY_REPORT_CONFIGURED = !!RESEND_API_KEY;

const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "video/mp4",
  "video/webm",
]);
const CONTENT_TYPE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

// R2 (S3-compatible) config
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";

const r2Configured = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
const r2Client = r2Configured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      // AWS SDK v3 (>=3.729) defaults requestChecksumCalculation to
      // "WHEN_SUPPORTED", which bakes an x-amz-checksum-crc32 query param
      // into PRESIGNED PutObject URLs. Because the body isn't known at
      // signing time, that checksum is computed over an empty body
      // (=AAAAAA==), so the browser's real (non-empty) PUT gets rejected
      // by R2 with a digest mismatch — the booth upload silently fails and
      // the customer's download QR never resolves. "WHEN_REQUIRED" emits a
      // clean presigned PUT (PutObject doesn't require a checksum), which
      // R2 accepts. See relayUpload.ts putToR2 — the browser sends only
      // Content-Type, no checksum header.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    })
  : null;

// Parse booth API keys from env: "booth_marais:key1,booth_latin:key2"
const BOOTH_API_KEYS = new Map();
if (process.env.BOOTH_API_KEYS) {
  process.env.BOOTH_API_KEYS.split(",").forEach((entry) => {
    const [boothId, key] = entry.trim().split(":");
    if (boothId && key) BOOTH_API_KEYS.set(boothId, key);
  });
}

// Optional booth → city map for subscriber exports. Format same as keys:
// "booth-mabillon:Paris,booth-uea:Dubai". Falls back to boothId if missing.
const BOOTH_CITIES = new Map();
if (process.env.BOOTH_CITIES) {
  process.env.BOOTH_CITIES.split(",").forEach((entry) => {
    const [boothId, city] = entry.trim().split(":");
    if (boothId && city) BOOTH_CITIES.set(boothId, city);
  });
}
// Hardcoded fallback so the export works out of the box for the one booth.
if (!BOOTH_CITIES.has("booth-mabillon")) BOOTH_CITIES.set("booth-mabillon", "Paris");

// Whitelist of admin commands that can be forwarded to booths
const ADMIN_COMMAND_WHITELIST = new Set([
  "admin:update_price",
  "admin:update_config",
  "admin:restart_session",
  // "I just replaced the ribbon / paper" — the booth resets that counter.
  "admin:reset_media",
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, { ws: WebSocket, boothId: string, lastSeen: number }>} */
const booths = new Map();

/** @type {Set<WebSocket>} */
const admins = new Set();

// Last printer media levels (ribbon + paper) each booth reported on a
// heartbeat, so the admin dashboard can display them. Purely informational —
// nothing here ever gates a session. Kept outside `booths` on purpose: that
// map is cleared when a booth disconnects, and the operator still wants to
// see how much ribbon and paper the booth had when it went quiet.
/** @type {Map<string, object>} */
const boothMedia = new Map();

// ─── Operational alerts ──────────────────────────────────────────────────
// Failure notifications from the booth (print failed, terminal missing,
// payment captured-but-not-collected, camera stalled) plus relay-detected
// booth-offline events. Each alert is broadcast live to every admin dashboard
// AND emailed to the operator (throttled per code). The in-memory ring buffer
// hydrates a freshly-opened admin; the email is the durable record.
const ALERT_EMAIL = process.env.ALERT_EMAIL || process.env.DAILY_REPORT_EMAIL || "acson@aurm.group";
const ALERT_FROM = process.env.ALERT_FROM || process.env.DAILY_REPORT_FROM || "Capturism Alerts <onboarding@resend.dev>";
const ALERT_HOURS_START = Number(process.env.ALERT_HOURS_START ?? 7);  // local hour, inclusive
const ALERT_HOURS_END = Number(process.env.ALERT_HOURS_END ?? 24);     // local hour, exclusive
const ALERT_EMAIL_THROTTLE_MS = 10 * 60_000; // at most one email per code / 10 min
const ALERT_MAX = 100;
/** @type {Array<{id:string,boothId:string,code:string,severity:string,message:string,context:object|null,timestamp:string}>} */
const alerts = [];
const alertEmailThrottle = new Map(); // code → last-email epoch ms
const offlineAlerted = new Set();     // boothIds already emailed an "offline" for

const ALERT_SUBJECTS = {
  print_failed: "Print failed",
  capture_failed: "Payment captured-but-not-collected",
  terminal_missing: "Card terminal not detected",
  terminal_recovered: "Card terminal reconnected",
  camera_stalled: "Camera not responding",
  booth_offline: "Booth offline",
  booth_recovered: "Booth back online",
  media_low: "Printer media low",
  media_empty: "Printer media empty",
  video_upload_failed: "Customer video upload failed",
  test: "Test alert",
};

/** @type {Map<string, { count: number, resetAt: number }>} */
const loginAttempts = new Map();

/**
 * Download sessions: token → photo/video R2 keys.
 * Keyed by random token shown in the customer's QR/URL.
 *
 *   photoKey         — final print image (always present)
 *   videoKey         — full session recording (used as download-page bg)
 *   layoutVideoKey   — polished N-cell layout video ("Download Video" button)
 *   storyVideoKey    — pre-baked 1080×1920 Stories share output
 *
 * @type {Map<string, { photoKey: string, videoKey?: string, layoutVideoKey?: string, storyVideoKey?: string, boothId: string, createdAt: number, expiresAt: number }>}
 */
const sessions = new Map();
const sessionMetadata = createSessionMetadataStore({ client: r2Client, bucket: R2_BUCKET,
  commands: { GetObjectCommand, PutObjectCommand }, cache: sessions, ttlMs: SESSION_TTL_MS });

/**
 * Session-complete events used to compute admin stats. Persisted to R2
 * at `stats/sessions.json` so admin refreshes and Render redeploys do not
 * wipe accumulated revenue.
 * Each entry: { boothId, amount, category, transactionId, timestamp }
 * @type {Array<{ boothId: string, amount: number, category: string, transactionId: string, timestamp: string }>}
 */
let sessionEvents = [];
const STATS_R2_KEY = "stats/sessions.json";

// ─── Pricing config (live-updatable by admin) ────────────────────────────
// Single source of truth that the kiosk reads on connect + via WS
// broadcasts when admin updates. Defaults match the legacy hardcoded
// values from capturism-app/src/lib/pricing.ts so a kiosk that starts
// before the relay has loaded pricing still uses sane fallbacks.
let pricingConfig = {
  photoIdFlat: 12,
  photoBase: 15,
  photoStep: 6,
  calendarBase: 18,
  calendarStep: 7,
  // l'INCONNU — its own flat per-session price, NOT tied to photoBase.
  // The session is quiz + exactly two prints (your portrait + the
  // stranger's card) and admits no extra prints, so it has no step key.
  // It used to inherit photoBase, which meant repricing Layout silently
  // repriced l'INCONNU too (owner, 2026-09-05: "Only at 15 EUR").
  lostConnection: 15,
  // Photo LARGE (15x23 cm). Starts at ONE print — one large is about the
  // area of two smalls, so it carries the same 15 EUR entry price — then
  // +10 per extra. sanitizePricing whitelists from this object, so these
  // two lines are what make the admin's large-format fields work.
  photoLargeBase: 15,
  photoLargeStep: 10,
  // Mini sheet: swap ONE paid print for a sheet of nine minis of the same
  // composition. Charged ONCE per session, never per print — "one sheet
  // only" (owner, 2026-09-14). Portraits only: the kiosk ignores it for
  // Photo ID (government size rules), postcards (worldwide standard) and
  // calendars. sanitizePricing whitelists from this object, so this line
  // is what makes the admin's mini-sheet field accepted + broadcast.
  photoMiniSheet: 1,
};
const PRICING_R2_KEY = "config/pricing.json";

/**
 * How long after a session is created we are still willing to tell the
 * download page "your video is on its way". Past this, an unfinished video
 * upload is treated as failed rather than pending — see handleGetDownload.
 * Generous on purpose: the booth uploads up to three MP4s with no timeout,
 * and Render can cold-start for 30-60s before the first byte lands.
 */
const VIDEO_PENDING_GRACE_MS = 10 * 60_000;

const startTime = Date.now();

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url?.split('?')[0] !== '/api/booth/pool/upload') {
    const deadline = setTimeout(() => req.destroy(new Error('Request body deadline')), 60000);
    req.once('end', () => clearTimeout(deadline)); req.once('close', () => clearTimeout(deadline));
    res.once('finish', () => clearTimeout(deadline));
  }

  const parsed = url.parse(req.url, true);

  // CORS headers:
  //   /api/download/*  — public, any origin (token is the credential)
  //   /api/booth/*     — any origin allowed (already authenticated via X-Booth-Auth header)
  //   /api/health      — public read-only ping (returns uptime + connected
  //                      booth count). Has to allow any origin so the kiosk
  //                      (localhost:5173) and the public download page can
  //                      both keep-warm-ping Render, preventing the free-tier
  //                      spin-down that otherwise makes the first upload of
  //                      the day wait 30-60 s on a cold boot.
  //   everything else  — locked to CORS_ORIGIN (admin endpoints)
  const isPublicDownload = /^\/api\/download\/[A-Za-z0-9_-]+$/.test(parsed.pathname);
  const isPublicProxy = /^\/api\/proxy\/[A-Za-z0-9_-]+\/(photo|video|layout|story)$/.test(parsed.pathname);
  const isPublicSubscribe = parsed.pathname === "/api/subscribe";
  const isPublicRating = parsed.pathname === "/r"; // star click from review emails
  const isBoothEndpoint = /^\/api\/booth\//.test(parsed.pathname);
  const isHealthCheck = parsed.pathname === "/api/health";
  // /api/quiz/* — the public l'INCONNU phone quiz (capturism-quiz web
  // app on Cloudflare Pages). Any origin: the quiz URL is a marketing
  // surface shared publicly; the submit endpoint is rate-limited instead.
  const isPublicQuiz = /^\/api\/quiz\//.test(parsed.pathname);
  const allowAnyOrigin = isPublicDownload || isPublicProxy || isPublicSubscribe || isPublicRating || isBoothEndpoint || isHealthCheck || isPublicQuiz;
  res.setHeader("Access-Control-Allow-Origin", allowAnyOrigin ? "*" : adminAllowOrigin(req.headers.origin));
  if (!allowAnyOrigin) res.setHeader("Vary", "Origin"); // origin-dependent response — don't let caches cross-serve it
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Booth-Auth");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- GET /api/health ----
  // Public read-only. `emailConfigured` lets us confirm (without a password)
  // that daily reports AND alert emails will actually send.
  if (req.method === "GET" && parsed.pathname === "/api/health") {
    return jsonResponse(res, 200, {
      ok: true,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      connectedBooths: booths.size,
      emailConfigured: DAILY_REPORT_CONFIGURED,
    });
  }

  // ---- GET /r ---- (public: star-rating click from review-request emails)
  if (req.method === "GET" && parsed.pathname === "/r") {
    return reviewPipeline.handleRating(req, res, parsed.query);
  }

  // ---- POST /api/auth/login ----
  if (req.method === "POST" && parsed.pathname === "/api/auth/login") {
    return handleLogin(req, res);
  }

  // ---- GET /api/booths ----
  if (req.method === "GET" && parsed.pathname === "/api/booths") {
    return handleGetBooths(req, res);
  }

  // ---- GET /api/download/:token ----
  const downloadMatch = parsed.pathname.match(/^\/api\/download\/([A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && downloadMatch) {
    return handleGetDownload(req, res, downloadMatch[1]);
  }

  // ---- GET /api/proxy/:token/(photo|video|layout|story) ----
  // Bytes proxy — streams the R2 object through the relay so the browser
  // doesn't hit R2 directly (avoids CORS headaches on the share flow).
  const proxyMatch = parsed.pathname.match(/^\/api\/proxy\/([A-Za-z0-9_-]+)\/(photo|video|layout|story)$/);
  if (req.method === "GET" && proxyMatch) {
    return handleProxyAsset(req, res, proxyMatch[1], proxyMatch[2]);
  }

  // ---- POST /api/booth/sign-upload ----
  if (req.method === "POST" && parsed.pathname === "/api/booth/sign-upload") {
    return handleSignUpload(req, res);
  }

  // ---- POST /api/booth/photos-ready ----
  if (req.method === "POST" && parsed.pathname === "/api/booth/photos-ready") {
    return handlePhotosReady(req, res);
  }

  // ---- POST /api/dev/seed ----
  if (req.method === "POST" && parsed.pathname === "/api/dev/seed") {
    return handleDevSeed(req, res);
  }

  // ---- l'INCONNU phone quiz (public: quiz web app; booth: redemption) ----
  if (parsed.pathname === "/api/quiz/config" && req.method === "GET") {
    return quiz.handleQuizConfig(req, res);
  }
  // Anonymous funnel beacon (sendBeacon POSTs text/plain — no preflight).
  if (parsed.pathname === "/api/quiz/event" && req.method === "POST") {
    return quiz.handleQuizEvent(req, res);
  }
  if (parsed.pathname === "/api/quiz/submit" && req.method === "POST") {
    // Rate-limit key: first X-Forwarded-For hop (Render terminates TLS
    // in front of us) falling back to the socket address.
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return quiz.handleQuizSubmit(req, res, fwd || req.socket.remoteAddress || "unknown");
  }
  if (parsed.pathname === "/api/booth/quiz/redeem" && req.method === "POST") {
    const boothId = authenticateBooth(req, res);
    if (!boothId) return;
    return quiz.handleQuizRedeem(req, res, boothId);
  }

  // ---- l'INCONNU pool — booth side (X-Booth-Auth, via bridge proxy) ----
  if (parsed.pathname === "/api/booth/pool/upload" && req.method === "POST") {
    const boothId = authenticateBooth(req, res);
    if (!boothId) { req.resume(); return; }
    return pool.handlePoolUpload(req, res, boothId);
  }
  if (parsed.pathname === "/api/booth/pool/sign-upload" && req.method === "POST") {
    const boothId = authenticateBooth(req, res);
    if (!boothId) return;
    return pool.handleSignUpload(req, res, boothId);
  }
  if (parsed.pathname === "/api/booth/pool/join" && req.method === "POST") {
    const boothId = authenticateBooth(req, res);
    if (!boothId) return;
    return pool.handlePoolJoin(req, res, boothId);
  }
  if (parsed.pathname === "/api/booth/pool/match" && req.method === "POST") {
    const boothId = authenticateBooth(req, res);
    if (!boothId) return;
    return pool.handlePoolMatch(req, res, boothId);
  }
  if (parsed.pathname === "/api/booth/pool/status" && req.method === "GET") {
    if (!authenticateBooth(req, res)) return;
    return pool.handlePoolStatus(req, res);
  }
  // GET /api/booth/pool/portrait?id=<entryId> — streamed bytes for the
  // Lost Connection card print (proxied through the bridge → no CORS/taint).
  if (parsed.pathname === "/api/booth/pool/portrait" && req.method === "GET") {
    if (!authenticateBooth(req, res)) return;
    return pool.streamPortrait(req, res, parsed.query.id);
  }

  // ---- l'INCONNU pool — admin side (JWT) ----
  if (parsed.pathname === "/api/admin/pool" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    return pool.handleAdminList(req, res);
  }
  if (parsed.pathname === "/api/admin/quiz-funnel" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    return quiz.handleAdminFunnel(req, res);
  }
  // POST (not DELETE) — the CORS Allow-Methods header above only lists
  // GET/POST, and every other admin mutation here is a POST already.
  if (parsed.pathname === "/api/admin/pool/delete" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    return pool.handleAdminDelete(req, res);
  }
  // Portrait preview is loaded by a plain <img>, which can't set an
  // Authorization header — accept the admin JWT as ?t= as well (same
  // pattern as the admin WebSocket's ?token= query auth).
  if (parsed.pathname === "/api/admin/pool/portrait" && req.method === "GET") {
    const queryToken = typeof parsed.query.t === "string" ? parsed.query.t : "";
    let queryAuthed = false;
    if (queryToken) {
      try { jwt.verify(queryToken, JWT_SECRET); queryAuthed = true; } catch { /* fall through */ }
    }
    if (!queryAuthed && !requireAdmin(req, res)) return;
    return pool.streamPortrait(req, res, parsed.query.id);
  }

  // ---- POST /api/subscribe ---- (public; called from the download page)
  if (req.method === "POST" && parsed.pathname === "/api/subscribe") {
    return handleSubscribe(req, res);
  }

  // ---- GET /api/admin/subscriptions.xlsx ---- (admin JWT)
  if (req.method === "GET" && parsed.pathname === "/api/admin/subscriptions.xlsx") {
    return handleSubscriptionsXlsx(req, res, parsed.query);
  }

  // ---- GET /api/admin/pricing ---- (admin JWT)
  // Returns the current relay-side pricing config. Editing this in admin
  // calls POST below; the kiosk learns of changes via the
  // admin:pricing_updated WS broadcast.
  if (req.method === "GET" && parsed.pathname === "/api/admin/pricing") {
    return handlePricingGet(req, res);
  }
  // ---- POST /api/admin/pricing ---- (admin JWT)
  // Body: { photoIdFlat, photoBase, photoStep, calendarBase, calendarStep }
  // Validates inputs, persists to R2, broadcasts to all connected booths.
  if (req.method === "POST" && parsed.pathname === "/api/admin/pricing") {
    return handlePricingPost(req, res);
  }

  // ---- GET /api/admin/daily-summary ---- (admin JWT)
  // Same aggregation as the nightly email, but returned as JSON instead of
  // sent via Resend — works even when RESEND_API_KEY isn't configured.
  // Optional ?date=YYYY-MM-DD (defaults to today in DAILY_REPORT_TIMEZONE).
  if (req.method === "GET" && parsed.pathname === "/api/admin/daily-summary") {
    return handleDailySummary(req, res, parsed.query);
  }

  // ---- POST /api/admin/daily-report/send-now ---- (admin JWT)
  // Force-trigger today's report for testing. Useful right after Resend
  // setup to confirm the API key + sender address work end-to-end without
  // waiting for 23:30.
  if (req.method === "POST" && parsed.pathname === "/api/admin/daily-report/send-now") {
    return handleDailyReportSendNow(req, res);
  }

  // ---- POST /api/admin/alert/test ---- (admin JWT)
  // Fire a harmless test alert so the operator can confirm the email + admin
  // banner pipeline works end-to-end without breaking a printer on purpose.
  if (req.method === "POST" && parsed.pathname === "/api/admin/alert/test") {
    return handleAlertTest(req, res);
  }

  // Fallback 404
  jsonResponse(res, 404, { error: "Not found" });
});

/**
 * Verify the admin JWT. Returns true on success; on failure the 401 has
 * already been sent. Same check as every handler below — extracted for the
 * pool endpoints instead of adding more copies.
 */
function requireAdmin(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    jsonResponse(res, 401, { error: "Authorization required" });
    return false;
  }
  try {
    jwt.verify(authHeader.slice(7), JWT_SECRET);
    return true;
  } catch {
    jsonResponse(res, 401, { error: "Invalid or expired token" });
    return false;
  }
}

function handleAlertTest(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse(res, 401, { error: "Authorization required" });
  }
  try {
    jwt.verify(authHeader.slice(7), JWT_SECRET);
  } catch {
    return jsonResponse(res, 401, { error: "Invalid or expired token" });
  }
  // Bypass the per-code email throttle so the test always sends.
  alertEmailThrottle.delete("test");
  const alert = dispatchAlert({
    boothId: [...BOOTH_API_KEYS.keys()][0] || "booth-mabillon",
    code: "test",
    severity: "warning", // warning so it actually emails (info is panel-only)
    message: "This is a test alert — if you got this email and saw it on the dashboard, alerts work.",
  });
  return jsonResponse(res, 200, { ok: true, alert, emailConfigured: !!RESEND_API_KEY });
}

function handlePricingGet(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse(res, 401, { error: "Authorization required" });
  }
  try { jwt.verify(authHeader.slice(7), JWT_SECRET); }
  catch { return jsonResponse(res, 401, { error: "Invalid or expired token" }); }
  return jsonResponse(res, 200, { pricing: pricingConfig });
}

async function handlePricingPost(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse(res, 401, { error: "Authorization required" });
  }
  try { jwt.verify(authHeader.slice(7), JWT_SECRET); }
  catch { return jsonResponse(res, 401, { error: "Invalid or expired token" }); }
  let body = "";
  for await (const chunk of req) body += chunk;
  let parsedBody;
  try { parsedBody = JSON.parse(body); }
  catch { return jsonResponse(res, 400, { error: "Invalid JSON body" }); }
  const sanitised = sanitizePricing(parsedBody);
  pricingConfig = sanitised;
  await persistAndBroadcastPricing();
  return jsonResponse(res, 200, { pricing: pricingConfig });
}

function handleDailySummary(req, res, query) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse(res, 401, { error: "Authorization required" });
  }
  try {
    jwt.verify(authHeader.slice(7), JWT_SECRET);
  } catch {
    return jsonResponse(res, 401, { error: "Invalid or expired token" });
  }
  let dayISO = query.date;
  if (dayISO !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayISO)) {
      return jsonResponse(res, 400, { error: "Invalid date — expected YYYY-MM-DD" });
    }
  } else {
    dayISO = isoDateInZone(new Date(), DAILY_REPORT_TIMEZONE);
  }
  const boothId = [...BOOTH_API_KEYS.keys()][0] || "booth-mabillon";
  const city = BOOTH_CITIES.get(boothId);
  const agg = aggregateForDay(sessionEvents, dayISO, DAILY_REPORT_TIMEZONE);
  if (!agg) {
    const plaintext = `Capturism — Daily report for ${dayISO}\nBooth: ${boothId}${city ? ` (${city})` : ""}\n\nNo sessions today.\n\n— automated by capturism-relay`;
    return jsonResponse(res, 200, {
      date: dayISO,
      plaintext,
      totals: { sessions: 0, revenue: 0, avgPerSession: 0, byCategory: {}, busiestHour: null, firstAt: null, lastAt: null },
    });
  }
  return jsonResponse(res, 200, {
    date: dayISO,
    plaintext: formatReportText(boothId, city, agg, dayISO),
    totals: agg,
  });
}

async function handleDailyReportSendNow(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse(res, 401, { error: "Authorization required" });
  }
  try {
    jwt.verify(authHeader.slice(7), JWT_SECRET);
  } catch {
    return jsonResponse(res, 401, { error: "Invalid or expired token" });
  }
  if (!DAILY_REPORT_CONFIGURED) {
    return jsonResponse(res, 503, { error: "Daily report not configured (set RESEND_API_KEY on Render env)" });
  }
  const now = new Date();
  const todayISO = isoDateInZone(now, DAILY_REPORT_TIMEZONE);
  const boothId = [...BOOTH_API_KEYS.keys()][0] || "booth-mabillon";
  const city = BOOTH_CITIES.get(boothId);
  try {
    const ok = await buildAndSendDailyReport({
      events: sessionEvents,
      boothId,
      city,
      dayISO: todayISO,
      timezone: DAILY_REPORT_TIMEZONE,
      apiKey: RESEND_API_KEY,
      from: DAILY_REPORT_FROM,
      to: DAILY_REPORT_EMAIL,
    });
    return jsonResponse(res, ok ? 200 : 502, { ok, sentAt: now.toISOString(), to: DAILY_REPORT_EMAIL });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// HTTP Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/login
 * Accepts { password }, validates against bcrypt hash, returns JWT.
 */
function handleLogin(req, res) {
  const ip = req.socket.remoteAddress;

  // Rate limiting
  const now = Date.now();
  let limiter = loginAttempts.get(ip);
  if (limiter && now < limiter.resetAt) {
    if (limiter.count >= RATE_LIMIT_MAX) {
      console.warn(`[AUTH] Rate limited: ${ip}`);
      return jsonResponse(res, 429, { error: "Too many attempts. Try again later." });
    }
  } else {
    limiter = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    loginAttempts.set(ip, limiter);
  }

  readBody(req, (body) => {
    let password;
    try {
      password = JSON.parse(body).password;
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    if (!password) {
      return jsonResponse(res, 400, { error: "Password required" });
    }

    limiter.count++;
    console.log(`[AUTH] Login attempt from ${ip} (attempt ${limiter.count})`);

    if (!ADMIN_PASSWORD_HASH) {
      console.error("[AUTH] ADMIN_PASSWORD_HASH not configured");
      return jsonResponse(res, 500, { error: "Server misconfigured" });
    }

    bcrypt.compare(password, ADMIN_PASSWORD_HASH, (err, match) => {
      if (err || !match) {
        console.warn(`[AUTH] Failed login from ${ip}`);
        return jsonResponse(res, 401, { error: "Invalid password" });
      }

      // Reset rate limiter on success
      loginAttempts.delete(ip);

      const token = jwt.sign({ role: "admin", iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, {
        expiresIn: JWT_EXPIRY,
      });

      console.log(`[AUTH] Successful login from ${ip}`);
      jsonResponse(res, 200, { token, expiresIn: JWT_EXPIRY });
    });
  });
}

/**
 * GET /api/booths
 * Requires JWT in Authorization header. Returns booth list.
 */
function handleGetBooths(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse(res, 401, { error: "Authorization required" });
  }

  const token = authHeader.slice(7);
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return jsonResponse(res, 401, { error: "Invalid or expired token" });
  }

  const list = buildBoothList();
  jsonResponse(res, 200, { booths: list });
}

/**
 * GET /api/download/:token
 * Public — no auth. Token itself is the credential.
 * Returns signed R2 URLs (1h expiry) for the session's photo/video.
 */
/**
 * Update a session IN PLACE without resetting its clock.
 *
 * Uses the same conditional metadata writer as confirmation, preserving
 * committed video keys and the original createdAt/expiresAt.
 */
async function patchSession(token, patch) {
  return sessionMetadata.patch(token, patch);
}

/**
 * Look for a session's videos in R2 rather than waiting to be told about
 * them. Since every asset now lives at sessions/<token>/<kind>.<ext>, a
 * lost write-back no longer loses the files — we can just check.
 *
 * Only runs while a session is still expecting videos and has none
 * recorded, and the result is cached onto the session, so the normal case
 * (write-back arrived, or there were never any videos) costs nothing.
 */
async function probeForVideos(token, session) {
  // Coalesce before inspecting the completed-negative cache. A pending or
  // failed probe is never evidence that a video is absent.
  if (videoProbes.has(token)) return videoProbes.get(token);
  const now = Date.now(), graceEnd = session.videoWaitStartedAt + VIDEO_PENDING_GRACE_MS;
  const checkedAt = videoProbeNegatives.get(session);
  if (Number.isFinite(checkedAt) && now - checkedAt < 20_000 &&
      (now < graceEnd || checkedAt >= graceEnd)) return session;

  const controller = new AbortController();
  const deadline = now + VIDEO_PROBE_TIMEOUT_MS;
  const unavailable = () => Object.assign(new Error("Video discovery temporarily unavailable"), { status: 503, videoDiscovery: true });
  const expired = () => Object.assign(new Error("Download session expired"), { status: 410 });
  const check = () => {
    if (Date.now() >= session.expiresAt) throw expired();
    if (controller.signal.aborted || Date.now() >= deadline) throw unavailable();
  };
  const hasMedia = data => !!(data.videoKey || data.layoutVideoKey || data.storyVideoKey);
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(Date.now() >= session.expiresAt ? expired() : unavailable()); controller.abort(); }, VIDEO_PROBE_TIMEOUT_MS);
  });
  const work = async () => {
    // Reconcile other relay/worker commits, not just this request's cache.
    let current = await sessionMetadata.load(token, { fresh: true });
    check();
    if (!current) throw Object.assign(new Error("Download session expired"), { status: 410 });
    if (hasMedia(current) || !current.videosPending) return current;
    const found = {};
    const outcomes = await Promise.allSettled([
      ["videoKey", "video"], ["layoutVideoKey", "layout"], ["storyVideoKey", "story"],
    ].map(async ([field, kind]) => {
      for (const ext of ["mp4", "webm"]) {
        check();
        const key = `sessions/${token}/${kind}.${ext}`;
        try {
          await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }), { abortSignal: controller.signal });
          check(); found[field] = key; return;
        } catch (err) {
          check();
          const status = err?.$metadata?.httpStatusCode;
          // Only a confirmed missing response is a negative observation.
          if (status === 404 || (status == null && ["NoSuchKey", "NotFound"].includes(err?.name))) continue;
          throw err;
        }
      }
    }));
    check();
    if (outcomes.some(result => result.status === "rejected")) throw unavailable();
    if (Object.keys(found).length) {
      current = await patchSession(token, found);
      check();
      return current;
    }
    // A worker may have committed metadata while HEAD requests were running.
    current = await sessionMetadata.load(token, { fresh: true });
    check();
    if (!current) throw Object.assign(new Error("Download session expired"), { status: 410 });
    if (!hasMedia(current)) videoProbeNegatives.set(current, Date.now());
    return current;
  };
  const operation = Promise.race([work(), timedOut])
    .catch(err => { if (err.status === 410) throw err; throw unavailable(); })
    .finally(() => {
      clearTimeout(timer); controller.abort();
      if (videoProbes.get(token) === operation) videoProbes.delete(token);
    });
  videoProbes.set(token, operation);
  return operation;
}

async function handleGetDownload(req, res, token) {
  let session;
  try { session = await loadSession(token); }
  catch (err) {
    if (err.status === 400 || err.status === 403 || err.status === 410) return jsonResponse(res, 404, { error: "Not found or expired" });
    console.error("[DOWNLOAD] Session metadata temporarily unavailable");
    return jsonResponse(res, 503, { error: "Photos are temporarily unavailable. Please try again.", retryable: true });
  }
  if (!session) {
    return jsonResponse(res, 404, { error: "Not found or expired" });
  }
  if (!r2Client) {
    console.error("[DOWNLOAD] R2 not configured");
    return jsonResponse(res, 500, { error: "Storage not configured" });
  }

  try {
    // The write-back that records video keys is a single HTTP call from a
    // browser; when it fails the files are still in R2 (2026-10). Probe
    // for them rather than telling the customer there is no video.
    if (session.videosPending && !session.videoKey && !session.layoutVideoKey && !session.storyVideoKey) {
      session = await probeForVideos(token, session);
    }
    if (session.expiresAt <= Date.now()) return jsonResponse(res, 404, { error: "Not found or expired" });
    session = await sessionMetadata.resolveAuthorized(token, session);
    if (!session) return jsonResponse(res, 404, { error: "Not found or expired" });
    const photoUrl = await signR2Url(session.photoKey);
    const videoUrl = session.videoKey ? await signR2Url(session.videoKey) : null;
    const layoutVideoUrl = session.layoutVideoKey ? await signR2Url(session.layoutVideoKey) : null;
    const storyVideoUrl = session.storyVideoKey ? await signR2Url(session.storyVideoKey) : null;

    // Dedicated DOWNLOAD variants — same objects, but presigned with
    // `attachment` disposition + a friendly filename so the browser
    // saves the file instead of playing it inline. The videoDownloadUrl
    // prefers the polished layout video over the raw session recording,
    // mirroring the download page's button behaviour.
    const ext = (key) => (key.includes(".") ? key.split(".").pop() : "bin");
    const photoDownloadUrl = await signR2Url(
      session.photoKey, `capturism-photo.${ext(session.photoKey)}`);
    const videoDlKey = session.layoutVideoKey || session.videoKey;
    const videoDownloadUrl = videoDlKey
      ? await signR2Url(videoDlKey, `capturism-video.${ext(videoDlKey)}`)
      : null;
    const storyVideoDownloadUrl = session.storyVideoKey
      ? await signR2Url(session.storyVideoKey, `capturism-story.${ext(session.storyVideoKey)}`)
      : null;

    if (session.expiresAt <= Date.now()) return jsonResponse(res, 404, { error: "Not found or expired" });
    jsonResponse(res, 200, {
      photoUrl,
      videoUrl,
      layoutVideoUrl,
      storyVideoUrl,
      photoDownloadUrl,
      videoDownloadUrl,
      storyVideoDownloadUrl,
      // True while the booth is still uploading videos for this session.
      // The page polls on this rather than rendering a photo-only view
      // that only reveals the video if the customer happens to refresh.
      //
      // The age check is what stops the flag becoming a LIE. The booth
      // re-commits the session only when a video upload SUCCEEDS, so a
      // failed upload leaves videosPending set on the record forever —
      // and the download page then shows a spinner that can never resolve.
      // A customer hit exactly that (2026-10-05: "reste à mouliner sans
      // jamais apparaître"), including on a visit the NEXT DAY, long after
      // the upload had died. The booth's upload has no timeout, so if the
      // video is coming at all it lands within a few minutes; past this
      // window it is never coming and the honest answer is a clean
      // photo-only page.
      videoPending:
        !!session.videosPending &&
        !videoUrl &&
        !layoutVideoUrl &&
        Date.now() - session.videoWaitStartedAt < VIDEO_PENDING_GRACE_MS,
      // Past the grace window with nothing to show: this session was
      // PROMISED a video and never got one. Say so. Until now the
      // pending row simply vanished, which a customer reads as the
      // video being taken away from them (2026-10-10, verbatim: "it was
      // like that but now there's no video button").
      videoFailed:
        !!session.videosPending &&
        !videoUrl &&
        !layoutVideoUrl &&
        !storyVideoUrl &&
        Date.now() - session.videoWaitStartedAt >= VIDEO_PENDING_GRACE_MS,
      date: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } catch (err) {
    if (err.status === 403 || err.status === 410) return jsonResponse(res, 404, { error: "Not found or expired" });
    if (err.mediaAuthorization || err.sessionRead) return jsonResponse(res, 503, { error: "Photos are temporarily unavailable. Please try again.", retryable: true });
    if (err.videoDiscovery) return jsonResponse(res, 503, { error: "Your video is temporarily unavailable. Please try again.", retryable: true });
    console.error("[DOWNLOAD] Failed to sign URLs:", err.message);
    jsonResponse(res, 500, { error: "Failed to generate download URLs" });
  }
}

/**
 * GET /api/proxy/:token/(photo|video)
 *
 * Streams the R2-stored asset through the relay so the browser doesn't have
 * to hit R2 directly. Solves the "Stories share fails because R2 CORS isn't
 * configured" problem — the relay is on a domain we control, and we set the
 * CORS header ourselves.
 *
 * The token alone is enough auth (same model as /api/download/:token):
 * possession of the token = right to read the file.
 */
async function handleProxyAsset(req, res, token, kind) {
  let session;
  try { session = await loadSession(token); }
  catch (err) {
    if (err.status === 400 || err.status === 403 || err.status === 410) return jsonResponse(res, 404, { error: "Not found or expired" });
    console.error("[DOWNLOAD] Session metadata temporarily unavailable");
    return jsonResponse(res, 503, { error: "Photos are temporarily unavailable. Please try again.", retryable: true });
  }
  if (!session) {
    return jsonResponse(res, 404, { error: "Not found or expired" });
  }
  if (!r2Client) {
    return jsonResponse(res, 500, { error: "Storage not configured" });
  }

  try {
    session = await sessionMetadata.resolveAuthorized(token, session);
    if (!session) return jsonResponse(res, 404, { error: "Not found or expired" });
    // Select only from the authorized result: a refreshed mapping may have
    // removed the legacy video key that this request initially loaded.
    const key = { photo: session.photoKey, video: session.videoKey,
      layout: session.layoutVideoKey, story: session.storyVideoKey }[kind];
    if (!key) return jsonResponse(res, 404, { error: `No ${kind} in this session` });
    const r = await r2Client.send(new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }));

    if (session.expiresAt <= Date.now()) {
      r.Body?.destroy?.();
      return jsonResponse(res, 404, { error: "Not found or expired" });
    }

    // Forward content-type so the browser knows what kind of file it's
    // receiving. Default to a sensible MIME if R2 didn't return one.
    const isVideoKind = kind !== "photo";
    const contentType = r.ContentType || (isVideoKind ? "video/mp4" : "image/jpeg");

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      ...(r.ContentLength ? { "Content-Length": r.ContentLength } : {}),
    });

    // Stream the bytes through. r.Body is a readable stream in Node 18+.
    r.Body.pipe(res);
    r.Body.on("error", (err) => {
      console.error(`[PROXY] Stream error for ${key}: ${err.message}`);
      try { res.destroy(); } catch {}
    });
  } catch (err) {
    if (err.status === 403 || err.status === 410) return jsonResponse(res, 404, { error: "Not found or expired" });
    if (err.mediaAuthorization || err.sessionRead) return jsonResponse(res, 503, { error: "Photos are temporarily unavailable. Please try again.", retryable: true });
    console.error("[PROXY] Asset temporarily unavailable");
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: "Could not fetch asset" });
    }
  }
}

/**
 * Validate the X-Booth-Auth header. Format: "boothId:key".
 * Returns the boothId on success, or null on failure (response already sent).
 */
function authenticateBooth(req, res) {
  const header = req.headers["x-booth-auth"];
  if (!header || typeof header !== "string") {
    jsonResponse(res, 401, { error: "Missing X-Booth-Auth header" });
    return null;
  }
  const sep = header.indexOf(":");
  if (sep < 0) {
    jsonResponse(res, 401, { error: "Invalid X-Booth-Auth header" });
    return null;
  }
  const boothId = header.slice(0, sep);
  const key = header.slice(sep + 1);
  const expected = BOOTH_API_KEYS.get(boothId);
  if (!expected || expected !== key) {
    jsonResponse(res, 401, { error: "Invalid booth credentials" });
    return null;
  }
  return boothId;
}

/**
 * POST /api/booth/sign-upload
 * Booth-authenticated. Returns a presigned R2 PUT URL the booth uploads to
 * directly. Relay generates the token and key — they're returned so the
 * booth can later commit the session via /api/booth/photos-ready.
 *
 * Body: { contentType: "image/png" | "image/jpeg" | "video/mp4" | "video/webm" }
 * Response: { token, key, uploadUrl, expiresIn }
 */
function handleSignUpload(req, res) {
  const boothId = authenticateBooth(req, res);
  if (!boothId) return;

  if (!r2Client) {
    return jsonResponse(res, 500, { error: "Storage not configured" });
  }

  readBody(req, async (body) => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) return jsonResponse(res, 400, { error: "Expected object" });
    const contentType = data.contentType;
    if (!contentType || !ALLOWED_UPLOAD_CONTENT_TYPES.has(contentType)) {
      return jsonResponse(res, 400, { error: "Unsupported contentType" });
    }

    // Asset keys are DERIVED FROM THE SESSION TOKEN, not from a fresh
    // random one per upload. This is the fix for the 2026-10 incidents:
    // previously every sign-upload minted its own token, so a session's
    // videos lived under 1-3 unrelated random prefixes whose only record
    // was the kiosk browser's memory until the write-back succeeded. When
    // that single HTTP call failed, perfectly good files were orphaned in
    // R2 with no way to find them — two customers lost videos that were
    // sitting in the bucket the whole time, and one took an afternoon of
    // dashboard hunting to locate.
    //
    // Now every asset of a session is at sessions/<token>/<kind>.<ext>, so
    // the relay can simply LOOK for a video instead of being told about
    // it (see probeForVideos in handleGetDownload). The write-back is an
    // optimisation now, not a single point of failure.
    const ext = CONTENT_TYPE_EXT[contentType];
    const kind = typeof data.kind === "string" ? data.kind : null;
    // Whitelist, never interpolate caller input into a key: `kind` and
    // `token` both land in an R2 path.
    const KINDS = { photo: 1, video: 1, layout: 1, story: 1 };
    if (kind && !Object.hasOwn(KINDS, kind)) {
      return jsonResponse(res, 400, { error: "Unsupported kind" });
    }
    const fresh = data.token == null;
    let token = data.token;
    if (token != null) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
        return jsonResponse(res, 400, { error: "Invalid token" });
      }
    } else {
      // No token supplied → this is the first (photo) upload of a session.
      token = crypto.randomBytes(12).toString("base64url");
    }
    const assetKind = kind || (contentType.startsWith("video/") ? "video" : "photo");
    const key = `sessions/${token}/${assetKind}.${ext}`;
    if ((assetKind === "photo") !== contentType.startsWith("image/")) return jsonResponse(res, 400, { error: "Media kind and contentType do not match" });

    try {
      // Persist expiry BEFORE granting an upload capability. Re-signing videos
      // and retrying old tokens must prove their original photo identity.
      // Video keys do not identify the photo; look it up in durable metadata
      // when an older client omits photoKey on its video-signing request.
      let photoKey = assetKind === "photo" ? key : data.photoKey;
      if (!photoKey && !fresh) photoKey = (await sessionMetadata.load(token))?.photoKey;
      if (fresh && assetKind !== "photo") return jsonResponse(res, 400, { error: "Photo upload must start the session" });
      if (!photoKey && !fresh) return jsonResponse(res, 410, { error: "Download session expired or unavailable" });
      await sessionMetadata.issue(token, { boothId, photoKey }, { fresh });
      const cmd = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: contentType,
      });
      const uploadUrl = await getSignedUrl(r2Client, cmd, { expiresIn: SIGNED_UPLOAD_TTL_S });
      console.log(`[BOOTH] Signed upload for ${boothId} → ${key}`);
      jsonResponse(res, 200, { token, key, uploadUrl, expiresIn: SIGNED_UPLOAD_TTL_S });
    } catch (err) {
      console.error(`[BOOTH] sign-upload failed for ${boothId}:`, err.message);
      jsonResponse(res, [400, 403, 409, 410].includes(err.status) ? err.status : 503, { error: "Could not prepare upload. Please try again." });
    }
  });
}

/**
 * POST /api/booth/photos-ready
 * Booth-authenticated. HTTP equivalent of the WS booth:photos_ready message —
 * stores the token → R2 keys mapping and notifies admins.
 *
 * Body: { token, photoKey, videoKey? }
 * Response: { ok, downloadUrl }
 */
function handlePhotosReady(req, res) {
  const boothId = authenticateBooth(req, res);
  if (!boothId) return;

  readBody(req, async (body) => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) return jsonResponse(res, 400, { error: "Expected object" });
    const { token, photoKey, videoKey, layoutVideoKey, storyVideoKey, videosPending } = data;
    if (!token || !photoKey) {
      return jsonResponse(res, 400, { error: "token and photoKey required" });
    }

    let committed;
    try {
      committed = await storeSession(token, { photoKey, videoKey, layoutVideoKey, storyVideoKey, videosPending, boothId });
    } catch (err) {
      // An unknown provider outcome is retryable with the same token. Never
      // acknowledge or broadcast an in-memory-only download session.
      if (res.destroyed || res.writableEnded) return;
      const status = [400,403,409,410].includes(err.status) ? err.status : 503;
      return jsonResponse(res, status, { error: status === 503 ? "Download metadata not confirmed; retry with the same token" : "Download confirmation rejected" });
    }
    console.log(`[BOOTH] Stored session ${token} from ${boothId} (HTTP, videos: ${[videoKey, layoutVideoKey, storyVideoKey].filter(Boolean).length})`);

    broadcastToAdmins({
      type: "booth:photos_ready",
      boothId,
      payload: {
        token,
        photoKey: committed.photoKey,
        videoKey: committed.videoKey || undefined,
        layoutVideoKey: committed.layoutVideoKey || undefined,
        storyVideoKey: committed.storyVideoKey || undefined,
      },
      timestamp: new Date().toISOString(),
    });

    jsonResponse(res, 200, { ok: true, token, downloadUrl: `/d/${token}` });
  });
}

/**
 * POST /api/dev/seed
 * Dev-only: seeds a token → R2 keys mapping for testing without a live booth.
 * Disabled unless DEV_SEED_KEY is set in env. Request must include matching key.
 *
 * Body: { token, photoKey, videoKey?, boothId?, key }
 */
function handleDevSeed(req, res) {
  if (!DEV_SEED_KEY) {
    return jsonResponse(res, 404, { error: "Not found" });
  }

  readBody(req, async (body) => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) return jsonResponse(res, 400, { error: "Expected object" });
    if (data.key !== DEV_SEED_KEY) {
      return jsonResponse(res, 401, { error: "Invalid seed key" });
    }
    if (!data.token || !data.photoKey) {
      return jsonResponse(res, 400, { error: "token and photoKey required" });
    }

    try {
      await storeSession(data.token, { photoKey: data.photoKey, videoKey: data.videoKey, boothId: data.boothId || "dev-seed" });
    } catch (err) {
      return jsonResponse(res, [400,403,409,410].includes(err.status) ? err.status : 503, { error: "Seed metadata not confirmed" });
    }
    console.log(`[DEV] Seeded session ${data.token} → ${data.photoKey}`);

    jsonResponse(res, 200, {
      ok: true,
      token: data.token,
      downloadUrl: `/d/${data.token}`,
    });
  });
}

/**
 * POST /api/subscribe
 * Public — called from the download page when a customer submits the email
 * popup. Stores the record in R2 under subscriptions/<id>.json so admins can
 * later export per-booth lists. The token is the customer's download token;
 * we look up the booth from it so we can tag the city.
 *
 * Body: { email, token, subscribeEvents? }
 */
function handleSubscribe(req, res) {
  readBody(req, async (body) => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    const token = typeof data.token === "string" ? data.token : "";
    const subscribeEvents = data.subscribeEvents !== false; // default true

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jsonResponse(res, 400, { error: "Invalid email" });
    }
    if (!r2Client) {
      console.error("[SUBSCRIBE] R2 not configured");
      return jsonResponse(res, 500, { error: "Storage not configured" });
    }

    // Resolve the booth from the session token. If the token's session is
    // gone (expired / never existed) we still record the email but tag it
    // as "unknown booth" so we never lose customer data.
    let boothId = "unknown";
    if (token) {
      let session;
      try { session = await loadSession(token); }
      catch { return jsonResponse(res, 503, { error: "Session temporarily unavailable. Please try again.", retryable: true }); }
      if (session && session.boothId) boothId = session.boothId;
    }
    const city = BOOTH_CITIES.get(boothId) || boothId;

    const record = {
      id: crypto.randomBytes(8).toString("hex"),
      email,
      subscribeEvents,
      boothId,
      city,
      createdAt: new Date().toISOString(),
    };

    try {
      await r2Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: `subscriptions/${record.id}.json`,
        Body: JSON.stringify(record),
        ContentType: "application/json",
      }));
      console.log(`[SUBSCRIBE] ${email} (booth=${boothId})`);
      // Marketing + review pipeline: Klaviyo push now, review email at
      // T+60h. Fire-and-forget — never blocks or fails the customer flow.
      reviewPipeline.onEmailCaptured(record);
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      console.error(`[SUBSCRIBE] R2 write failed: ${err.message}`);
      jsonResponse(res, 500, { error: "Could not save subscription" });
    }
  });
}

/**
 * GET /api/admin/subscriptions.xlsx?boothId=<optional>
 * Admin JWT-protected. Lists every subscription record in R2, optionally
 * filtered to one booth, and returns an XLSX file with columns:
 *   Date | Time | City | Email | Subscribe Events
 */
async function handleSubscriptionsXlsx(req, res, query) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse(res, 401, { error: "Authorization required" });
  }
  try {
    jwt.verify(authHeader.slice(7), JWT_SECRET);
  } catch {
    return jsonResponse(res, 401, { error: "Invalid or expired token" });
  }
  if (!r2Client) {
    return jsonResponse(res, 500, { error: "Storage not configured" });
  }

  const filterBoothId = query.boothId || null;

  try {
    // List all subscription objects. R2 returns max 1000 per call — we
    // paginate via ContinuationToken so larger lists still work.
    const records = [];
    let continuationToken;
    do {
      const out = await r2Client.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: "subscriptions/",
        ContinuationToken: continuationToken,
      }));
      for (const obj of out.Contents || []) {
        try {
          const r = await r2Client.send(new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: obj.Key,
          }));
          const chunks = [];
          for await (const chunk of r.Body) chunks.push(chunk);
          const rec = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (filterBoothId && rec.boothId !== filterBoothId) continue;
          records.push(rec);
        } catch (err) {
          console.warn(`[SUBSCRIBE] Skipping ${obj.Key}: ${err.message}`);
        }
      }
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);

    // Sort newest first.
    records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    // Build sheet rows. Date/time in Europe/Paris so the admin sees local
    // wall-clock times when they open the file in Excel.
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const rows = records.map((r) => {
      const parts = fmt.formatToParts(new Date(r.createdAt))
        .reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
      return {
        Date: `${parts.year}-${parts.month}-${parts.day}`,
        Time: `${parts.hour}:${parts.minute}:${parts.second}`,
        City: r.city || r.boothId,
        Email: r.email,
        "Subscribed to events": r.subscribeEvents ? "Yes" : "No",
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows, {
      header: ["Date", "Time", "City", "Email", "Subscribed to events"],
    });
    // Sensible column widths so the file looks right when opened.
    ws["!cols"] = [
      { wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 32 }, { wch: 20 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Subscribers");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filenameBooth = filterBoothId ? `-${filterBoothId}` : "";
    const filenameDate = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="capturism-subscribers${filenameBooth}-${filenameDate}.xlsx"`,
      "Content-Length": buf.length,
      "Access-Control-Allow-Origin": CORS_ORIGIN,
    });
    res.end(buf);
  } catch (err) {
    console.error(`[SUBSCRIBE] xlsx export failed: ${err.message}`);
    jsonResponse(res, 500, { error: "Export failed" });
  }
}

// ---------------------------------------------------------------------------
// WebSocket Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

// Handle HTTP upgrade to WebSocket on /ws path
server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const { type, key, boothId, token } = parsed.query;

  // Booth authentication
  if (type === "booth") {
    if (!boothId || !key) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      console.warn("[WS] Booth connection rejected: missing boothId or key");
      return;
    }
    const expectedKey = BOOTH_API_KEYS.get(boothId);
    if (!expectedKey || expectedKey !== key) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      console.warn(`[WS] Booth connection rejected: invalid key for ${boothId}`);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { type: "booth", boothId });
    });
    return;
  }

  // Admin authentication
  if (type === "admin") {
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      console.warn("[WS] Admin connection rejected: missing token");
      return;
    }
    try {
      jwt.verify(token, JWT_SECRET);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      console.warn("[WS] Admin connection rejected: invalid token");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { type: "admin" });
    });
    return;
  }

  // Unknown type
  socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
  socket.destroy();
});

// Handle new WebSocket connections
wss.on("connection", (ws, req, meta) => {
  if (meta.type === "booth") {
    handleBoothConnection(ws, meta.boothId);
  } else if (meta.type === "admin") {
    handleAdminConnection(ws);
  }
});

// ---------------------------------------------------------------------------
// Booth Connection
// ---------------------------------------------------------------------------

function handleBoothConnection(ws, boothId) {
  console.log(`[BOOTH] Connected: ${boothId}`);

  // Register booth
  booths.set(boothId, { ws, boothId, lastSeen: Date.now() });

  // If we'd alerted that this booth went offline, tell the operator it's back.
  if (offlineAlerted.has(boothId)) {
    offlineAlerted.delete(boothId);
    dispatchAlert({
      boothId,
      code: "booth_recovered",
      severity: "info",
      message: "Booth is back online.",
    });
  }

  // Send the current pricing config to the booth right after connect so
  // the kiosk overrides its built-in defaults with whatever the admin
  // has configured. The booth's WS reducer listens for admin:pricing_updated.
  try {
    ws.send(JSON.stringify({
      type: "admin:pricing_updated",
      payload: { pricing: pricingConfig },
      timestamp: new Date().toISOString(),
    }));
  } catch (err) {
    console.warn(`[BOOTH] failed to send initial pricing to ${boothId}: ${err.message}`);
  }

  // Notify all admins. We stamp `boothId` at the top level (in addition to
  // payload) because the admin's reducer keys off `msg.boothId`.
  broadcastToAdmins({
    type: "relay:booth_connected",
    boothId,
    payload: { boothId },
    timestamp: new Date().toISOString(),
  });

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn(`[BOOTH] Invalid JSON from ${boothId}`);
      return;
    }

    // Update last seen on any message
    const booth = booths.get(boothId);
    if (booth) booth.lastSeen = Date.now();

    // Stamp boothId onto message
    msg.boothId = boothId;
    if (!msg.timestamp) msg.timestamp = new Date().toISOString();

    // booth:photos_ready — store token → R2 keys, then forward to admins
    if (msg.type === "booth:photos_ready") {
      const { token, photoKey, videoKey } = msg.payload || {};
      if (!token || !photoKey) {
        console.warn(`[BOOTH] photos_ready missing token/photoKey from ${boothId}`);
        return;
      }
      // Match HTTP confirmation: notify only after durable metadata success.
      try {
        const committed = await storeSession(token, { photoKey, videoKey, layoutVideoKey: msg.payload.layoutVideoKey, storyVideoKey: msg.payload.storyVideoKey, videosPending: msg.payload.videosPending, boothId });
        broadcastToAdmins({ ...msg, payload: { ...msg.payload, photoKey: committed.photoKey, videoKey: committed.videoKey, layoutVideoKey: committed.layoutVideoKey, storyVideoKey: committed.storyVideoKey } });
      } catch { console.error("[BOOTH] download metadata not confirmed; notification withheld"); }
      return;
    }

    // Persist session_complete events for admin dashboard hydration on
    // refresh / redeploy. Dedup by transactionId. Only broadcast if it's
    // a fresh event so duplicate booth-side sends don't double-count
    // anywhere downstream.
    if (msg.type === "booth:session_complete") {
      const payload = msg.payload || {};
      const added = await storeSessionEvent({
        boothId,
        amount: Number(payload.amount) || 0,
        category: payload.category || null,
        // cardType / cardHash are forwarded as-is so the Store Report
        // page can render the same per-transaction breakdown the live
        // WebSocket events provide.
        cardType: payload.cardType || "eu_debit",
        cardHash: payload.cardHash || "",
        transactionId: payload.transactionId || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: msg.timestamp,
        // A session given away (admin code, loyalty): kept as a session but
        // never counted as revenue. `amount` stays the would-have-paid price.
        ...(normalizeCompReason(payload.compReason) ? { compReason: normalizeCompReason(payload.compReason) } : {}),
      });
      if (added) broadcastToAdmins(msg);
      return;
    }

    // booth:error — a failure the booth wants the operator to know about.
    // Normalize into an alert (live to admins + throttled email).
    if (msg.type === "booth:error") {
      const p = msg.payload || {};
      dispatchAlert({
        boothId,
        code: p.code,
        severity: p.severity || "warning",
        message: p.message,
        context: p.context,
      });
      return;
    }

    // Forward other booth status messages to all admins. A heartbeat carries
    // the printer's media levels ({ ribbon, paper }) when the booth has them;
    // remember the last one so buildBoothList() can show them on a fresh
    // admin page load. Taken from a status message too, if one ever carries it.
    if (msg.type === "booth:status" || msg.type === "booth:heartbeat") {
      const media = msg.payload && msg.payload.media;
      if (media && typeof media === "object") boothMedia.set(boothId, media);
      broadcastToAdmins(msg);
    } else {
      console.warn(`[BOOTH] Unknown message type from ${boothId}: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    console.log(`[BOOTH] Disconnected: ${boothId}`);
    booths.delete(boothId);

    broadcastToAdmins({
      type: "relay:booth_disconnected",
      boothId,
      payload: { boothId },
      timestamp: new Date().toISOString(),
    });
  });

  ws.on("error", (err) => {
    console.error(`[BOOTH] Error from ${boothId}:`, err.message);
  });
}

// ---------------------------------------------------------------------------
// Admin Connection
// ---------------------------------------------------------------------------

function handleAdminConnection(ws) {
  console.log("[ADMIN] Connected");
  admins.add(ws);

  // Send current booth list on connect. The admin reducer reads
  // `msg.payload.booths`, so wrap the array.
  sendToClient(ws, {
    type: "relay:booth_list",
    payload: { booths: buildBoothList() },
    timestamp: new Date().toISOString(),
  });

  // Hydrate the Store Report page's transaction list with everything
  // we have on disk. The admin only listens to live booth:session_complete
  // events otherwise, so on a fresh page load its `transactions` state is
  // empty and the per-booth Report shows zeros even though the dashboard
  // cards (driven by booth.stats) are correct. Shape each historical
  // event so the admin can drop it straight into its transactions
  // reducer without special-casing the source.
  sendToClient(ws, {
    type: "relay:transactions_history",
    payload: {
      transactions: sessionEvents.map((e) => ({
        id: e.transactionId,
        timestamp: e.timestamp,
        amount: Number(e.amount) || 0,
        category: e.category,
        cardType: e.cardType || "eu_debit",
        cardHash: e.cardHash || "",
        boothId: e.boothId,
        ...(isComp(e) ? { compReason: e.compReason } : {}),
      })),
    },
    timestamp: new Date().toISOString(),
  });

  // Hydrate the alerts panel with recent operational alerts so a freshly
  // opened dashboard isn't blank until the next failure.
  sendToClient(ws, {
    type: "relay:alerts_history",
    payload: { alerts },
    timestamp: new Date().toISOString(),
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn("[ADMIN] Invalid JSON");
      return;
    }

    if (!msg.timestamp) msg.timestamp = new Date().toISOString();

    // Only allow whitelisted commands
    if (!ADMIN_COMMAND_WHITELIST.has(msg.type)) {
      console.warn(`[ADMIN] Rejected unknown command: ${msg.type}`);
      sendToClient(ws, {
        type: "relay:error",
        payload: { message: `Unknown command: ${msg.type}` },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Route to specific booth or broadcast to all booths
    const targetBoothId = msg.boothId;

    if (targetBoothId) {
      const booth = booths.get(targetBoothId);
      if (booth) {
        sendToClient(booth.ws, msg);
        console.log(`[RELAY] Forwarded ${msg.type} to ${targetBoothId}`);
      } else {
        sendToClient(ws, {
          type: "relay:error",
          payload: { message: `Booth not connected: ${targetBoothId}` },
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      // Broadcast to all booths
      booths.forEach((booth) => {
        sendToClient(booth.ws, msg);
      });
      console.log(`[RELAY] Broadcast ${msg.type} to all booths`);
    }
  });

  ws.on("close", () => {
    console.log("[ADMIN] Disconnected");
    admins.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("[ADMIN] Error:", err.message);
  });
}

// ---------------------------------------------------------------------------
// Heartbeat Monitor
// ---------------------------------------------------------------------------

// Check every 30s if any booth has gone silent for > 90s
setInterval(() => {
  const now = Date.now();
  booths.forEach((booth, boothId) => {
    if (now - booth.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      console.warn(`[HEARTBEAT] Booth ${boothId} timed out (no heartbeat in ${HEARTBEAT_TIMEOUT_MS / 1000}s)`);

      // Close the stale connection
      booth.ws.terminate();
      booths.delete(boothId);

      broadcastToAdmins({
        type: "relay:booth_disconnected",
        boothId,
        payload: { boothId },
        timestamp: new Date().toISOString(),
      });

      // The socket stayed open but heartbeats stopped — the kiosk screen or PC
      // has likely frozen/crashed. Alert once per offline episode. (A clean
      // nightly shutdown closes the socket instead, hitting the close handler,
      // so this won't false-fire when the PC is simply switched off.)
      if (!offlineAlerted.has(boothId)) {
        offlineAlerted.add(boothId);
        dispatchAlert({
          boothId,
          code: "booth_offline",
          severity: "critical",
          message: "Booth stopped responding (no heartbeat for 90s) — the screen or PC may have frozen.",
        });
      }
    }
  });
}, 30_000);

// Periodically clean up rate limit entries
setInterval(() => {
  const now = Date.now();
  loginAttempts.forEach((limiter, ip) => {
    if (now >= limiter.resetAt) loginAttempts.delete(ip);
  });
}, 60_000);

// Periodically clean up expired download sessions (hourly)
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  sessions.forEach((session, token) => {
    if (now >= session.expiresAt) {
      sessions.delete(token);
      removed++;
    }
  });
  if (removed > 0) console.log(`[CLEANUP] Removed ${removed} expired sessions`);
}, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Persist before acknowledging/caching. Replays preserve media and clocks. */
async function storeSession(token, input) {
  return sessionMetadata.save(token, input);
}

/** Load only committed metadata; failed writes never populate this cache. */
async function loadSession(token) {
  return sessionMetadata.load(token);
}

/**
 * Presign an R2 GET. When `downloadName` is provided, the URL carries a
 * `response-content-disposition: attachment` override — that's what makes
 * a browser SAVE the file instead of navigating to it and playing it
 * inline. Without it, tapping "Download the Video" on a phone just opened
 * a fullscreen player with no obvious way to save (operator report,
 * 2026-07-05). Display URLs (page background, <img>) keep the plain
 * variant so media elements stream normally.
 */
async function signR2Url(key, downloadName) {
  const cmd = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ...(downloadName
      ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` }
      : {}),
  });
  return getSignedUrl(r2Client, cmd, { expiresIn: SIGNED_URL_TTL_S });
}

function broadcastToAdmins(msg) {
  const payload = JSON.stringify(msg);
  admins.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  });
}

// ─── Alert dispatch ──────────────────────────────────────────────────────

function currentHourInZone(tz) {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date()),
  );
}

/**
 * Record an operational alert: keep it in the ring buffer, push it live to
 * every admin dashboard, and email the operator (throttled per code). Used by
 * the booth:error handler and the offline watchdog.
 */
function dispatchAlert({ boothId, code, severity = "warning", message, context }) {
  const alert = {
    id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    boothId: boothId || "booth-mabillon",
    code: code || "unknown",
    severity,
    message: message || code || "unknown alert",
    context: context || null,
    timestamp: new Date().toISOString(),
  };
  alerts.push(alert);
  if (alerts.length > ALERT_MAX) alerts.splice(0, alerts.length - ALERT_MAX);

  broadcastToAdmins({ type: "relay:alert", payload: alert, boothId: alert.boothId, timestamp: alert.timestamp });
  console.warn(`[ALERT] ${String(severity).toUpperCase()} ${alert.code} (${alert.boothId}): ${alert.message}`);
  void maybeEmailAlert(alert);
  return alert;
}

async function maybeEmailAlert(alert) {
  if (!RESEND_API_KEY || !ALERT_EMAIL || !ALERT_FROM) return; // not configured
  // Info-level alerts (e.g. "back online" recoveries) show on the admin panel
  // only — they're reassuring, not actionable, so we don't email them.
  if (alert.severity === "info") return;
  const now = Date.now();
  const last = alertEmailThrottle.get(alert.code) || 0;
  if (now - last < ALERT_EMAIL_THROTTLE_MS) return; // already emailed this code recently
  // Suppress the noisy "offline" ping outside operating hours (the PC may be
  // switched off on purpose at night). Everything else emails any time.
  if (alert.code === "booth_offline") {
    const h = currentHourInZone(DAILY_REPORT_TIMEZONE);
    if (h < ALERT_HOURS_START || h >= ALERT_HOURS_END) return;
  }
  alertEmailThrottle.set(alert.code, now);
  const label = ALERT_SUBJECTS[alert.code] || alert.code;
  const subject = `Capturism ⚠ ${label} · ${alert.boothId}`;
  const text = [
    label,
    "",
    `Booth:   ${alert.boothId}`,
    `When:    ${alert.timestamp}`,
    `Detail:  ${alert.message}`,
    alert.context ? `Context: ${JSON.stringify(alert.context)}` : "",
    "",
    "— automated by capturism-relay",
  ].filter(Boolean).join("\n");
  await sendViaResend({ apiKey: RESEND_API_KEY, from: ALERT_FROM, to: ALERT_EMAIL, subject, text });
}

function sendToClient(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function buildBoothList() {
  // Include all registered booth IDs (from env), marking online/offline
  // and including accumulated stats from sessionEvents so admin refreshes
  // and Render redeploys do not reset the dashboard to zero.
  // `media` is whatever the booth last reported on a heartbeat, and is
  // simply absent for a booth that has never sent any — the admin card
  // renders nothing in that case.
  const list = [];
  BOOTH_API_KEYS.forEach((_, boothId) => {
    const booth = booths.get(boothId);
    const media = boothMedia.get(boothId);
    list.push({
      boothId,
      online: !!booth,
      lastSeen: booth ? new Date(booth.lastSeen).toISOString() : null,
      stats: buildBoothStats(boothId),
      ...(media ? { media } : {}),
    });
  });
  return list;
}

/* ── Stats storage ──────────────────────────────────────────────────
 * On startup, loadSessionStats() pulls the persisted event log from
 * R2 into the in-memory sessionEvents array. Every booth:session_complete
 * appends to that array (dedup by transactionId) and rewrites the R2
 * blob fire-and-forget. buildBoothStats(boothId) computes the rolling
 * totals the admin dashboard expects.
 *
 * Time buckets are computed in Europe/Paris (the booth's local timezone)
 * so "today" / "this week" / "this month" match what the user thinks of
 * as "the current day" rather than UTC. Week starts Monday (EU convention).
 * Real-time events arriving via WS still hit the admin's per-event
 * handler — but those are by definition "now", so adding them to all
 * four buckets is correct without any further per-event bucketing.
 * ───────────────────────────────────────────────────────────────── */

const EMPTY_DETAILED = {
  photoColor: 0, photoImage: 0, photoCity: 0,
  calendarColor: 0, calendarImage: 0, calendarCity: 0,
  postcardColor: 0, postcardImage: 0, postcardCity: 0,
  idPhoto: 0,
  // THEOS artist collab, split by print size.
  theos4x6: 0, theos6x9: 0,
  // Lost Connection session mode.
  lostConnection: 0,
};

/**
 * Returns { day, week, month } UTC-ms thresholds. An event with
 * timestamp >= threshold belongs to that bucket.
 * "Today" = midnight Europe/Paris of the current Paris date.
 * "This week" = midnight Europe/Paris of the most recent Monday.
 * "This month" = midnight Europe/Paris of the 1st of the current Paris month.
 */
function bucketThresholds() {
  const now = new Date();
  // Get current Paris Y/M/D and the weekday (0=Sun..6=Sat) in Paris.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = Number(get("year"));
  const monthIdx = Number(get("month")) - 1;
  const day = Number(get("day"));
  const weekdayName = get("weekday"); // "Mon", "Tue", ...
  const wkMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wkMap[weekdayName] ?? 1;
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;

  // Convert a (Y, M, D) Paris-local midnight into UTC ms.
  // Paris is UTC+1 in winter, UTC+2 in summer (DST). We compute the offset
  // by formatting the target instant in Paris and reading hours back.
  function parisMidnightToUtcMs(y, m, d) {
    // Start by guessing midnight is at 00:00 UTC, then correct for the
    // Paris offset on that date. Two iterations are enough to settle
    // across the DST boundary.
    let guess = Date.UTC(y, m, d, 0, 0, 0);
    for (let i = 0; i < 2; i++) {
      const partsAtGuess = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Paris",
        hour: "2-digit",
        hour12: false,
      }).formatToParts(new Date(guess));
      const parisHour = Number(partsAtGuess.find((p) => p.type === "hour")?.value || 0);
      // parisHour is the Paris hour when UTC is `guess`. If parisHour=2,
      // Paris is 2 hours ahead, so midnight Paris is 2 hours earlier in UTC.
      const adjusted = parisHour === 24 ? 0 : parisHour;
      guess -= adjusted * 3600_000;
    }
    return guess;
  }

  const dayMs = parisMidnightToUtcMs(year, monthIdx, day);
  const weekMs = dayMs - daysSinceMonday * 86_400_000;
  const monthMs = parisMidnightToUtcMs(year, monthIdx, 1);
  return { day: dayMs, week: weekMs, month: monthMs };
}

function buildBoothStats(boothId) {
  return rollupRevenue(sessionEvents, boothId, bucketThresholds(), EMPTY_DETAILED);
}

async function loadSessionStats() {
  if (!r2Client) {
    console.log("[STATS] R2 not configured — stats will only survive within a single process lifetime");
    return;
  }
  try {
    const r = await r2Client.send(new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: STATS_R2_KEY,
    }));
    const chunks = [];
    for await (const chunk of r.Body) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (Array.isArray(parsed)) {
      sessionEvents = parsed;
      console.log(`[STATS] Loaded ${sessionEvents.length} session events from R2`);
    }
  } catch (err) {
    if (err.name === "NoSuchKey" || err.Code === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      console.log("[STATS] No existing stats file in R2 — starting fresh");
    } else {
      console.error("[STATS] Failed to load from R2:", err.message);
    }
  }
}

/**
 * Load pricing config from R2. Falls back to baked-in defaults if no
 * file exists or R2 isn't configured. Logs the resolved pricing so the
 * operator can see what value the kiosk will receive.
 */
async function loadPricingConfig() {
  if (!r2Client) {
    console.log("[PRICING] R2 not configured — using built-in defaults");
    return;
  }
  try {
    const r = await r2Client.send(new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: PRICING_R2_KEY,
    }));
    const chunks = [];
    for await (const chunk of r.Body) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    Object.assign(pricingConfig, sanitizePricing(parsed));
    console.log(`[PRICING] Loaded from R2:`, pricingConfig);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.Code === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      console.log("[PRICING] No pricing file in R2 — using defaults:", pricingConfig);
    } else {
      console.error("[PRICING] Load failed:", err.message);
    }
  }
}

/**
 * Validate + clamp a posted pricing object. Drops unknown keys, requires
 * each numeric field to be a finite non-negative number; missing fields
 * keep their current value.
 */
function sanitizePricing(input) {
  const out = { ...pricingConfig };
  if (!input || typeof input !== "object") return out;
  for (const k of Object.keys(pricingConfig)) {
    const v = input[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/**
 * Persist current pricingConfig to R2 (best-effort) and broadcast the
 * update to all connected booths so they switch over without a restart.
 */
async function persistAndBroadcastPricing() {
  if (r2Client) {
    try {
      await r2Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: PRICING_R2_KEY,
        Body: JSON.stringify(pricingConfig, null, 2),
        ContentType: "application/json",
      }));
      console.log("[PRICING] Persisted to R2");
    } catch (err) {
      console.error("[PRICING] R2 persist failed:", err.message);
    }
  }
  const message = JSON.stringify({
    type: "admin:pricing_updated",
    payload: { pricing: pricingConfig },
    timestamp: new Date().toISOString(),
  });
  let sent = 0;
  for (const { ws } of booths.values()) {
    if (ws.readyState === ws.OPEN) { ws.send(message); sent++; }
  }
  console.log(`[PRICING] Broadcast to ${sent} booth(s)`);
}

/**
 * Append a session-complete event to the log. Returns true if added,
 * false if the transactionId was already present (duplicate from a
 * StrictMode-fired booth re-send, etc).
 */
async function storeSessionEvent(event) {
  if (event.transactionId && sessionEvents.some((e) => e.transactionId === event.transactionId)) {
    console.log(`[STATS] Skipping duplicate session ${event.transactionId}`);
    return false;
  }
  sessionEvents.push(event);
  if (r2Client) {
    // Fire-and-forget — admin gets the broadcast immediately; persistence
    // catches up asynchronously and a momentary lag won't lose anything
    // because the in-memory array is already updated.
    r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: STATS_R2_KEY,
      Body: JSON.stringify(sessionEvents),
      ContentType: "application/json",
    })).catch((err) => console.error("[STATS] R2 persist failed:", err.message));
  }
  return true;
}

function readBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => callback(body));
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Authenticated, throttled pool bodies may take up to twenty minutes.
server.requestTimeout = 21 * 60_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[RELAY] Capturism relay server running on 0.0.0.0:${PORT}`);
  console.log(`[RELAY] Registered booths: ${[...BOOTH_API_KEYS.keys()].join(", ") || "none"}`);
  console.log(`[RELAY] WebSocket path: /ws`);
  console.log(`[RELAY] Health check: GET /api/health`);
  console.log(`[RELAY] R2 storage: ${r2Configured ? `configured (bucket: ${R2_BUCKET})` : "NOT configured"}`);
  console.log(`[RELAY] Dev seed endpoint: ${DEV_SEED_KEY ? "enabled" : "disabled"}`);
  console.log(`[RELAY] Daily report: ${DAILY_REPORT_CONFIGURED ? `enabled — ${DAILY_REPORT_HOUR}:${String(DAILY_REPORT_MINUTE).padStart(2, "0")} ${DAILY_REPORT_TIMEZONE} → ${DAILY_REPORT_EMAIL}` : "DISABLED (set RESEND_API_KEY)"}`);
  // Hydrate the admin-stats event log from R2 so refreshes / redeploys
  // don't reset the dashboard to zero.
  loadSessionStats();
  // Hydrate pricing config from R2 so kiosks get the admin-configured
  // prices (not defaults) the moment they connect.
  loadPricingConfig();
  // Kick off the daily-report scheduler.
  startDailyReportScheduler();
  // Klaviyo push + T+60h review-request pipeline (no-ops without env keys).
  reviewPipeline.init({ client: r2Client, bucket: R2_BUCKET, resendApiKey: RESEND_API_KEY });
  // l'INCONNU pool — hydrates pool/ records from R2.
  pool.init({ client: r2Client, bucket: R2_BUCKET, jsonResponse, readBody });
  // l'INCONNU phone quiz — codes, submissions, expiry sweeping.
  quiz.init({ client: r2Client, bucket: R2_BUCKET, jsonResponse, readBody });
  // Weekly pool snapshots (backups/pool/<date>/, 28-day retention).
  backup.init({ client: r2Client, bucket: R2_BUCKET });
});

// ─── Daily report scheduler ────────────────────────────────────────────────
//
// Once-per-minute check: "Is it currently <DAILY_REPORT_HOUR>:<MINUTE>
// in <TIMEZONE>, and have we NOT yet sent a report for today?" Simple,
// robust, no cron dep. Survives Render Starter-tier auto-restarts via
// the in-memory `lastReportDate` flag — worst case after a restart at
// 23:45 we send a duplicate, which is an inconvenience not a bug.
//
// Render free tier sleeps the dyno after 15 min idle; if no traffic
// arrives near the scheduled hour, the timer never fires. Upgrading to
// Render Starter ($7/mo) makes this reliable.
let lastReportDate = null;

function isoDateInZone(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function maybeSendDailyReport() {
  if (!DAILY_REPORT_CONFIGURED) return;
  const now = new Date();
  const partsFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: DAILY_REPORT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [hStr, mStr] = partsFmt.format(now).split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (h !== DAILY_REPORT_HOUR || m !== DAILY_REPORT_MINUTE) return;
  const todayISO = isoDateInZone(now, DAILY_REPORT_TIMEZONE);
  if (lastReportDate === todayISO) return; // already sent
  lastReportDate = todayISO;
  console.log(`[daily-report] sending report for ${todayISO}…`);
  // We only have one booth (booth-mabillon) for now. For multi-booth
  // setups, this would iterate over each booth and send one email per.
  const boothId = [...BOOTH_API_KEYS.keys()][0] || "booth-mabillon";
  const city = BOOTH_CITIES.get(boothId);
  try {
    await buildAndSendDailyReport({
      events: sessionEvents,
      boothId,
      city,
      dayISO: todayISO,
      timezone: DAILY_REPORT_TIMEZONE,
      apiKey: RESEND_API_KEY,
      from: DAILY_REPORT_FROM,
      to: DAILY_REPORT_EMAIL,
    });
  } catch (err) {
    console.error(`[daily-report] send threw: ${err.message}`);
  }
}

// Global error handlers route through Sentry when configured. Logs in
// either case so Render's log viewer still shows the failure.
process.on("unhandledRejection", (reason) => {
  console.error("[RELAY] UNHANDLED REJECTION:", reason);
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});
process.on("uncaughtException", (err) => {
  console.error("[RELAY] UNCAUGHT EXCEPTION:", err);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
});

function startDailyReportScheduler() {
  if (!DAILY_REPORT_CONFIGURED) {
    console.log("[daily-report] scheduler NOT started — RESEND_API_KEY missing.");
    return;
  }
  // Check every minute — light enough to ignore.
  setInterval(() => { void maybeSendDailyReport(); }, 60_000);
}
