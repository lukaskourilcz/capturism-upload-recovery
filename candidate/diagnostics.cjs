'use strict';
const fs = require('fs');
const path = require('path');
const STAGES = new Set(['photo.sign','photo.put','photo.confirm','video.enqueue','pool.sign','pool.put','pool.join','pool.enqueue','pool.delivery','render.segmentation','render.raster','render.video','page.visibility','page.timer','page.boot','relay.http']);
// Only explicit metadata is written. Never accept arbitrary console output,
// URLs, request/response bodies, names, quiz codes, auth or signed query strings.
function sanitize(input) {
  if (!input || !STAGES.has(input.stage)) return null;
  const out = { at: new Date().toISOString(), stage: input.stage };
  for (const key of ['durationMs','status','bytes','driftMs','clientAtMs']) if (Number.isFinite(input[key])) out[key] = Math.max(0, Math.min(1e13, input[key]));
  if (/^[a-f0-9-]{8,64}$/.test(input.trace || '')) out.trace = input.trace;
  if (['start','ok','error','visible','hidden'].includes(input.outcome)) out.outcome = input.outcome;
  if (['timeout','network','http','aborted','other'].includes(input.error)) out.error = input.error;
  return out;
}
function createDiagnostics({ directory = path.join(__dirname, 'diagnostic-logs'), maxBytes = 2 * 1024 * 1024, backups = 4 } = {}) {
  const file = path.join(directory, 'kiosk.jsonl');
  let warned = false;
  return { file, write(input) {
    const event = sanitize(input); if (!event) return false;
    try {
      fs.mkdirSync(directory, { recursive: true });
      const line = JSON.stringify(event) + '\n';
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        for (let n = backups; n >= 1; n--) {
          const src = n === 1 ? file : `${file}.${n - 1}`, dst = `${file}.${n}`;
          if (fs.existsSync(dst)) fs.unlinkSync(dst);
          if (fs.existsSync(src)) fs.renameSync(src, dst);
        }
      }
      fs.appendFileSync(file, line, { mode: 0o600 }); return true;
    } catch { if (!warned) { warned = true; console.warn('[diagnostics] local log unavailable'); } return false; }
  } };
}
async function receiveDiagnostics(req, res, logger) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return; }
  let body = ''; let size = 0;
  try {
    for await (const chunk of req) { size += chunk.length; if (size > 32768) { res.writeHead(413); res.end(); return; } body += chunk; }
    const events = JSON.parse(body);
    if (!Array.isArray(events) || events.length > 50) { res.writeHead(400); res.end(); return; }
    for (const event of events) logger.write(event);
    res.writeHead(204); res.end();
  } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
}
module.exports = { createDiagnostics, receiveDiagnostics, sanitize };
