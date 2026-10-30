import QRCode from 'qrcode';
import { resetSession, getSessionEpoch } from './adapters';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const nativeFetch = window.fetch.bind(window);
// Extra boundary in addition to CSP: this harness never accepts remote services.
window.fetch = (resource, init) => {
  const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url, location.href);
  if (url.origin !== location.origin) return Promise.reject(new Error('Twin blocks external requests'));
  return nativeFetch(resource, init);
};
async function api(path: string, body?: unknown) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data;
}
const log = (message: string) => api('/lab/client-event', { message }).catch(() => {});
for (const method of ['log', 'warn'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args) => { original(...args); if (String(args[0]).startsWith('[UPLOAD]')) void log(args.map(String).join(' ')); };
}
const baseline = await import('../vendor/relayUpload');
const candidate = await import('../candidate/capturism-app/src/lib/relayUpload');
import { qrInactivityDelay } from '../candidate/capturism-app/src/lib/qrWaitPolicy';
let uploader = baseline;
let scanWindowMs = 300_000;
let fixedRun = false;
let busy = false, started = 0, ended = false, qrReady = false, timer: ReturnType<typeof setTimeout>;

function testCanvas() {
  const c = document.createElement('canvas'); c.width = 900; c.height = 1200;
  const x = c.getContext('2d')!; x.fillStyle = '#eee9da'; x.fillRect(0, 0, 900, 1200);
  x.fillStyle = '#375943'; x.fillRect(55, 55, 790, 970);
  x.fillStyle = '#b8cb8d'; x.beginPath(); x.arc(450, 480, 220, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#f4edda'; x.font = '52px Georgia'; x.fillText('CAPTURISM', 265, 840);
  x.fillStyle = '#375943'; x.font = '25px Arial'; x.fillText('LOCAL TEST · NO CUSTOMER DATA', 210, 1100);
  return c;
}
async function photo() {
  const file = input('photo').files?.[0]; let dataUrl: string;
  if (file) {
    if (file.size > 16 * 1024 * 1024) throw new Error('Choose a test photo smaller than 16 MiB');
    dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
  } else dataUrl = testCanvas().toDataURL('image/png');
  const compressed = await uploader.photoBlobForUpload(dataUrl);
  if (file) return compressed;
  const size = Math.max(.1, Math.min(16, Number(input('size').value) || 1)) * 1024 * 1024;
  // JPEG decoders ignore trailing padding. This yields a valid local test image
  // with a controlled upload size, without real customer photos.
  return { blob: new Blob([compressed.blob, new Uint8Array(Math.max(0, Math.floor(size - compressed.blob.size)))], { type: compressed.contentType }), contentType: compressed.contentType };
}
async function clip(): Promise<Blob> {
  const c = testCanvas(); const stream = c.captureStream(12);
  const type = ['video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) { stream.getTracks().forEach(t => t.stop()); throw new Error('This browser cannot generate the test video; uncheck videos'); }
  return new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(stream, { mimeType: type }); const chunks: Blob[] = [];
    const stop = () => stream.getTracks().forEach(t => t.stop());
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => { stop(); reject(new Error('Test video recording failed')); };
    recorder.onstop = () => { stop(); resolve(new Blob(chunks, { type: 'video/webm' })); };
    recorder.start(); setTimeout(() => recorder.stop(), 900);
  });
}
function endSession() {
  resetSession(); ended = true; clearTimeout(timer);
  $('status').textContent = 'Kiosk session ended.';
  $('detail').textContent = 'In-flight uploads may finish, but their token must not appear in the next session.';
  $('qr').hidden = true; $('download').hidden = true; qrReady = false;
  void log('Kiosk session reset: epoch incremented; checking late-upload guard');
}
input('end').onclick = endSession;
input('bridge').onclick = async () => { try { await api('/lab/restart-bridge', {}); } catch (e) { $('detail').textContent = String(e); } };
input('start').onclick = async () => {
  if (busy) return;
  clearTimeout(timer);
  busy = true; ended = false; qrReady = false; input('start').disabled = true; input('end').disabled = false; input('bridge').disabled = false;
  $('qr').hidden = true; $('download').hidden = true;
  for (const el of document.querySelectorAll('.steps>div')) el.classList.remove('done');
  resetSession();
  try {
    fixedRun = input('implementation').value === 'candidate';
    uploader = fixedRun ? candidate : baseline;
    await api('/lab/start', { scenario: input('scenario').value }); started = Date.now();
    $('status').textContent = 'Preparing your download…'; $('detail').textContent = 'Waiting for photo upload and confirmation.';
    scanWindowMs = Math.max(1, Math.min(900, Number(input('reset').value) || 300)) * 1000;
    const waitMs = fixedRun ? qrInactivityDelay({ needsQr: true, hasToken: false, scanWindowMs }) : scanWindowMs;
    timer = setTimeout(endSession, waitMs);
    await log(`Version: ${fixedRun ? 'local fix' : 'baseline'}; scan window ${scanWindowMs}ms; pending timeout ${waitMs}ms`);
    const epoch = getSessionEpoch();
    const asset = await photo();
    const video = input('videos').checked ? await clip() : undefined;
    await delay(Math.max(0, Math.min(600, Number(input('composition').value) || 0)) * 1000);
    if (epoch !== getSessionEpoch()) throw new Error('Session ended during preparation; no upload started');
    $('step-prep').classList.add('done');
    await log(`Prepared photo: ${Math.round(asset.blob.size / 1024)} KiB. Starting original uploadSessionToCloud.`);
    const token = await uploader.uploadSessionToCloud({ photo: asset.blob, photoContentType: asset.contentType, layoutVideo: video, storyVideo: video, retryForMs: uploader.SESSION_UPLOAD_PATIENCE_MS });
    if (ended) return;
    const url = `${location.origin}/d/${token}`;
    await QRCode.toCanvas($('qr'), url, { width: 136, margin: 1, color: { dark: '#294b34', light: '#fffef9' } });
    $('qr').hidden = false; const link = $<HTMLAnchorElement>('download'); link.href = url; link.hidden = false;
    $('status').textContent = 'Your QR is ready.';
    $('detail').textContent = `Photo confirmed in ${((Date.now() - started) / 1000).toFixed(1)} seconds. Videos continue through the bridge queue.`;
    if (fixedRun) { clearTimeout(timer); timer = setTimeout(endSession, scanWindowMs); }
    $('step-qr').classList.add('done'); qrReady = true; await log('QR shown after original uploader returned the token');
  } catch (err) {
    $('status').textContent = ended ? 'Late upload safely discarded.' : 'Upload did not complete.';
    $('detail').textContent = (err as Error).message; void log((err as Error).message);
  } finally { busy = false; input('start').disabled = false; if (!qrReady) clearTimeout(timer); }
};

async function refresh() {
  try {
    const s = await api('/lab/state');
    if (!s.run) return;
    if (started) $('elapsed').textContent = `${Math.floor((Date.now() - started) / 1000)}s elapsed`;
    $('queue-count').textContent = `${s.queue.length} waiting`;
    const items = $('queue-items'); items.replaceChildren();
    if (!s.queue.length) items.textContent = s.events.some(e => e.stage === 'bridge' && e.detail.includes('delivered')) ? 'All queued clips delivered.' : 'No pending videos.';
    for (const q of s.queue) {
      const el = document.createElement('div'); el.className = 'queue-entry';
      el.textContent = `${q.kind} · ${q.attempts} failed attempts${q.nextAttemptAt ? ' · next retry in ' + Math.max(0, Math.ceil((q.nextAttemptAt - Date.now()) / 1000)) + 's' : ' · waiting for worker'}${q.lastError ? ' · ' + q.lastError : ''}`;
      items.append(el);
    }
    $('network').textContent = `${s.run.cfg.kbps} KiB/s uplink · ${s.run.cfg.contention} KiB/s competing traffic · ${s.activeUploads} active transfers. Bridge ${s.workerRunning ? 'running' : 'stopped'}.`;
    const list = $('events'); list.replaceChildren();
    for (const e of s.events.slice(-100).reverse()) {
      const li = document.createElement('li');
      for (const [tag, value] of [['time', (e.elapsed / 1000).toFixed(1) + 's'], ['strong', e.stage], ['span', e.detail]]) { const el = document.createElement(tag); el.textContent = value; li.append(el); }
      list.append(li);
    }
    for (const [stage, id] of [['sign', 'sign'], ['put-done', 'put'], ['confirmed', 'confirm']]) if (s.events.some(e => e.stage === stage)) $('step-' + id).classList.add('done');
  } catch { $('network').textContent = 'Local server unavailable. Restart it to continue.'; }
}
if (location.pathname.startsWith('/d/')) {
  $('lab').hidden = true; $('viewer').hidden = false; const token = location.pathname.split('/')[2];
  const rendered = new Set<string>();
  const poll = async () => {
    try {
      const s = await api('/api/download/' + encodeURIComponent(token));
      const fields = [['photoKey', 'Photo'], ['layoutVideoKey', 'Layout video'], ['storyVideoKey', 'Story video']];
      $('viewer-status').textContent = s.layoutVideoKey && s.storyVideoKey ? 'Photo and both videos are ready.' : s.videosPending ? 'Photo is ready. Waiting for the video queue…' : 'Your photo is ready.';
      for (const [field, label] of fields) if (s[field] && !rendered.has(s[field])) {
        rendered.add(s[field]); const card = document.createElement('div'); card.className = 'asset';
        const url = '/lab/object?key=' + encodeURIComponent(s[field]);
        const media = document.createElement(field === 'photoKey' ? 'img' : 'video') as HTMLImageElement | HTMLVideoElement;
        media.src = url; if (media instanceof HTMLVideoElement) media.controls = true; else media.alt = 'Local test photo';
        const link = document.createElement('a'); link.href = url; link.download = s[field].split('/').pop(); link.textContent = 'Download ' + label.toLowerCase();
        card.append(media, link); $('assets').append(card);
      }
    } catch (e) { $('viewer-status').textContent = String(e); }
  };
  await poll(); setInterval(poll, 2000);
} else { await refresh(); setInterval(refresh, 1000); }
