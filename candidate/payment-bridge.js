#!/usr/bin/env node
/**
 * CAPTURISM Payment Bridge Service
 *
 * Lightweight Node.js HTTP server that bridges the web SPA with the
 * Ingenico SELF/2000 payment terminal.
 *
 * Modes:
 *   PAYMENT_MODE=mock    → simulated transactions (default)
 *   PAYMENT_MODE=telium  → real Ingenico terminal via Telium protocol
 *
 * Usage:
 *   node payment-bridge.js
 *   PAYMENT_MODE=telium TERMINAL_IP=192.168.1.50 node payment-bridge.js
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket: WsClient } = require('ws');
// Durable video delivery. Lives in its own module to keep this file's
// three-device scope intact — it is still ONE bridge process and one
// console window, so the .bat files and the operator's mental model of
// "two bridge windows" are unchanged.
const videoQueue = require('./video-queue');
const { isPortListening } = require('./probe-port');

const { createDiagnostics, receiveDiagnostics } = require('./diagnostics.cjs');
const diagnostics = createDiagnostics();
const PORT = process.env.BRIDGE_PORT || 3001;
const MODE = process.env.PAYMENT_MODE || 'mock';
const TERMINAL_IP = process.env.TERMINAL_IP || '192.168.1.50';
const TERMINAL_PORT = parseInt(process.env.TERMINAL_PORT || '8000', 10);

// ─── Printer config ───────────────────────────────────────────────────────────
// PRINT_MOCK=1     → don't actually print, just log (useful while testing UI)
// PRINTER_NAME=... → CUPS printer name (run `lpstat -p` to list installed ones)
// On macOS / Linux we shell out to `lp` (CUPS). For DNP DS620 the user adds
// the printer via System Settings (macOS) or system-config-printer (Linux),
// then sets PRINTER_NAME to whatever name the OS assigned.

const PRINT_MOCK = process.env.PRINT_MOCK === '1' || process.env.PRINT_MOCK === 'true';
const PRINTER_NAME = process.env.PRINTER_NAME || 'DS620';
// Optional second printer queue for 6×9 prints. On Windows, mspaint /pt
// can't override page size per job — it uses the printer's saved
// default in Preferences. To produce both 4×6 and 6×9 prints from the
// same physical DS620 (loaded with a 6×9 ribbon, which can cut both),
// the operator installs the DS620 driver TWICE in Windows under two
// names — one with 4×6 default (= PRINTER_NAME), one with 6×9 default
// (= PRINTER_NAME_6X9). The bridge routes each print job to whichever
// queue matches the sizeMode the kiosk requested. When unset, 6×9
// prints fall back to PRINTER_NAME and the driver uses whatever
// default size is configured there.
const PRINTER_NAME_6X9 = process.env.PRINTER_NAME_6X9 || PRINTER_NAME;
// Third optional queue for 3.5×6 prints (the new Photo ID visa sheets for
// 51×51 / 40×60 / 33×48). Same idea as PRINTER_NAME_6X9: a Windows DS620
// instance whose default cut is 3.5×6, fed from the same 6-inch roll.
// When unset, 3.5×6 jobs fall back to PRINTER_NAME.
const PRINTER_NAME_3_5X6 = process.env.PRINTER_NAME_3_5X6 || PRINTER_NAME;
// Media size names per CUPS PPD. DNP's macOS PPD uses "w288h432" style names
// (points, where 1in = 72pt → 4×6=288×432, 6×9=432×648, 3.5×6=252×432). If a
// user has a different PPD, override via PRINTER_MEDIA_4X6 / _6X9 / _3_5X6.
const PRINTER_MEDIA_4X6 = process.env.PRINTER_MEDIA_4X6 || 'w288h432';
const PRINTER_MEDIA_6X9 = process.env.PRINTER_MEDIA_6X9 || 'w432h648';
const PRINTER_MEDIA_3_5X6 = process.env.PRINTER_MEDIA_3_5X6 || 'w252h432';

// ─── Print backend selector ─────────────────────────────────────────────────
//
// Three ways to talk to the DS620:
//
//   PRINT_BACKEND=hotfolder  → drop the PNG into a DNP HotFolderPrint
//                               watched folder; HFP issues the cut via DNP's
//                               SDK and supports sizes the Windows driver
//                               doesn't expose (notably 3.5×6).  RECOMMENDED.
//   PRINT_BACKEND=windows    → PowerShell + System.Drawing.Printing.  Only
//                               supports cuts the Windows driver lists in
//                               its dropdown (no 3.5×6).  Default on win32.
//   PRINT_BACKEND=cups       → `lp` via CUPS.  Default on macOS / Linux.
//
// When PRINT_BACKEND is unset, we pick windows on win32 and cups elsewhere
// (the historical behaviour).  Setting it explicitly is what switches the
// booth to hot-folder mode.
const PRINT_BACKEND = (process.env.PRINT_BACKEND || (process.platform === 'win32' ? 'windows' : 'cups')).toLowerCase();

// Hot-folder paths, one per cut size.  Each path is a directory that DNP
// HotFolderPrint (Windows or macOS) is configured to watch with that
// specific cut size pre-selected in its UI.  Drop a PNG into the matching
// folder and HFP picks it up + prints with the correct cut.
//
// Setup on the booth PC (Windows):
//   1. Install DNP HotFolderPrint (free from DNP's site, "HotFolderPrint
//      Utility").  Launch it.
//   2. Add three watched folders, e.g.:
//        C:\HotFolderPrint\4x6     → cut size (4x6)
//        C:\HotFolderPrint\3.5x6   → cut size (3.5x6)
//        C:\HotFolderPrint\6x9     → cut size (6x9)
//      For each folder, set border/finish/etc. in HFP's per-folder config.
//      Keep HFP running (drop a shortcut into shell:startup so it auto-
//      launches with Windows alongside this bridge).
//   3. In start-payment-bridge.bat set PRINT_BACKEND=hotfolder and point
//      the three env vars below at the matching folders.
//
// If a folder isn't configured for a sizeMode the bridge receives, the
// print fails loudly (rather than silently falling back to a wrong cut).
const HOTFOLDER_4X6 = process.env.HOTFOLDER_4X6 || '';
const HOTFOLDER_3_5X6 = process.env.HOTFOLDER_3_5X6 || '';
const HOTFOLDER_6X9 = process.env.HOTFOLDER_6X9 || '';

// ─── Relay proxy config (booth-key in Node, not in browser bundle) ──────────
//
// The kiosk used to embed VITE_BOOTH_KEY directly into its JS bundle and
// call the relay's /api/booth/* endpoints from the browser with
// `X-Booth-Auth: <id>:<key>`. The key was visible in the bundle source and
// in DevTools' Network tab — acceptable on a locked-down kiosk PC but not
// great defense-in-depth.
//
// Now: the kiosk hits LOCAL endpoints (/api/relay/sign-upload,
// /photos-ready, /ws) on this bridge. The bridge holds BOOTH_KEY in Node
// env (never bundled into JS) and adds the auth header / URL key when
// forwarding to the real relay. The browser never sees the key.
//
// Set these three in start-payment-bridge.bat to migrate values from the
// kiosk's old .env.local. If RELAY_URL is unset the proxy returns 503 to
// the kiosk, which then treats cloud upload as "not configured" and skips
// it gracefully.
const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/$/, '');
const BOOTH_ID = process.env.BOOTH_ID || '';
const BOOTH_KEY = process.env.BOOTH_KEY || '';
const RELAY_CONFIGURED = !!(RELAY_URL && BOOTH_ID && BOOTH_KEY);

// ─── Camera (Canon EDSDK direct) config ─────────────────────────────────────
// The kiosk calls POST /api/camera/capture at countdown=0 to fire a real
// DSLR shutter. On Windows we drive the Canon EOS 200D II by spawning a
// dedicated `capture.exe` helper that talks to Canon's EDSDK directly
// (P/Invoke from C#). One-process-per-shot, no HTTP, no GUI.
//
// Why direct EDSDK instead of digiCamControl: see
// ~/.claude/projects/-Users-ACS-Downloads-capturism/memory/
//   camera_digicamcontrol_unusable.md
// for the full saga. TL;DR: digiCamControl's .NET wrapper crashes on
// programmatic captures (NullReferenceException on slc=get/list/set)
// regardless of version. EDSDK itself is solid; we cut out the wrapper.
//
//   EDSDK_CAPTURE_EXE          — Path to capture.exe. Default: ./capture-edsdk/capture.exe
//                                (resolved relative to this file's directory).
//   CAMERA_MOCK=1              — Skip the real camera; the capture endpoint
//                                returns 500 and the kiosk falls back to
//                                its webcam snapshot path.
//   CAMERA_CAPTURE_TIMEOUT_MS  — How long to wait for capture.exe before
//                                killing it and reporting failure. Default 8000.
const CAMERA_MOCK = process.env.CAMERA_MOCK === '1' || process.env.CAMERA_MOCK === 'true';
const CAMERA_CAPTURE_TIMEOUT_MS = parseInt(process.env.CAMERA_CAPTURE_TIMEOUT_MS || '8000', 10);
const EDSDK_CAPTURE_EXE = process.env.EDSDK_CAPTURE_EXE
  || path.join(__dirname, 'capture-edsdk', 'capture.exe');
// capture.exe reads EDSDK_ROTATE_DEG itself (it inherits our env). The
// bridge only reads it here so it can echo the value at startup — that
// way the operator can SEE whether rotation is configured.
const EDSDK_ROTATE_DEG = process.env.EDSDK_ROTATE_DEG || '0';

// Directory we save captured JPEGs into and serve back over HTTP at
// GET /captures/<filename>. Cleaned of stale files on startup (best-effort)
// so we don't accumulate gigabytes across kiosk sessions.
const CAPTURES_DIR = path.join(__dirname, 'captures');
try {
  if (!fs.existsSync(CAPTURES_DIR)) fs.mkdirSync(CAPTURES_DIR, { recursive: true });
} catch (err) {
  console.warn(`[camera] could not create captures dir ${CAPTURES_DIR}: ${err.message}`);
}

// ─── Transaction Store ────────────────────────────────────────────────────────

const transactions = new Map();

function generateTxId() {
  return 'tx_' + crypto.randomBytes(8).toString('hex');
}

// Auto-cleanup transactions older than 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, tx] of transactions) {
    if (tx.created < cutoff) transactions.delete(id);
  }
}, 60 * 1000);

// ─── Mock Driver ──────────────────────────────────────────────────────────────

const MockDriver = {
  initiate(txId, amountCents) {
    transactions.set(txId, {
      status: 'waiting',
      amount: amountCents,
      currency: 'EUR',
      message: 'Waiting for card insertion...',
      created: Date.now()
    });

    // Simulate card insertion after 2s
    setTimeout(() => {
      const tx = transactions.get(txId);
      if (tx && tx.status === 'waiting') {
        tx.status = 'processing';
        tx.message = 'Processing payment...';
      }
    }, 2000);

    // Simulate approval/decline after 4s
    setTimeout(() => {
      const tx = transactions.get(txId);
      if (tx && tx.status === 'processing') {
        const approved = Math.random() < 0.9;
        tx.status = approved ? 'approved' : 'declined';
        tx.message = approved
          ? 'Payment approved'
          : 'Payment declined — insufficient funds';
      }
    }, 4000);
  },

  cancel(txId) {
    const tx = transactions.get(txId);
    if (tx && (tx.status === 'waiting' || tx.status === 'processing')) {
      tx.status = 'cancelled';
      tx.message = 'Transaction cancelled by user';
    }
  }
};

// ─── Telium Driver (Stub) ─────────────────────────────────────────────────────

const TeliumDriver = {
  /**
   * Future implementation: Connects to the Ingenico SELF/2000 via TCP
   * using the Telium protocol (TPDU framing: STX + len + data + ETX + LRC).
   *
   * Steps to implement:
   * 1. Establish TCP connection to TERMINAL_IP:TERMINAL_PORT
   * 2. Send ENQ to initiate session
   * 3. Send transaction request with amount in Telium frame format
   * 4. Poll terminal for status updates
   * 5. Parse response frames for approval/decline codes
   *
   * Requires:
   * - Terminal connected via Ethernet to same network
   * - Payment processor credentials configured on terminal
   * - Telium protocol documentation from Ingenico
   */
  initiate(txId, amountCents) {
    transactions.set(txId, {
      status: 'error',
      amount: amountCents,
      currency: 'EUR',
      message: 'Telium driver not yet implemented. Connect terminal and configure TERMINAL_IP.',
      created: Date.now()
    });
    console.log(`[Telium] Would connect to ${TERMINAL_IP}:${TERMINAL_PORT} for ${amountCents} cents`);
  },

  cancel(txId) {
    const tx = transactions.get(txId);
    if (tx) {
      tx.status = 'cancelled';
      tx.message = 'Transaction cancelled';
    }
  }
};

// ─── Driver Selection ─────────────────────────────────────────────────────────

const driver = MODE === 'telium' ? TeliumDriver : MockDriver;

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ─── Printer ──────────────────────────────────────────────────────────────────

function decodeDataUrlToFile(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Invalid imageDataUrl — expected data:image/png|jpeg;base64');
  const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  const file = path.join(os.tmpdir(), `capturism-print-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

function runLp({ printer, file, copies, media }) {
  return new Promise((resolve, reject) => {
    const args = ['-d', printer, '-n', String(copies)];
    if (media) args.push('-o', `media=${media}`);
    args.push('-o', 'fit-to-page');
    args.push(file);
    const proc = spawn('lp', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`lp exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

// ─── Relay proxy ────────────────────────────────────────────────────────────
//
// Forwards a POST /api/relay/<endpoint> from the kiosk to the cloud relay's
// /api/booth/<endpoint>, adding the X-Booth-Auth header from this bridge's
// Node env (so the booth key never reaches the browser).
//
// `relayPath` is the path on the relay (e.g. '/api/booth/sign-upload').
// The request body is streamed through unchanged.
function forwardToRelay(req, res, relayPath) {
  const started = Date.now();
  const stage = relayPath === '/api/pool/sign-upload' ? 'pool.sign' : relayPath === '/api/pool/join' ? 'pool.join' : 'relay.http';
  const trace = req.headers['x-capturism-trace'];
  let recorded = false;
  const record = (status, error) => {
    if (recorded) return; recorded = true;
    diagnostics.write({ stage, trace, status, durationMs: Date.now() - started, outcome: error || status >= 400 ? 'error' : 'ok', error });
  };
  res.once('finish', () => record(res.statusCode));
  res.once('close', () => { if (!res.writableEnded) record(undefined, 'aborted'); });
  if (!RELAY_CONFIGURED) {
    return sendJSON(res, 503, { error: 'relay not configured on bridge (set RELAY_URL/BOOTH_ID/BOOTH_KEY in start-payment-bridge.bat)' });
  }
  const target = new URL(RELAY_URL + relayPath);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'X-Booth-Auth': `${BOOTH_ID}:${BOOTH_KEY}`,
  };
  const upstream = lib.request({
    method: req.method,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, {
      'Content-Type': upRes.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    record(502, err.message === 'upstream timeout' ? 'timeout' : 'network');
    console.warn(`[relay-proxy] upstream error for ${relayPath}: ${err.message}`);
    if (!res.headersSent) sendJSON(res, 502, { error: `relay unreachable: ${err.message}` });
    else res.end();
  });
  upstream.setTimeout(60_000, () => upstream.destroy(new Error('upstream timeout')));
  req.pipe(upstream);
}

// ─── Shelly proxy watchdog ──────────────────────────────────────────────────
//
// The Shelly lights proxy is a SEPARATE Node process at localhost:8080
// (lives in capturismstudio/lights, NOT this repo). It can die because
// the operator accidentally closes its window, Windows reboots, the
// node process crashes, etc. Without it the kiosk's lighting sliders
// stop responding (kiosk swallows the failures silently — they're not
// critical for printing, but customers don't see their requested mood).
//
// Self-heal: every 60s the bridge probes localhost:8080/api/status. On
// 3 consecutive CONNECTION failures (not 5xx — see probeShellyProxy),
// spawn start-lights-proxy.bat (which is
// idempotent — it bails cleanly if port 8080 IS already listening, see
// commit 5bff7cc). 60s cadence avoids hammering during normal operation.
const SHELLY_PROXY_URL = process.env.SHELLY_PROXY_URL || 'http://localhost:8080/api/status';
const SHELLY_WATCHDOG_INTERVAL_MS = 60_000;
// 3 rather than 2: the relaunch below KILLS whatever holds port 8080,
// so the bar for "the proxy is really gone" has to clear a transient.
const SHELLY_FAILURES_BEFORE_RESTART = 3;
/** Never relaunch the lights proxy more than once every 5 minutes... */
const SHELLY_RESTART_COOLDOWN_MS = 5 * 60_000;
/** ...and stop entirely after this many, rather than spawning windows forever. */
const SHELLY_MAX_RESTARTS = 3;
let shellyLastRestartAt = 0;
let shellyRestartCount = 0;
let shellyGaveUpLogged = false;
let shellyAliveSilentLogged = false;
let shellyConsecutiveFailures = 0;
let shellyWatchdogSpawning = false;

function probeShellyProxy() {
  return new Promise((resolve) => {
    const target = new URL(SHELLY_PROXY_URL);
    const req = http.get({
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      timeout: 10_000,
    }, (res) => {
      // Consume + discard body to free the socket
      res.resume();
      // ANY HTTP response means the proxy PROCESS is alive and serving.
      // That includes 5xx — which is exactly what it returns when the
      // SHELLY DEVICE is slow or unreachable over Wi-Fi. Restarting the
      // proxy cannot fix an unreachable Shelly, and treating 5xx as
      // "proxy dead" is what made this watchdog kill a perfectly healthy
      // proxy every ~90 s during and after sessions (light commands make
      // /api/status slow), spawning a fresh console window each time
      // until an operator cleaned them up (booth report 2026-09-05).
      // Only a connection-level failure or a timeout counts as dead.
      // Still surface the device-side problem: the proxy answering 5xx
      // means the LIGHTS are not working even though nothing needs
      // restarting, and that used to be visible (badly) as window spam.
      if (res.statusCode >= 500) {
        console.warn(`[shelly-watchdog] proxy is up but returned ${res.statusCode} — the Shelly device is unreachable/slow (check its power + Wi-Fi). Not restarting the proxy: that would not fix the device.`);
      }
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startShellyWatchdog() {
  if (process.platform !== 'win32') {
    // Lights are only on the kiosk PC (Windows). On dev Macs we skip.
    return;
  }
  setInterval(async () => {
    const ok = await probeShellyProxy();
    if (ok) {
      if (shellyConsecutiveFailures > 0) {
        console.log(`[shelly-watchdog] proxy back online (was ${shellyConsecutiveFailures}× failed)`);
      }
      shellyConsecutiveFailures = 0;
      // Healthy again: re-arm the restart budget so a genuine future
      // outage can still self-heal.
      shellyRestartCount = 0;
      shellyGaveUpLogged = false;
      shellyAliveSilentLogged = false;
      return;
    }
    shellyConsecutiveFailures++;
    console.warn(`[shelly-watchdog] proxy probe failed (${shellyConsecutiveFailures}× in a row)`);
    if (shellyConsecutiveFailures < SHELLY_FAILURES_BEFORE_RESTART || shellyWatchdogSpawning) return;

    // SILENT IS NOT DEAD. A timed-out /api/status only means the proxy did
    // not ANSWER in 10 s - and that endpoint goes through to the Shelly, so
    // a slow or unreachable Shelly (bad Wi-Fi) makes a perfectly healthy
    // proxy go quiet. Restarting it cannot help, and the launcher window it
    // opens lands on the customer-facing screen every time the network
    // struggles (booth, 2026-10-21: the window said "answering (HTTP 200) -
    // skipping launch"). So before spawning anything, ask the only question
    // that separates the two cases: is anything LISTENING on the port? A
    // busy proxy still accepts the connection; a dead one refuses it.
    const proxyUrl = new URL(SHELLY_PROXY_URL);
    if (await isPortListening(proxyUrl.port || 80, proxyUrl.hostname)) {
      if (!shellyAliveSilentLogged) {
        shellyAliveSilentLogged = true;
        console.warn(
          '[shelly-watchdog] proxy process is ALIVE (port accepts connections) but not answering - ' +
          'it is most likely waiting on the Shelly (check its power + Wi-Fi). Not restarting, no window opened.',
        );
      }
      return;
    }
    shellyAliveSilentLogged = false;

    // COOLDOWN + CAP. Without these the watchdog spawns a new console
    // window every time the probe fails, and if the proxy is crash-looping
    // (e.g. the Shelly is off the Wi-Fi and the proxy exits on the error)
    // the operator gets a window in their face every minute, forever, on a
    // customer-facing screen. Restarting is worth trying a few times;
    // doing it indefinitely just moves the fault from "lights are down" to
    // "lights are down AND the booth is unusable".
    const nowMs = Date.now();
    if (nowMs - shellyLastRestartAt < SHELLY_RESTART_COOLDOWN_MS) return;
    if (shellyRestartCount >= SHELLY_MAX_RESTARTS) {
      if (!shellyGaveUpLogged) {
        shellyGaveUpLogged = true;
        console.error(
          `[shelly-watchdog] GIVING UP after ${shellyRestartCount} restarts — the proxy keeps dying. ` +
          `Lights will stay off until someone looks at %USERPROFILE%\\lights. ` +
          `No more windows will be opened.`,
        );
      }
      return;
    }
    shellyLastRestartAt = nowMs;
    shellyRestartCount++;
    // Two failures → spawn the launcher. Idempotency check inside
    // start-lights-proxy.bat prevents double-launches.
    shellyWatchdogSpawning = true;
    const launcher = path.join(__dirname, 'start-lights-proxy.bat');
    if (!fs.existsSync(launcher)) {
      console.error(`[shelly-watchdog] cannot self-heal — launcher missing at ${launcher}`);
      shellyWatchdogSpawning = false;
      return;
    }
    console.warn('[shelly-watchdog] attempting auto-restart via start-lights-proxy.bat');
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '""', launcher], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      console.log('[shelly-watchdog] launcher spawned — proxy should be back in ~5s');
    } catch (err) {
      console.error(`[shelly-watchdog] spawn failed: ${err.message}`);
    }
    setTimeout(() => { shellyWatchdogSpawning = false; }, 30_000); // re-arm after 30s
  }, SHELLY_WATCHDOG_INTERVAL_MS);
}

// ─── Media counters (ribbon + paper) ────────────────────────────────────────
//
// Best-effort estimate of how many prints remain on the current DS620
// consumables. The operator buys ribbon and paper as a kit, but the two
// drift apart in practice (a jam eats paper without touching the ribbon,
// a test strip does the opposite), so each gets its OWN counter, its own
// capacity and its own reset. We count print jobs as they're fired and
// persist the running totals to disk so the counts survive bridge
// restarts. When the operator replaces a consumable, they run
// media-reset.bat → POST /api/printer/media/reset, which resets that
// counter to the new roll's capacity (ribbon ~200, paper 180 — see
// media-counter.js).
//
// This is the SIMPLE version — accurate enough for "alert when low".
// A more precise approach would query the DS620 via DNP SDK every poll,
// but that needs the SDK installed + a helper exe; not blocking.
//
// NOTHING here ever blocks a print or a session: the operator's rule is
// "warn me, keep selling". These counters only log, alert and display.
const MEDIA_FILE = path.join(__dirname, 'media-counter.json');
// Legacy single-counter file from before paper got its own count. On
// first load its {capacity, used, since} seeds BOTH counters so a booth
// mid-roll doesn't lose its running total across the update. We then
// write MEDIA_FILE and leave the legacy file on disk untouched (harmless,
// and it keeps an older bridge working if we ever have to roll back).
const RIBBON_FILE = path.join(__dirname, 'ribbon-counter.json');
const {
  MEDIA_KINDS,
  MEDIA_LOW_THRESHOLD,
  MEDIA_DEFAULT_CAPACITY,
  STATE_VERSION: MEDIA_STATE_VERSION,
  freshCounter,
  parseCounter,
  counterView: viewOf,
  upgradeState: upgradeMediaState,
} = require('./media-counter');

let mediaState = { ribbon: freshCounter('ribbon'), paper: freshCounter('paper') };

function loadMediaState() {
  // Migration is ONE-SHOT, keyed strictly on MEDIA_FILE's existence.
  //
  // It must NOT be a fallback for "MEDIA_FILE unreadable": the legacy file
  // is frozen at migration time and never written again, so re-migrating
  // would silently rewind BOTH counters to an ever-staler snapshot and
  // then persist it — the booth would believe it had a fresh roll while
  // running on a nearly-empty one. That is precisely the failure this
  // whole feature exists to prevent, so a present-but-corrupt MEDIA_FILE
  // fails LOUD and starts from zero instead of quietly rewinding.
  if (!fs.existsSync(MEDIA_FILE)) {
    try {
      if (fs.existsSync(RIBBON_FILE)) {
        const legacy = parseCounter(JSON.parse(fs.readFileSync(RIBBON_FILE, 'utf8')));
        if (legacy) {
          // The legacy file predates per-kind capacities, so it is
          // version 1: the paper capacity is corrected on the way in.
          mediaState = upgradeMediaState({ ribbon: { ...legacy }, paper: { ...legacy } }, 1).state;
          console.log(`[media] migrated ${RIBBON_FILE} → ribbon ${mediaState.ribbon.used}/${mediaState.ribbon.capacity}, paper ${mediaState.paper.used}/${mediaState.paper.capacity}`);
          saveMediaState();
          return;
        }
      }
    } catch (err) {
      console.warn(`[media] failed to read ${RIBBON_FILE}: ${err.message} — starting both counters fresh`);
    }
    return; // No file either way — keep the freshCounter() defaults.
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(MEDIA_FILE, 'utf8'));
    const ribbon = parseCounter(parsed.ribbon);
    const paper = parseCounter(parsed.paper);
    if (ribbon || paper) {
      const loaded = { ribbon: ribbon || freshCounter('ribbon'), paper: paper || freshCounter('paper') };
      const { state, changed } = upgradeMediaState(loaded, parsed.version);
      if (state.paper.capacity !== loaded.paper.capacity) {
        console.log(`[media] paper roll size corrected ${loaded.paper.capacity} -> ${state.paper.capacity} (one-time; the count and date are untouched)`);
      }
      mediaState = state;
      if (changed) saveMediaState();
      return;
    }
    console.warn(`[media] ⚠️ ${MEDIA_FILE} has no usable counters — starting from ZERO. Re-run media-reset.bat with the real remaining counts.`);
  } catch (err) {
    console.warn(`[media] ⚠️ could not read ${MEDIA_FILE} (${err.message}) — starting from ZERO. The counts are now WRONG until you run media-reset.bat.`);
  }
}

function saveMediaState() {
  try {
    // Write-then-rename so a power cut mid-write can't leave a truncated
    // MEDIA_FILE behind (which, per loadMediaState above, now costs the
    // operator their running count rather than silently rewinding it).
    const tmp = `${MEDIA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: MEDIA_STATE_VERSION, ...mediaState }, null, 2));
    fs.renameSync(tmp, MEDIA_FILE);
  } catch (err) {
    console.warn(`[media] failed to save counters: ${err.message}`);
  }
}

// One consumable's public shape — the same object the kiosk forwards on
// its heartbeat and the admin panel displays.
function counterView(kind) {
  return viewOf(mediaState[kind]);
}

function mediaView() {
  return { ribbon: counterView('ribbon'), paper: counterView('paper') };
}

/**
 * Bump the counters after a successful print job.
 *
 * @param {{ribbon:number, paper:number}} units — per-consumable amounts.
 *
 * Ribbon and paper are NOT consumed at the same rate, which is why they
 * drift apart in practice (operator observation, 2026-09). With 6×9 media
 * loaded, a multi-copy 4×6 job is auto-ganged by the DS620 driver — two
 * 4×6 pages land on ONE 6×9 sheet and are cut apart (see the Multiple
 * Layout note in print-image.ps1). So a 4-print Photo order consumes 4
 * ribbon prints but only 2 sheets of paper. Counting both by `copies`
 * exhausted the paper counter at roughly half the roll and would have
 * cried "empty" with 100 sheets still loaded — alarm fatigue on the one
 * warning that matters.
 *
 * These are ESTIMATES. Capacity is the calibration knob: if a consumable
 * consistently runs out early or late, set its real-world figure the next
 * time you run media-reset.bat.
 */
function incrementMedia(units) {
  const ribbonUnits = Number(units && units.ribbon);
  const paperUnits = Number(units && units.paper);
  if (!Number.isFinite(ribbonUnits) && !Number.isFinite(paperUnits)) return;
  if (Number.isFinite(ribbonUnits) && ribbonUnits > 0) mediaState.ribbon.used += ribbonUnits;
  if (Number.isFinite(paperUnits) && paperUnits > 0) mediaState.paper.used += paperUnits;
  saveMediaState();
  // Alert when low so the operator sees it in the bridge log. Both
  // counters move together here, but they drift apart after a
  // single-consumable reset — so warn per consumable, and always name
  // WHICH one is running out.
  for (const kind of MEDIA_KINDS) {
    const remaining = Math.max(0, mediaState[kind].capacity - mediaState[kind].used);
    if (remaining > 0 && remaining <= MEDIA_LOW_THRESHOLD && remaining % 5 === 0) {
      console.warn(`[media] ⚠️ ~${remaining} prints of ${kind} remaining — replace the ${kind} soon`);
    } else if (remaining === 0) {
      console.warn(`[media] ⚠️ ${kind} expected EMPTY — next print may fail. Replace the ${kind}, then run media-reset.bat (POST /api/printer/media/reset).`);
    }
  }
}

// GET /api/relay/health → proxies the relay's /api/health to keep Render's
// free dyno warm. No auth required (the relay's /api/health is public).
function forwardRelayHealth(res) {
  if (!RELAY_URL) {
    return sendJSON(res, 503, { error: 'RELAY_URL not set' });
  }
  const target = new URL(RELAY_URL + '/api/health');
  const lib = target.protocol === 'https:' ? https : http;
  const upstream = lib.get({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname,
    timeout: 15_000,
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, {
      'Content-Type': upRes.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) sendJSON(res, 502, { error: `relay unreachable: ${err.message}` });
    else res.end();
  });
}

/**
 * Windows print path. CUPS isn't available on Windows, and `mspaint /pt`
 * is unreliable on Windows 11 (sometimes opens the Paint app instead of
 * silently printing). We use PowerShell + .NET's System.Drawing.Printing
 * via the small print-image.ps1 script shipped next to this bridge.
 *
 * The script:
 *   - validates the printer name (Settings → Printers & scanners)
 *   - loads the PNG/JPEG file
 *   - assigns the requested PaperSize per job (so ONE Windows queue
 *     can fire any cut size — no dual-queue trick needed)
 *   - issues a SINGLE print job with `copies` pages, using HasMorePages
 *     so the DS620 driver can auto-gang two 4x6 pages onto one 6x9 sheet
 *     when 6x9 media is loaded (Multiple Layout feature). Looping
 *     $pd.Print() would create N separate jobs and break the auto-gang.
 *
 * paperSize: PaperName string from the DS620 driver's catalogue, e.g.
 *            "(6x4)", "(6x9)". Empty/undefined = use queue default.
 */
function runWindowsPrint({ printer, file, copies, paperSize }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'print-image.ps1');
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Printer', printer,
      '-ImagePath', file,
      '-Copies', String(copies),
    ];
    if (paperSize) args.push('-PaperSize', paperSize);
    const proc = spawn('powershell', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      // The PS script's exit codes are documented at its top: 1 = bad
      // printer name, 2 = unreadable image, 3 = unexpected error.
      const detail = stderr.trim() || stdout.trim() || `(exit ${code})`;
      reject(new Error(`PowerShell print exited ${code}: ${detail}`));
    });
  });
}

/**
 * DNP HotFolderPrint backend.  Drops the rasterised PNG into a watched
 * folder N times (one file per copy) — HFP detects each new file and
 * issues a print using the cut size configured for that folder in HFP's
 * UI.  Unlike the Windows driver path, this can fire 3.5×6 / 6×9 / any
 * other cut the DS620 hardware supports.
 *
 * Filenames include a sequence + timestamp so HFP processes them in the
 * order they're dropped and concurrent jobs don't collide.  We COPY the
 * source file (not move) so the caller's `finally { fs.unlink(file) }`
 * still cleans up tmp — the copies in the hot folder belong to HFP.
 */
function runHotFolderPrint({ folder, file, copies, sizeMode }) {
  if (!folder) {
    const envVar = sizeMode === '6x9' ? 'HOTFOLDER_6X9'
      : sizeMode === '3.5x6' ? 'HOTFOLDER_3_5X6'
        : 'HOTFOLDER_4X6';
    return Promise.reject(new Error(`hot-folder not configured for sizeMode=${sizeMode}; set ${envVar} in start-payment-bridge.bat`));
  }
  if (!fs.existsSync(folder)) {
    return Promise.reject(new Error(`hot-folder path does not exist: ${folder} — create it on disk and configure HotFolderPrint to watch it`));
  }
  return new Promise((resolve, reject) => {
    try {
      const ext = path.extname(file) || '.png';
      const stamp = Date.now();
      const rand = crypto.randomBytes(3).toString('hex');
      const written = [];
      for (let i = 1; i <= copies; i++) {
        // Pad copy index so HFP's alphabetical sort processes them in
        // order even if it picks files up faster than ms resolution.
        const name = `capturism-${stamp}-${rand}-${sizeMode}-${String(i).padStart(2, '0')}${ext}`;
        const dest = path.join(folder, name);
        fs.copyFileSync(file, dest);
        written.push(name);
      }
      resolve({ stdout: `dropped ${written.length} file(s) into ${folder}: ${written.join(', ')}` });
    } catch (err) {
      reject(err);
    }
  });
}

async function handlePrint(body) {
  const copies = Math.max(1, Math.min(10, parseInt(body.copies, 10) || 1));
  // Accepted cut sizes: '4x6' (default), '6x9' (Calendar), '3.5x6'
  // (Photo ID visa sheets 51×51 / 40×60 / 33×48).
  const sizeMode = body.sizeMode === '6x9' ? '6x9'
    : body.sizeMode === '3.5x6' ? '3.5x6'
      : '4x6';
  const media = sizeMode === '6x9' ? PRINTER_MEDIA_6X9
    : sizeMode === '3.5x6' ? PRINTER_MEDIA_3_5X6
      : PRINTER_MEDIA_4X6;
  // Windows can't change page size per print job (mspaint /pt uses the
  // printer's saved default). To support multiple cut sizes from one
  // physical DS620 + 6-inch roll, we keep a Windows printer queue per
  // cut size — PRINTER_NAME (4×6), PRINTER_NAME_6X9, PRINTER_NAME_3_5X6
  // — each with that default in its driver prefs, and route each job to
  // the queue matching sizeMode. Any unset queue falls back to
  // PRINTER_NAME.
  const targetPrinter = sizeMode === '6x9' ? PRINTER_NAME_6X9
    : sizeMode === '3.5x6' ? PRINTER_NAME_3_5X6
      : PRINTER_NAME;

  if (PRINT_MOCK) {
    const where = PRINT_BACKEND === 'hotfolder'
      ? `hot-folder (${sizeMode})`
      : `${targetPrinter} (${sizeMode}/${media})`;
    console.log(`[print] MOCK — would print ${copies}× via ${where}`);
    return { success: true, copies, mock: true };
  }

  const file = decodeDataUrlToFile(body.imageDataUrl);
  try {
    let stdout;
    if (PRINT_BACKEND === 'hotfolder') {
      // Hot-folder path: pick the folder pre-configured in HotFolderPrint
      // for this cut size, drop the PNG there N times, done.  HFP handles
      // everything past that (cut size, ribbon selection, retries).  This
      // is the ONLY path that supports 3.5×6 on a DS620.
      const folder = sizeMode === '6x9' ? HOTFOLDER_6X9
        : sizeMode === '3.5x6' ? HOTFOLDER_3_5X6
          : HOTFOLDER_4X6;
      ({ stdout } = await runHotFolderPrint({ folder, file, copies, sizeMode }));
      console.log(`[print] Hot-folder dropped ${copies}× for ${sizeMode}: ${stdout.trim()}`);
    } else if (PRINT_BACKEND === 'windows') {
      // PowerShell + System.Drawing.Printing path. Since v5 of
      // print-image.ps1 (2026-06) the script takes a per-job PaperSize,
      // so we only need ONE Windows queue (PRINTER_NAME). sizeMode is
      // mapped to the DS620 driver's PaperName string. The multi-queue
      // env vars (PRINTER_NAME_6X9 etc.) are kept for backwards-compat
      // — if someone has them set, they still route — but the default
      // path is a single queue + per-job paper size, which also lets
      // the DS620 auto-gang multi-copy 4x6 jobs into 6x9 cuts when 6x9
      // media is loaded (Multiple Layout feature).
      const paperSize = sizeMode === '6x9' ? '(6x9)'
        : sizeMode === '3.5x6' ? '(3.5x6)'
          : '(6x4)';
      ({ stdout } = await runWindowsPrint({ printer: targetPrinter, file, copies, paperSize }));
      console.log(`[print] Sent ${copies} page(s) to ${targetPrinter} as ${paperSize} (sizeMode=${sizeMode}): ${stdout.trim()}`);
    } else {
      // CUPS via lp (macOS / Linux dev).
      ({ stdout } = await runLp({ printer: targetPrinter, file, copies, media }));
      console.log(`[print] Sent ${copies}× to ${targetPrinter} (${sizeMode}): ${stdout.trim()}`);
    }
    // Successful print → bump both counters at their OWN rates.
    // Ribbon: one dye-panel cycle per page. Paper: one SHEET per cut, and
    // with 6×9 media loaded the driver gangs two 4×6 pages onto a single
    // 6×9 sheet (see incrementMedia's doc comment). 6×9 and 3.5×6 jobs
    // are one page per sheet.
    const paperSheets = sizeMode === '4x6' ? Math.ceil(copies / 2) : copies;
    incrementMedia({ ribbon: copies, paper: paperSheets });
    return { success: true, copies, mock: false };
  } finally {
    fs.unlink(file, () => {});
  }
}

// ─── Camera (Canon EDSDK direct via capture.exe daemon) ─────────────────────
//
// Architecture: bridge spawns `capture.exe --daemon` ONCE at startup. The
// daemon holds one EDSDK session open for the whole booth lifetime and
// listens for commands on stdin (CAPTURE / START_LV / STOP_LV / QUIT).
// While live view is active it serves Evf JPEG frames on
// http://127.0.0.1:5514/liveview.jpg.
//
// We proxy that to the kiosk at /api/camera/liveview.jpg so the kiosk's
// existing digicamLiveView module (which polls a single HTTP URL at
// ~20 fps and feeds an offscreen canvas → captureStream → <video>) can
// consume the real DSLR feed instead of the c920 webcam. End result:
// the customer's shoot preview matches the printed photo.
//
// Why direct EDSDK rather than digiCamControl: see
// ~/.claude/projects/-Users-ACS-Downloads-capturism/memory/
//   camera_digicamcontrol_unusable.md
// for the full saga. digiCamControl's wrapper crashes on programmatic
// captures (NullReferenceException), EDSDK itself is solid.
//
// The 200D II's firmware can't fire the shutter while Live View is
// active (error 8D0E). The daemon handles that cycle internally for
// every CAPTURE command: stops Evf → fires → restarts Evf.

const cameraState = {
  detected: false,    // true once the daemon prints READY
  model: null,        // 'Canon EDSDK' once detected
};

/**
 * Persistent capture.exe --daemon child process. Holds the EDSDK
 * session for the booth's lifetime. Talks to capture.exe via stdin
 * (command lines) / stdout (response lines).
 *
 * Daemon protocol (defined in capture-edsdk/Program.cs):
 *   stdout: READY                       (once, after init)
 *   stdin:  PING                        → stdout: PONG
 *   stdin:  CAPTURE <path>              → stdout: OK <path>  | ERR <reason>
 *   stdin:  START_LV                    → stdout: OK LIVEVIEW_URL=…  | ERR …
 *   stdin:  STOP_LV                     → stdout: OK  | ERR …
 *   stdin:  QUIT                        → stdout: BYE (then exits)
 *
 * Commands queue strictly serially; one in flight at a time. Each
 * command has its own timeout. Stderr lines from the daemon are
 * surfaced as [daemon stderr] in the bridge log.
 */
class EdsdkDaemon {
  constructor(exePath) {
    this.exePath = exePath;
    this.proc = null;
    this.ready = false;
    this.stdoutBuf = '';
    this.readyResolve = null;
    this.readyReject = null;
    this.cmdQueue = [];   // [{ cmd, resolve, reject, timeoutMs }]
    this.pending = null;  // { cmd, resolve, reject, timeoutId }
    this.shuttingDown = false;
  }

  start() {
    if (this.proc) return Promise.resolve();
    console.log(`[daemon] spawning: ${this.exePath} --daemon`);
    try {
      this.proc = spawn(this.exePath, ['--daemon'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      return Promise.reject(new Error(`could not spawn daemon: ${err.message}`));
    }

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      String(chunk).split('\n').filter((l) => l.trim()).forEach((line) => {
        console.warn(`[daemon stderr] ${line}`);
      });
    });
    this.proc.on('exit', (code, signal) => {
      const wasGraceful = this.shuttingDown;
      if (!wasGraceful) {
        console.warn(`[daemon] EXITED unexpectedly (code=${code}, signal=${signal}) — watchdog will try to respawn`);
      }
      this._reset(`daemon exited (code=${code}, signal=${signal})`);
      // Trigger self-heal watchdog ONLY on unexpected exits. The callback
      // is set by startDaemon() so it can call back into the module's
      // restart scheduler without coupling the daemon class to bridge
      // state.
      if (!wasGraceful && typeof this.onUnexpectedExit === 'function') {
        try { this.onUnexpectedExit(); } catch (err) { console.warn(`[daemon] onUnexpectedExit threw: ${err.message}`); }
      }
    });
    this.proc.on('error', (err) => {
      console.warn(`[daemon] process error: ${err.message}`);
      this._reset(`daemon process error: ${err.message}`);
    });

    return new Promise((resolve, reject) => {
      // 30s — was 15s. EDSDK cold-start after a Windows boot (drivers not
      // warm, no prior camera session) routinely takes 12-18s; 15s caught
      // those occasionally as false-positive timeouts. 30s removes the
      // edge case without making operational restarts feel slow.
      const t = setTimeout(() => {
        const r = this.readyReject;
        this.readyResolve = null;
        this.readyReject = null;
        if (r) r(new Error('daemon did not become READY within 30 s'));
      }, 30_000);
      this.readyResolve = () => { clearTimeout(t); resolve(); };
      this.readyReject = (err) => { clearTimeout(t); reject(err); };
    });
  }

  _onStdout(chunk) {
    this.stdoutBuf += String(chunk);
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    if (!this.ready && line === 'READY') {
      this.ready = true;
      console.log('[daemon] READY');
      if (this.readyResolve) this.readyResolve();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timeoutId);
      if (line.startsWith('OK')) {
        // "OK", "OK foo", "OK LIVEVIEW_URL=…" — strip leading "OK ".
        p.resolve(line.length > 3 ? line.substring(3) : '');
      } else if (line.startsWith('ERR')) {
        p.reject(new Error(line.length > 4 ? line.substring(4) : 'unknown daemon error'));
      } else if (line === 'PONG' || line === 'BYE') {
        p.resolve(line);
      } else {
        p.reject(new Error(`unexpected daemon line: ${line}`));
      }
      this._flush();
    } else {
      console.warn(`[daemon] unsolicited line: ${line}`);
    }
  }

  _reset(reason) {
    this.proc = null;
    this.ready = false;
    if (this.readyReject) {
      const r = this.readyReject;
      this.readyResolve = null;
      this.readyReject = null;
      r(new Error(reason));
    }
    if (this.pending) {
      clearTimeout(this.pending.timeoutId);
      this.pending.reject(new Error(reason));
      this.pending = null;
    }
    while (this.cmdQueue.length) {
      this.cmdQueue.shift().reject(new Error(reason));
    }
    cameraState.detected = false;
  }

  send(command, timeoutMs = 10_000) {
    if (!this.ready || !this.proc) {
      return Promise.reject(new Error('daemon not ready'));
    }
    return new Promise((resolve, reject) => {
      this.cmdQueue.push({ command, resolve, reject, timeoutMs });
      this._flush();
    });
  }

  _flush() {
    if (this.pending || this.cmdQueue.length === 0 || !this.proc) return;
    const item = this.cmdQueue.shift();
    const pending = { command: item.command, resolve: item.resolve, reject: item.reject, timeoutId: null };
    pending.timeoutId = setTimeout(() => {
      if (this.pending === pending) {
        this.pending = null;
        pending.reject(new Error(`daemon command timed out (${item.timeoutMs}ms): ${item.command}`));
        this._flush();
      }
    }, item.timeoutMs);
    this.pending = pending;
    try {
      this.proc.stdin.write(item.command + '\n');
    } catch (err) {
      clearTimeout(pending.timeoutId);
      this.pending = null;
      item.reject(new Error(`stdin write failed: ${err.message}`));
    }
  }

  stop() {
    if (!this.proc) return;
    this.shuttingDown = true;
    try { this.proc.stdin.write('QUIT\n'); } catch { /* ignore */ }
    setTimeout(() => { try { this.proc?.kill(); } catch { /* ignore */ } }, 1500);
  }
}

// Singleton daemon instance — null when CAMERA_MOCK=1, when capture.exe
// is missing, or when the daemon failed to start (kiosk sees camera as
// offline and falls back to webcam, exactly as it would with the old
// per-shot path failing).
let daemon = null;
let liveViewActive = false;

// Watchdog state for camera-daemon auto-respawn. Tracks restart attempts in
// a rolling 5-minute window so we don't infinite-loop if the daemon is
// fundamentally broken (e.g. missing DLL after a botched git pull) — at
// some point the operator needs to be notified to look at it.
const daemonRestartHistory = [];
const DAEMON_RESTART_WINDOW_MS = 5 * 60_000;
const DAEMON_MAX_RESTARTS_PER_WINDOW = 4;
let daemonRestartScheduled = false;

/**
 * Kill any stale `capture.exe` process. This is the #1 cause of
 * "daemon won't start" — a previous bridge instance crashed / was
 * X-button-closed / lost its clean shutdown, leaving capture.exe
 * running and holding the EDSDK session + the camera USB handle. A
 * fresh spawn would then fail because the camera is "busy".
 *
 * Idempotent: taskkill returns non-zero if no processes match, which
 * we treat as success ("nothing to kill" is a fine outcome). 800 ms
 * settle delay after the kill so Windows fully releases the USB
 * handle before we spawn the new one.
 *
 * Win32 only — no-op on macOS / Linux (the bridge runs in mock or no
 * camera mode there).
 */
function killStaleCaptureExe() {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    const proc = spawn('taskkill', ['/F', '/IM', 'capture.exe', '/T'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    proc.on('close', () => {
      // Brief settle so Windows fully releases the USB handle before
      // the next capture.exe spawn tries to grab it.
      setTimeout(resolve, 800);
    });
    proc.on('error', () => resolve()); // taskkill not on PATH? best-effort.
  });
}

async function startDaemon() {
  if (CAMERA_MOCK) {
    console.log('[camera] CAMERA_MOCK=1 — daemon not started');
    return;
  }
  if (!fs.existsSync(EDSDK_CAPTURE_EXE)) {
    console.warn(`[camera] EDSDK helper NOT found at ${EDSDK_CAPTURE_EXE}`);
    console.warn('[camera] kiosk will see camera as offline and fall back to webcam.');
    return;
  }

  // ── PRE-FLIGHT: kill any orphaned capture.exe ──────────────────
  // This is the SINGLE biggest improvement vs the old start path.
  // Bridge restarts, X-button closes, crashes — every scenario that
  // doesn't reach our clean shutdown leaves a capture.exe alive that
  // will block the new spawn. Always-on pre-flight kill makes daemon
  // startup reliable instead of operator-needing-to-manually-taskkill.
  console.log('[camera] pre-flight: killing any stale capture.exe...');
  await killStaleCaptureExe();

  // ── TWO-ATTEMPT STARTUP ────────────────────────────────────────
  // First attempt covers the common case. If it fails (EDSDK cold-start
  // hang, transient USB enumeration, etc.) we kill + wait + retry once.
  // After two failures we hand off to the watchdog (every 5s up to the
  // rolling cap) so the booth keeps trying instead of staying dead.
  for (let attempt = 1; attempt <= 2; attempt++) {
    daemon = new EdsdkDaemon(EDSDK_CAPTURE_EXE);
    daemon.onUnexpectedExit = scheduleDaemonRestart;
    try {
      await daemon.start();
      cameraState.detected = true;
      cameraState.model = 'Canon EDSDK';
      const tag = attempt === 1 ? '' : ` (succeeded on retry ${attempt}/2)`;
      console.log(`[camera] ✅ daemon ready — DSLR session open${tag}`);
      return;
    } catch (err) {
      console.warn(`[camera] daemon start attempt ${attempt}/2 failed: ${err.message}`);
      daemon = null;
      cameraState.detected = false;
      if (attempt < 2) {
        // Kill anything we spawned that might be lingering, wait, retry.
        await killStaleCaptureExe();
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }
  console.error('[camera] ❌ daemon failed both start attempts');
  console.error('[camera] check: camera powered on? lens on MF? mode dial M? Wi-Fi OFF?');
  console.error('[camera] watchdog will retry every 5s up to 4 times in the next 5 min.');
  // Engage the watchdog so we keep trying instead of being dead until
  // manual intervention.
  scheduleDaemonRestart();
}

function scheduleDaemonRestart() {
  if (daemonRestartScheduled) return; // already armed
  // Trim history to the rolling window.
  const cutoff = Date.now() - DAEMON_RESTART_WINDOW_MS;
  while (daemonRestartHistory.length && daemonRestartHistory[0] < cutoff) {
    daemonRestartHistory.shift();
  }
  if (daemonRestartHistory.length >= DAEMON_MAX_RESTARTS_PER_WINDOW) {
    console.error(`[camera] daemon has crashed ${daemonRestartHistory.length} times in the last ${DAEMON_RESTART_WINDOW_MS / 60_000} min — NOT respawning. Operator: check the camera + capture.exe build.`);
    return;
  }
  daemonRestartScheduled = true;
  daemonRestartHistory.push(Date.now());
  console.warn(`[camera] auto-respawn scheduled in 5s (restart #${daemonRestartHistory.length} in the rolling window)`);
  setTimeout(async () => {
    daemonRestartScheduled = false;
    daemon = null;
    cameraState.detected = false;
    await startDaemon();
    if (cameraState.detected) {
      console.log('[camera] ✅ daemon self-healed after unexpected exit');
    }
  }, 5_000);
}

function stopDaemon() {
  if (daemon) {
    daemon.stop();
    daemon = null;
  }
}

/**
 * Fire one shot via the persistent daemon. The daemon handles the
 * Evf-pause/restart cycle internally on the 200D II. Returns the JPG
 * path on success.
 */
async function captureSimple() {
  if (!daemon || !daemon.ready) throw new Error('camera daemon not ready');
  const filename = `capture-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`;
  const filepath = path.join(CAPTURES_DIR, filename);
  await daemon.send(`CAPTURE ${filepath}`, CAMERA_CAPTURE_TIMEOUT_MS);
  return filepath;
}

/**
 * Tell the daemon to start streaming Evf frames to its embedded HTTP
 * server (so /api/camera/liveview.jpg starts returning real frames).
 * Idempotent — the daemon answers OK ALREADY_ACTIVE if already on.
 */
async function startLiveView() {
  if (!daemon || !daemon.ready) throw new Error('camera daemon not ready');
  const resp = await daemon.send('START_LV', 5_000);
  liveViewActive = true;
  return resp;
}

/**
 * Tell the daemon to stop streaming Evf frames. Frees the camera's
 * Evf path so the next CAPTURE doesn't have to spend cycles pausing
 * it. Idempotent.
 */
async function stopLiveView() {
  if (!daemon || !daemon.ready) return;
  try {
    await daemon.send('STOP_LV', 5_000);
  } catch (err) {
    console.warn(`[camera] STOP_LV failed: ${err.message}`);
  }
  liveViewActive = false;
}

/**
 * /api/camera/capture handler. Returns { success, url, filename, tookMs }.
 */
async function handleCameraCapture() {
  if (CAMERA_MOCK) {
    throw new Error('camera disabled (CAMERA_MOCK=1) — kiosk should fall back to webcam snapshot');
  }
  if (!daemon || !daemon.ready) {
    throw new Error(`Camera daemon is not running. Check the bridge startup log; capture.exe may need to be rebuilt with --daemon support (capture-edsdk/README.md).`);
  }
  console.log('[camera] === CAPTURE ===');
  const t0 = Date.now();
  let filepath;
  try {
    filepath = await captureSimple();
  } catch (err) {
    console.warn(`[camera] capture failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}`);
    throw err;
  }
  const filename = path.basename(filepath);
  let bytes = 0;
  try { bytes = fs.statSync(filepath).size; } catch { /* file missing */ }
  if (!bytes) throw new Error(`daemon reported success but produced no file at ${filepath}`);
  const tookMs = Date.now() - t0;
  console.log(`[camera] captured ${filename} (${(bytes / 1024).toFixed(0)} KB) in ${(tookMs / 1000).toFixed(2)}s`);
  return { success: true, url: `/captures/${filename}`, filename, mock: false, tookMs };
}

/**
 * /api/camera/test handler. Fires 3 shots and reports timings for each.
 * Used by test-camera.bat.
 */
async function handleCameraTest() {
  const results = [];
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    try {
      const r = await handleCameraCapture();
      results.push({ shot: i, ok: true, ms: Date.now() - t0, filename: r.filename });
    } catch (err) {
      results.push({ shot: i, ok: false, ms: Date.now() - t0, error: err.message });
    }
  }
  return {
    successCount: results.filter((r) => r.ok).length,
    totalMs: results.reduce((s, r) => s + r.ms, 0),
    results,
  };
}

/**
 * /api/camera/liveview.jpg — proxy a single JPEG frame from the
 * daemon's embedded HTTP server. The kiosk's digicamLiveView module
 * polls this URL at ~20 fps and draws each frame onto a canvas; the
 * canvas's captureStream() becomes the <video> source on the camera
 * screen.
 */
function handleLiveViewProxy(res) {
  if (!daemon || !daemon.ready) {
    res.writeHead(503, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }
  const req = http.get('http://127.0.0.1:5514/liveview.jpg', (upstream) => {
    res.writeHead(upstream.statusCode || 502, {
      'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    upstream.pipe(res);
  });
  req.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  });
  req.setTimeout(2_000, () => req.destroy());
}

/**
 * Serve a previously-captured JPEG by filename. Used by the kiosk after
 * /api/camera/capture returns { url: '/captures/<name>' }.
 */
function handleCapturedFile(res, filename) {
  // Defensive: refuse anything that tries to escape CAPTURES_DIR.
  if (!/^[A-Za-z0-9._-]+\.(jpe?g)$/i.test(filename)) {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }
  const filepath = path.join(CAPTURES_DIR, filename);
  fs.readFile(filepath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;
  if (method === 'POST' && path === '/api/diagnostics') return receiveDiagnostics(req, res, diagnostics);

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    // ─── Relay proxy endpoints ────────────────────────────────────────
    // Kiosk hits these instead of calling the cloud relay directly, so
    // the booth API key stays in Node env (never in browser JS bundle).
    // See `forwardToRelay` for details.
    // POST /api/video-queue?token=&kind=&contentType=&photoKey=
    // Hand-off point: the kiosk streams a finished video here and is done.
    // This is localhost, so it cannot fail for network reasons — which is
    // the entire point. Delivery to R2 happens later, in the background,
    // and survives restarts (see video-queue.js).
    if (method === 'POST' && path === '/api/video-queue') {
      return videoQueue.enqueue(req, res, {
        token: url.searchParams.get('token'),
        kind: url.searchParams.get('kind'),
        contentType: url.searchParams.get('contentType'),
        photoKey: url.searchParams.get('photoKey'),
      }, sendJSON);
    }

    if (method === 'POST' && path === '/api/relay/sign-upload') {
      return forwardToRelay(req, res, '/api/booth/sign-upload');
    }
    if (method === 'POST' && path === '/api/relay/photos-ready') {
      return forwardToRelay(req, res, '/api/booth/photos-ready');
    }
    if (method === 'GET' && path === '/api/relay/configured') {
      return sendJSON(res, 200, { configured: RELAY_CONFIGURED });
    }
    if (method === 'GET' && path === '/api/relay/health') {
      return forwardRelayHealth(res);
    }

    // ─── l'INCONNU quiz codes (relay-proxied, booth-key stays in Node) ──
    if (method === 'POST' && path === '/api/relay/quiz/redeem') {
      return forwardToRelay(req, res, '/api/booth/quiz/redeem');
    }
    // Question config is public on the relay, but the kiosk still goes
    // through the bridge so it works offline-first against one origin.
    if (method === 'GET' && path === '/api/relay/quiz/config') {
      return forwardToRelay(req, res, '/api/quiz/config');
    }

    // ─── l'INCONNU pool (relay-proxied, booth-key stays in Node) ──
    if (method === 'POST' && path === '/api/relay/pool/sign-upload') {
      return forwardToRelay(req, res, '/api/booth/pool/sign-upload');
    }
    if (method === 'POST' && path === '/api/relay/pool/join') {
      return forwardToRelay(req, res, '/api/booth/pool/join');
    }
    if (method === 'POST' && path === '/api/relay/pool/match') {
      return forwardToRelay(req, res, '/api/booth/pool/match');
    }
    if (method === 'GET' && path === '/api/relay/pool/status') {
      return forwardToRelay(req, res, '/api/booth/pool/status');
    }
    // Streams the matched stranger's portrait bytes (?id=<entryId>) —
    // same-origin for the kiosk, so html-to-image can rasterize it
    // without canvas taint (see project_canvas_taint_bridge_urls).
    if (method === 'GET' && path === '/api/relay/pool/portrait') {
      return forwardToRelay(req, res, '/api/booth/pool/portrait' + url.search);
    }

    // ─── Media counters, ribbon + paper (best-effort estimate) ──────
    // GET returns both counts + estimated remaining. The kiosk polls
    // this and forwards it on its heartbeat, so the admin panel can
    // display the levels and the relay can email when one runs low.
    // POST resets one or both — media-reset.bat calls it after the
    // operator physically replaces a consumable.
    if (method === 'GET' && path === '/api/printer/media') {
      return sendJSON(res, 200, mediaView());
    }
    if (method === 'POST' && path === '/api/printer/media/reset') {
      const body = await parseBody(req).catch(() => ({}));
      // Anything that isn't exactly "ribbon" or "paper" means both — a
      // typo at the booth should reset the whole kit, not nothing.
      const which = body.which === 'ribbon' || body.which === 'paper' ? body.which : 'both';
      const kinds = which === 'both' ? MEDIA_KINDS : [which];
      // No capacity (or a nonsense one) means "same roll size as
      // before". Never snap back to the 200 default here, or an operator
      // running a bigger kit silently loses their real capacity on every
      // swap.
      const newCapacity = Number(body.capacity) > 0 ? Number(body.capacity) : null;
      for (const kind of kinds) {
        mediaState[kind] = freshCounter(kind, newCapacity || mediaState[kind].capacity);
      }
      saveMediaState();
      console.log(`[media] reset ${kinds.join(' + ')} — capacity now ${kinds.map((k) => `${k}=${mediaState[k].capacity}`).join(', ')} prints`);
      return sendJSON(res, 200, { ok: true, ...mediaView() });
    }

    // Legacy ribbon-only routes, from before paper had its own count.
    // Mapped onto the ribbon counter and kept working verbatim — nothing
    // in the current kiosk calls them, but an operator's saved curl
    // command might, and they cost a dozen lines.
    if (method === 'GET' && path === '/api/printer/ribbon') {
      const ribbon = counterView('ribbon');
      return sendJSON(res, 200, {
        used: ribbon.used,
        capacity: ribbon.capacity,
        remaining: ribbon.remaining,
        since: ribbon.since,
        lowAlert: ribbon.low,
        empty: ribbon.empty,
      });
    }
    if (method === 'POST' && path === '/api/printer/ribbon/reset') {
      const body = await parseBody(req).catch(() => ({}));
      const newCapacity = Number(body.capacity) > 0 ? Number(body.capacity) : MEDIA_DEFAULT_CAPACITY.ribbon;
      mediaState.ribbon = freshCounter('ribbon', newCapacity);
      saveMediaState();
      console.log(`[ribbon] reset — new capacity ${newCapacity} prints`);
      return sendJSON(res, 200, { ok: true, ...mediaState.ribbon });
    }

    // Health check — kiosk reads data.camera.connected at startup to
    // decide whether to use the DSLR capture path. `mock: true` means
    // the backend is mocked and the kiosk should fall back to webcam.
    if (method === 'GET' && path === '/api/health') {
      const cameraConnected = !CAMERA_MOCK && cameraState.detected;
      return sendJSON(res, 200, {
        ok: true,
        mode: MODE,
        uptime: process.uptime(),
        camera: {
          connected: cameraConnected,
          mock: CAMERA_MOCK,
          backend: cameraConnected ? 'edsdk' : null,
          model: cameraState.model,
          // Advertise the live-view URL so the kiosk's digicamLiveView
          // module picks it up and polls real DSLR frames instead of
          // showing the c920 webcam during the shoot.
          liveViewUrl: cameraConnected ? '/api/camera/liveview.jpg' : null,
        },
      });
    }

    // ─── Live view ─────────────────────────────────────────────
    // The kiosk turns the DSLR live preview on/off as it enters and
    // leaves the camera-capture screen, then polls /liveview.jpg at
    // ~20 fps while it's on.
    if (method === 'POST' && path === '/api/camera/liveview/start') {
      console.log('[camera] /api/camera/liveview/start received');
      try {
        const msg = await startLiveView();
        console.log(`[camera] daemon START_LV response: ${msg}`);
        return sendJSON(res, 200, { ok: true, message: msg });
      } catch (err) {
        console.warn(`[camera] START_LV threw: ${err.message}`);
        return sendJSON(res, 500, { error: err.message });
      }
    }
    if (method === 'POST' && path === '/api/camera/liveview/stop') {
      console.log('[camera] /api/camera/liveview/stop received');
      try {
        await stopLiveView();
        return sendJSON(res, 200, { ok: true });
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    }
    if (method === 'GET' && path === '/api/camera/liveview.jpg') {
      return handleLiveViewProxy(res);
    }

    // Camera capture — fires the DSLR shutter via EDSDK helper, saves
    // the JPEG into <bridge>/captures/, returns its relative URL.
    if (method === 'POST' && path === '/api/camera/capture') {
      try {
        const result = await handleCameraCapture();
        return sendJSON(res, 200, result);
      } catch (err) {
        console.error('[camera] capture error:', err.message);
        return sendJSON(res, 500, { error: err.message });
      }
    }

    // Camera self-test — fires 3 shots and returns timings. Called by
    // test-camera.bat to verify the camera path end-to-end.
    if (method === 'POST' && path === '/api/camera/test') {
      try {
        const result = await handleCameraTest();
        return sendJSON(res, 200, result);
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    }

    // Serve captured stills back to the kiosk.
    const captureMatch = path.match(/^\/captures\/([^/]+)$/);
    if (method === 'GET' && captureMatch) {
      return handleCapturedFile(res, captureMatch[1]);
    }

    // Initiate payment
    if (method === 'POST' && path === '/api/payment/initiate') {
      const body = await parseBody(req);
      const amount = parseInt(body.amount, 10);
      if (!amount || amount <= 0) {
        return sendJSON(res, 400, { error: 'Invalid amount' });
      }

      const txId = generateTxId();
      driver.initiate(txId, amount);

      console.log(`[${MODE}] Payment initiated: ${txId} for ${amount} cents`);
      return sendJSON(res, 200, {
        transactionId: txId,
        status: 'waiting',
        amount,
        currency: body.currency || 'EUR'
      });
    }

    // Check status
    const statusMatch = path.match(/^\/api\/payment\/status\/(.+)$/);
    if (method === 'GET' && statusMatch) {
      const txId = statusMatch[1];
      const tx = transactions.get(txId);
      if (!tx) {
        return sendJSON(res, 404, { error: 'Transaction not found' });
      }
      return sendJSON(res, 200, {
        transactionId: txId,
        status: tx.status,
        message: tx.message,
        amount: tx.amount,
        currency: tx.currency
      });
    }

    // Print
    if (method === 'POST' && path === '/api/printer/print') {
      const body = await parseBody(req);
      if (!PRINT_MOCK && !body.imageDataUrl) {
        return sendJSON(res, 400, { error: 'Missing imageDataUrl' });
      }
      try {
        const result = await handlePrint(body);
        return sendJSON(res, 200, result);
      } catch (err) {
        console.error('[print] error:', err.message);
        return sendJSON(res, 500, { error: err.message });
      }
    }

    // Cancel payment
    if (method === 'POST' && path === '/api/payment/cancel') {
      const body = await parseBody(req);
      if (!body.transactionId) {
        return sendJSON(res, 400, { error: 'Missing transactionId' });
      }
      driver.cancel(body.transactionId);
      console.log(`[${MODE}] Payment cancelled: ${body.transactionId}`);
      return sendJSON(res, 200, { status: 'cancelled', transactionId: body.transactionId });
    }

    // 404
    sendJSON(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('[Bridge Error]', err.message);
    sendJSON(res, 500, { error: err.message });
  }
});

// Last-resort error handlers. Without these, an unhandled promise
// rejection or thrown error inside a setInterval / queueMicrotask
// callback can take down the whole Node process — meaning the HTTP
// listener dies and the kiosk loses the bridge until a human notices
// and relaunches it. Log loudly, but stay up.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  console.error(`[bridge] UNHANDLED REJECTION (kept alive): ${msg}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[bridge] UNCAUGHT EXCEPTION (kept alive): ${err.message}\n${err.stack}`);
});

// ─── Relay WebSocket proxy ──────────────────────────────────────────────────
//
// The kiosk's boothRelay.ts connects to `/api/relay/ws` on this bridge
// (proxied through Vite's https://localhost:5173 → http://localhost:3001).
// For each kiosk WS, we open an upstream WS to the cloud relay with the
// booth-key baked into the URL — so the kiosk never has to know it.
//
// noServer mode lets us hook into the existing http.Server's `upgrade`
// event and inspect the path before deciding to accept the WS. Anything
// other than /api/relay/ws gets a 404 (no other WS endpoints on the
// bridge today).
const relayWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // socket is a raw net.Socket here; we MUST destroy it on the negative
  // paths so the kiosk sees a clean disconnect instead of hanging.
  const upUrl = new URL(req.url, `http://localhost:${PORT}`);
  if (upUrl.pathname !== '/api/relay/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!RELAY_CONFIGURED) {
    console.warn('[relay-proxy] WS rejected — RELAY_URL/BOOTH_ID/BOOTH_KEY not set');
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  relayWss.handleUpgrade(req, socket, head, (kioskWs) => {
    // Build the upstream URL once — reused across reconnects.
    const proto = RELAY_URL.startsWith('https') ? 'wss' : 'ws';
    const host = RELAY_URL.replace(/^https?:\/\//, '');
    const upstreamUrl = `${proto}://${host}/ws?type=booth`
      + `&boothId=${encodeURIComponent(BOOTH_ID)}`
      + `&key=${encodeURIComponent(BOOTH_KEY)}`;
    console.log(`[relay-proxy] WS kiosk→bridge accepted; opening upstream to ${proto}://${host}/ws`);

    // ── Resilient upstream connection ─────────────────────────────────
    //
    // Render's free dyno occasionally drops idle WSes (15-min spin-down,
    // network blips). Previously every drop slammed the kiosk WS with
    // code=1011 → the kiosk reconnected → flap loop visible as spam
    // in the booth's DevTools console.
    //
    // Now: when upstream errors/closes, we DON'T close the kiosk WS.
    // We buffer any kiosk-side traffic and try to reopen upstream with
    // exponential backoff. Only if we exhaust retries does the kiosk
    // see a close. Most Render blips recover within 1-2 attempts so
    // the kiosk never notices.
    const MAX_RECONNECT_ATTEMPTS = 8;     // ~ (1+2+4+8+15+15+15+15) = 75s total
    const BACKOFF_MIN_MS = 1000;
    const BACKOFF_MAX_MS = 15000;
    let upstream = null;
    let upstreamReady = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let teardown = false;          // kiosk WS closed for good — stop trying
    const queued = [];             // messages from kiosk to forward when upstream is up

    function openUpstream() {
      if (teardown) return;
      upstream = new WsClient(upstreamUrl);
      upstreamReady = false;

      upstream.on('open', () => {
        upstreamReady = true;
        reconnectAttempts = 0;
        const flush = queued.length;
        for (const msg of queued) upstream.send(msg);
        queued.length = 0;
        if (reconnectTimer) {
          // We're recovering from a flap.
          console.log(`[relay-proxy] upstream RECONNECTED; flushed ${flush} queued msg(s)`);
        } else {
          console.log(`[relay-proxy] upstream connected; flushing ${flush} queued msg(s)`);
        }
      });

      upstream.on('message', (data) => {
        if (kioskWs.readyState === kioskWs.OPEN) kioskWs.send(data);
      });

      // Combined close/error → schedule a reconnect. Both fire on most
      // network errors; we de-dup via reconnectTimer.
      const handleDrop = (label, code, reason) => {
        if (teardown) return;
        upstreamReady = false;
        if (reconnectTimer) return;  // already scheduled
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.warn(`[relay-proxy] upstream ${label} after ${reconnectAttempts} attempts — giving up, closing kiosk WS`);
          if (kioskWs.readyState === kioskWs.OPEN) {
            kioskWs.close(code || 1011, reason || 'upstream unreachable');
          }
          return;
        }
        const delay = Math.min(BACKOFF_MIN_MS * Math.pow(2, reconnectAttempts), BACKOFF_MAX_MS);
        reconnectAttempts += 1;
        console.log(`[relay-proxy] upstream ${label} (code=${code || '-'}) — retry #${reconnectAttempts} in ${delay}ms`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          openUpstream();
        }, delay);
      };
      upstream.on('close', (code, reason) => handleDrop('closed', code, reason));
      upstream.on('error', (err) => handleDrop(`error (${err.message})`, 1011, 'upstream error'));
    }

    openUpstream();

    kioskWs.on('message', (data) => {
      // Forward kiosk → relay. If upstream isn't ready (initial connect
      // or mid-reconnect), queue. The buffer lets the kiosk's heartbeats
      // and session-complete events survive an upstream flap without
      // any kiosk-visible disconnect.
      if (upstreamReady && upstream && upstream.readyState === upstream.OPEN) {
        upstream.send(data);
      } else {
        queued.push(data);
      }
    });
    kioskWs.on('close', (code, reason) => {
      console.log(`[relay-proxy] kiosk WS closed code=${code} — tearing down upstream`);
      teardown = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (upstream && (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING)) {
        upstream.close(code, reason);
      }
    });
    kioskWs.on('error', (err) => {
      console.warn(`[relay-proxy] kiosk WS error: ${err.message}`);
    });
  });
});

// Stop the EDSDK daemon cleanly on bridge shutdown so the camera USB
// session is released and the next bridge start can grab it. Belt +
// suspenders: clean QUIT via stopDaemon, THEN a defensive taskkill
// in case the daemon hung or the QUIT message lost over a broken pipe.
// Without the taskkill, X-button bridge closes would leave capture.exe
// orphaned and break the next launch.
function shutdownBridge() {
  try { stopDaemon(); } catch { /* best-effort */ }
  // Fire taskkill in parallel (don't await — we want the bridge to
  // exit promptly even if the kill takes a moment).
  killStaleCaptureExe().catch(() => undefined);
  // Bumped 1800 → 2500 to allow taskkill to finish before exit.
  setTimeout(() => process.exit(0), 2500);
}
process.on('SIGINT', shutdownBridge);
process.on('SIGTERM', shutdownBridge);
process.on('beforeExit', () => { try { stopDaemon(); } catch { /* best-effort */ } });

server.listen(PORT, async () => {
  // Resumes anything left on disk by a previous run before printing the
  // banner — a PC that died mid-upload still delivers after a reboot.
  videoQueue.startWorker({
    relayUrl: RELAY_URL,
    boothId: BOOTH_ID,
    boothKey: BOOTH_KEY,
    onAlert: (a) => console.warn(`[video-queue] ALERT ${a.code}: ${a.message}`),
  });

  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   CAPTURISM Payment Bridge v1.0          ║`);
  console.log(`  ║   Mode: ${MODE.padEnd(33)}║`);
  console.log(`  ║   Port: ${String(PORT).padEnd(33)}║`);
  if (MODE === 'telium') {
    console.log(`  ║   Terminal: ${(TERMINAL_IP + ':' + TERMINAL_PORT).padEnd(29)}║`);
  }
  const printerLine = PRINT_MOCK
    ? 'mock'
    : PRINT_BACKEND === 'hotfolder'
      ? `hot-folder (${PRINT_BACKEND})`
      : `${PRINTER_NAME} (${PRINT_BACKEND})`;
  console.log(`  ║   Printer: ${printerLine.padEnd(30)}║`);
  if (!PRINT_MOCK && PRINT_BACKEND === 'hotfolder') {
    console.log(`[print] hot-folder mode — DNP HotFolderPrint must be running on this PC.`);
    console.log(`[print]   4x6    → ${HOTFOLDER_4X6 || '(unset — 4×6 prints will FAIL)'}`);
    console.log(`[print]   3.5x6  → ${HOTFOLDER_3_5X6 || '(unset — 3.5×6 prints will FAIL)'}`);
    console.log(`[print]   6x9    → ${HOTFOLDER_6X9 || '(unset — 6×9 prints will FAIL)'}`);
  }
  const cameraLine = CAMERA_MOCK ? 'mock' : 'EDSDK';
  console.log(`  ║   Camera:  ${cameraLine.padEnd(30)}║`);
  const relayLine = RELAY_CONFIGURED
    ? `proxy → ${RELAY_URL.replace(/^https?:\/\//, '').slice(0, 22)}`
    : 'NOT CONFIGURED';
  console.log(`  ║   Relay:   ${relayLine.padEnd(30)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
  if (!RELAY_CONFIGURED) {
    console.warn('[relay-proxy] BOOTH_KEY / RELAY_URL / BOOTH_ID not set — cloud uploads + admin WS disabled.');
    console.warn('[relay-proxy] Set them in start-payment-bridge.bat (copy values from capturism-app/.env or .env.local).');
  } else {
    console.log(`[relay-proxy] booth=${BOOTH_ID} key=***${BOOTH_KEY.slice(-4)} relay=${RELAY_URL}`);
  }
  if (!CAMERA_MOCK) {
    console.log(`[camera] EDSDK helper:   ${EDSDK_CAPTURE_EXE}`);
    console.log(`[camera] captures dir:   ${CAPTURES_DIR}`);
    console.log(`[camera] JPG rotation:   ${EDSDK_ROTATE_DEG}°  (EDSDK_ROTATE_DEG — 0 means OFF)`);
    if (EDSDK_ROTATE_DEG === '0') {
      console.warn('[camera] rotation is OFF — if photos come out sideways, set EDSDK_ROTATE_DEG in start-payment-bridge.bat');
    }
    await startDaemon();
    if (!cameraState.detected) {
      console.warn('[camera] daemon not running — kiosk SPA will see camera as offline and fall back to webcam.');
    }
  }
  // Media counters + Shelly proxy watchdog (Windows kiosk only — no-op on
  // dev macs since the lights stack doesn't run there).
  loadMediaState();
  for (const kind of MEDIA_KINDS) {
    const counter = mediaState[kind];
    const remaining = Math.max(0, counter.capacity - counter.used);
    console.log(`[media] loaded ${kind} counter: ${counter.used}/${counter.capacity} used (~${remaining} prints remaining since ${counter.since})`);
  }
  startShellyWatchdog();
  if (process.platform === 'win32') {
    console.log(`[shelly-watchdog] monitoring ${SHELLY_PROXY_URL} every ${SHELLY_WATCHDOG_INTERVAL_MS / 1000}s — auto-restarts proxy after ${SHELLY_FAILURES_BEFORE_RESTART} consecutive unreachable probes`);
  }
});
