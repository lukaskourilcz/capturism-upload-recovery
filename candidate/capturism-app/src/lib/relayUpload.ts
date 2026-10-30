/**
 * Booth → Relay → R2 upload flow.
 *
 *   1. Ask the relay for a presigned PUT URL (relay returns token + key).
 *   2. PUT the bytes directly to R2 (bypasses the relay).
 *   3. Tell the relay the upload is committed so it stores the token → key
 *      mapping and admins get a `booth:photos_ready` notification.
 *
 * The phone QR encodes `${DOWNLOAD_BASE}/d/<token>`. The download page hits
 * `${RELAY_URL}/api/download/<token>` to get a signed GET URL.
 *
 * Resilience: every relay/R2 fetch is wrapped in fetchWithRetry — up to 3
 * attempts with exponential backoff (1s / 2s / 4s) and a 60s per-attempt
 * timeout. This is the single most-impactful change for the booth: Render's
 * free tier sleeps the relay after 15 min idle and cold-starts take 30-60s.
 * One retry past a transient timeout makes the whole pipeline survive that.
 *
 * Video uploads are wrapped in their OWN try/catch inside uploadSessionToCloud
 * so a flaky video can't kill the photo commit — the customer still gets a
 * working QR with at least their photo, even if the videos didn't make it.
 */
import { sendBoothError } from './boothRelay'
import { getSessionEpoch } from '../store/sessionStore'

// All booth-keyed traffic goes through the local bridge at /api/relay/*
// (Vite proxies that to localhost:3001). The bridge holds BOOTH_KEY in
// Node env so it's never bundled into the browser JS. See payment-bridge.js
// `forwardToRelay` and the relay-proxy block in start-payment-bridge.bat.
//
// cloudUploadConfigured is a probe of /api/relay/configured. It defaults to
// TRUE and only ever flips to false when the bridge ANSWERS and says the relay
// is not configured — i.e. a genuine configuration fault.
//
// It used to flip to false on ANY failure of this one-time check: a non-OK
// response, or the fetch throwing. The check runs once, when the page loads,
// and every upload effect gates on this flag, so a bridge that simply wasn't
// listening yet at that instant (boot order, the 07:00 restart, a bridge
// restart) disabled cloud upload for the ENTIRE life of the page: no photos,
// no QR, no videos, silently, until someone reloaded the browser. Same
// one-way-latch shape as the card terminal's simulator fallback.
//
// A transient failure now leaves the flag as it was. If uploads genuinely
// can't work, they fail loudly on the real request and raise an alert,
// which beats a silent skip.
export let cloudUploadConfigured = true

export function probeCloudUploadConfigured(): Promise<void> {
  return fetch('/api/relay/configured', { method: 'GET' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { configured?: boolean } | null) => {
      if (!data || typeof data.configured !== 'boolean') return // no real answer: change nothing
      cloudUploadConfigured = data.configured
      if (!cloudUploadConfigured) {
        console.warn('[UPLOAD] bridge reports relay not configured — set RELAY_URL/BOOTH_ID/BOOTH_KEY in start-payment-bridge.bat')
      }
    })
    .catch(() => {
      // Bridge unreachable right now. That says nothing about configuration.
    })
}

void probeCloudUploadConfigured()

interface SignUploadResponse {
  token: string
  key: string
  uploadUrl: string
}

/**
 * Wrap fetch with timeout + exponential-backoff retry. Treats 5xx and
 * network errors as retryable; 4xx is permanent (no point retrying a bad
 * payload or expired auth).
 *
 * Logs every attempt so the kiosk console makes the retry behaviour visible
 * — extremely useful for diagnosing "QR didn't appear" reports.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  { maxRetries = 3, timeoutMs = 60_000 } = {},
): Promise<Response> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      clearTimeout(timer)
      // 4xx is permanent — don't retry. 2xx is success. 5xx is retryable.
      if (res.ok) {
        if (attempt > 1) {
          console.log(`[UPLOAD] ${label}: succeeded on attempt ${attempt}`)
        }
        return res
      }
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => '')
        throw new Error(`${label} failed: ${res.status} ${body.slice(0, 200)}`)
      }
      // 5xx — fall through to retry
      lastErr = new Error(`${label} failed: ${res.status}`)
      console.warn(`[UPLOAD] ${label} attempt ${attempt}/${maxRetries} got ${res.status}`)
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      // If the error is the AbortController firing, we know it's a timeout.
      const msg = (err as Error).name === 'AbortError'
        ? `${label} timed out after ${timeoutMs}ms`
        : (err as Error).message || String(err)
      console.warn(`[UPLOAD] ${label} attempt ${attempt}/${maxRetries} threw: ${msg}`)
      // 4xx-style errors (already thrown above) propagate as-is and we
      // re-throw them without retrying.
      if (msg.includes('failed: 4')) throw err
    }
    if (attempt < maxRetries) {
      const backoffMs = 1_000 * Math.pow(2, attempt - 1) // 1s, 2s, 4s
      console.log(`[UPLOAD] ${label}: waiting ${backoffMs}ms before retry`)
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed after ${maxRetries} attempts`)
}

type AssetKind = 'photo' | 'video' | 'layout' | 'story'

/**
 * Ask the relay for a signed R2 PUT url.
 *
 * Passing the session's token (and the asset kind) puts every file of a
 * session at sessions/<token>/<kind>.<ext>. Before 2026-10 each call
 * minted its OWN random token, so a session's videos lived under
 * unrelated prefixes known only to this browser until the write-back
 * landed — and when it didn't, good files were orphaned in R2 forever.
 * With a derived key the relay can find them on its own.
 *
 * Omit `token` for the first (photo) upload; the relay mints it and
 * returns it, and every later call for the session passes it back.
 */
async function signUpload(
  contentType: string,
  token?: string,
  kind?: AssetKind,
): Promise<SignUploadResponse> {
  // maxRetries 5, not the default 3. The default gives up after ~7 s
  // (1 s + 2 s of backoff), which is far too impatient for a free-tier
  // relay: a transient 502 lasting ten seconds permanently cost a
  // customer their video on 2026-10-14. Five attempts ride out roughly
  // 30 s of backoff, and the only cost of waiting is that the video
  // appears a few seconds later on a page that is already polling for it.
  const res = await fetchWithRetry(`/api/relay/sign-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType, token, kind }),
  }, 'sign-upload', { maxRetries: 5 })
  return res.json()
}

async function putToR2(uploadUrl: string, blob: Blob, contentType: string): Promise<void> {
  // R2 PUT can be large (multi-MB video) — give it 2 minutes per attempt.
  // Size + elapsed are logged on every PUT: the booth's uplink is the
  // bottleneck that decides whether the QR appears, and "photo PUT was
  // 14 MB and took 118 s" in the console is what turns a "capricious QR"
  // report into a diagnosable number.
  const sizeKb = Math.round(blob.size / 1024)
  const t0 = Date.now()
  await fetchWithRetry(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  }, `R2 PUT (${sizeKb} KB ${contentType})`, { timeoutMs: 120_000 })
  console.log(`[UPLOAD] R2 PUT done: ${sizeKb} KB ${contentType} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

/**
 * Convert a rasterized card (PNG data URL) into the blob that gets
 * uploaded to R2 for the customer's download page.
 *
 * Why JPEG: since the R100 landed, the print-card PNGs rasterize at
 * 10-14 MB. The QR token only renders after the PHOTO PUT commits, and
 * on the booth's uplink a 14 MB PUT straddles the 120 s timeout — some
 * sessions squeak under, some don't, which presented as "the QR is
 * capricious". A quality-0.9 JPEG of the same card is ~10× smaller and
 * commits in seconds. The physical print and the video-bake keep using
 * the original PNG bytes — only the upload copy is transcoded.
 *
 * Why the white underlay: the NULL_PAPER "no colour" option rasterizes
 * with a transparent background, and JPEG has no alpha — without the
 * fill, transparent pixels would turn BLACK on the download page. White
 * matches what the physical print does on white DNP paper.
 *
 * Falls back to the original PNG on any transcode failure — a slow
 * upload that usually works beats no upload at all.
 */
export async function photoBlobForUpload(
  dataUrl: string,
  quality = 0.9,
): Promise<{ blob: Blob; contentType: string }> {
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('failed to decode card image'))
      img.src = dataUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.fillStyle = '#FDFDFD'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    if (!blob) throw new Error('canvas.toBlob returned null')
    return { blob, contentType: 'image/jpeg' }
  } catch (err) {
    console.warn('[UPLOAD] JPEG transcode failed — uploading original PNG:', (err as Error).message)
    return { blob: dataUrlToBlob(dataUrl), contentType: 'image/png' }
  }
}

async function commitPhotosReady(
  token: string,
  photoKey: string,
  videoKey?: string,
  layoutVideoKey?: string,
  storyVideoKey?: string,
  /**
   * True on the FIRST (photo-only) commit when video uploads are about to
   * run in the background. The download page uses it to tell "the video is
   * still being prepared" apart from "this session will never have one"
   * (Photo ID, for instance, uploads no video at all) — so it knows
   * whether to wait, instead of silently showing a photo-only page the
   * customer walks away from. Omitted on the re-commit, which by then
   * carries the real keys.
   */
  videosPending?: boolean,
): Promise<void> {
  await fetchWithRetry(`/api/relay/photos-ready`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, photoKey, videoKey, layoutVideoKey, storyVideoKey, videosPending }),
  }, 'photos-ready', { maxRetries: 5 })
}

/**
 * Helper — signs a video upload + PUTs the bytes. Returns the R2 key the
 * relay should record (or undefined if the input was empty / threw).
 *
 * Errors are swallowed and logged — a flaky video upload should not block
 * the photo commit. Worst case the customer's QR works for the photo and
 * the video buttons are missing on the download page.
 */
/**
 * Hand a finished video to the BRIDGE and return. That is the whole job.
 *
 * The kiosk used to upload videos to R2 itself, during the session. That
 * tied a customer's video to the booth's internet being healthy in the
 * seconds after their shoot, and to this browser tab outliving the
 * transfer. Between 2026-10-04 and 2026-10-18 customers lost videos to a
 * relay 502, to "Failed to fetch", and to request timeouts — permanently
 * each time, because the blob lived only in memory and was dropped the
 * moment an attempt failed. Retrying harder in the browser only widened
 * the window; it never closed it.
 *
 * This call goes to localhost:3001, so it cannot fail for network
 * reasons. The bridge writes the bytes to disk and delivers them on its
 * own schedule — through outages, relay downtime, a closed browser and PC
 * restarts (see video-queue.js). From here, delivery is no longer the
 * customer's problem or this tab's.
 *
 * Returns nothing: the key is assigned by the bridge when it uploads, and
 * the relay is told then. The download page keeps polling and fills in.
 */
async function queueVideoWithBridge(
  blob: Blob | undefined,
  fallbackType: string,
  label: string,
  token: string,
  kind: Exclude<AssetKind, 'photo'>,
  photoKey: string,
): Promise<void> {
  if (!blob) return
  const ct = stripMimeParams(blob.type || fallbackType)
  const qs = new URLSearchParams({ token, kind, contentType: ct, photoKey })
  try {
    const res = await fetchWithRetry(`/api/video-queue?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': ct },
      body: blob,
    }, `queue ${label}`, { maxRetries: 3, timeoutMs: 120_000 })
    const body = await res.json().catch(() => ({}))
    console.log(`[UPLOAD] ${label} handed to the bridge (${Math.round((body.bytes ?? blob.size) / 1024)} KB) — it will deliver it`)
  } catch (err) {
    // Only reachable if the BRIDGE itself is down, which is a booth
    // problem, not a network one — and one the operator must hear about.
    console.warn(`[UPLOAD] ${label} could not be handed to the bridge:`, (err as Error).message)
    void sendBoothError({
      code: 'video_upload_failed',
      severity: 'warning',
      message: `A customer's ${label} could not be handed to the bridge for delivery — the bridge may be down. ${(err as Error).message}`,
    })
  }
}

/** How long a background flow keeps retrying a photo upload. Matched to the
 *  relay's VIDEO_PENDING_GRACE_MS: the session ends well before this anyway. */
export const SESSION_UPLOAD_PATIENCE_MS = 10 * 60_000

const SESSION_ENDED_MSG =
  'session ended before the upload finished — token discarded so it cannot ' +
  "leak into the next customer's session"

/** 4xx responses that retrying cannot fix. 403 is deliberately NOT here: an
 *  expired signed URL answers 403, and the next attempt signs a fresh one. */
const PERMANENT_FAILURE = /failed: (400|401|404|405|413|415|422)\b/

/**
 * Sign, PUT and commit the photo — and, if retryForMs allows, do it again
 * after a failure instead of giving up.
 *
 * Before this, a failed photo upload was final for the session. The screens
 * set an "already tried" flag BEFORE the attempt and never cleared it on
 * failure, so nothing retried: the customer's QR stayed on "preparing"
 * forever, no alert went out, and the owner found out by counting folders in
 * Cloudflare (4 sessions, 2 folders, 2026-10-21).
 *
 * Every retry re-signs, so an expired URL cannot doom the attempts that
 * follow. After the first successful sign the SAME token is reused, so a
 * retry rewrites the same sessions/<token>/photo.jpg instead of leaving an
 * orphaned folder per attempt. A retry stops the moment the session ends.
 */
async function uploadPhotoWithRetry(args: {
  photo: Blob
  photoCt: string
  willHaveVideos: boolean
  retryForMs: number
  epoch: number
}): Promise<SignUploadResponse> {
  const deadline = Date.now() + args.retryForMs
  let token: string | undefined
  let uploaded: SignUploadResponse | undefined
  let attempt = 0
  for (;;) {
    attempt += 1
    if (getSessionEpoch() !== args.epoch) throw new Error(SESSION_ENDED_MSG)
    try {
      // A failed confirmation does not mean the PUT failed. Keep the
      // completed upload and retry its registration without saturating
      // the booth uplink again. Failed PUTs still get fresh signed URLs.
      if (!uploaded) {
        const signed = await signUpload(args.photoCt, token, 'photo')
        token = signed.token
        await putToR2(signed.uploadUrl, args.photo, args.photoCt)
        uploaded = signed
      }
      await commitPhotosReady(uploaded.token, uploaded.key, undefined, undefined, undefined, args.willHaveVideos)
      if (attempt > 1) console.log(`[UPLOAD] photo landed on attempt ${attempt}`)
      return uploaded
    } catch (err) {
      const msg = (err as Error).message
      const waitMs = Math.min(30_000, 2_000 * attempt)
      if (PERMANENT_FAILURE.test(msg) || Date.now() + waitMs >= deadline) throw err
      console.warn(`[UPLOAD] photo attempt ${attempt} failed (${msg}) — retrying in ${Math.round(waitMs / 1000)}s`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

/**
 * Uploads the customer's photo + 0–3 supporting videos to R2 and registers
 * a download session with the relay. Returns the token to embed in the QR.
 *
 *   • photo         — required, the final print image
 *   • video         — optional, full session recording (download page bg)
 *   • layoutVideo   — optional, polished N-cell layout (Download Video button)
 *   • storyVideo    — optional, pre-baked Stories share output
 *
 * **Commit-first architecture** (this is the change that made the QR
 * reliable in the booth). We do the photo upload + commit FIRST, then
 * return the token IMMEDIATELY so `setCloudToken` can fire and the QR
 * renders with a real /d/<token> URL — typically ~2 seconds total. Video
 * uploads run in the BACKGROUND after the return; a second commit re-
 * stores the session entry with the video keys when they finish.
 *
 * Why: the previous "wait for everything, then commit" pattern meant a
 * single slow / hung video upload could delay the commit past the
 * printing screen's 18 s auto-advance to /bye — at which point the QR
 * rendered tokenless and the customer landed on a blank download page.
 * Now the photo commit lands before /bye is even shown, and a flaky
 * video can no longer stop the customer from getting a working URL.
 *
 * Trade-off: if the customer opens the download URL in the brief window
 * between photo commit and video commit, they see the photo but no
 * video buttons. The relay's `storeSession` overwrites by token so the
 * second commit just updates the same session entry — refresh and the
 * video buttons appear.
 */
export async function uploadSessionToCloud(opts: {
  photo: Blob
  photoContentType?: string
  video?: Blob
  videoContentType?: string
  layoutVideo?: Blob
  storyVideo?: Blob
  /**
   * Keep retrying the PHOTO upload, with backoff, for up to this long.
   * Default 0 = one attempt, as before.
   *
   * Opt-in because callers differ: the background flows (Calendar, Photo,
   * l'INCONNU) can wait out a network blip without anyone noticing,
   * but the legacy Photo-ID fallback AWAITS this call before capturing the
   * customer's payment, and must not be held up for minutes. Use
   * SESSION_UPLOAD_PATIENCE_MS from a flow that runs in the background.
   */
  retryForMs?: number
}): Promise<string> {
  if (!cloudUploadConfigured) {
    throw new Error('Cloud upload not configured — bridge says RELAY_URL/BOOTH_ID/BOOTH_KEY are unset')
  }

  console.log('[UPLOAD] Starting upload session')
  const t0 = Date.now()
  // Which customer's session is this upload FOR? Captured now, checked
  // after the photo commits. See the guard below for why.
  const epochAtStart = getSessionEpoch()

  // Photo first — its token becomes the session token everyone uses.
  // The relay's allow-list checks bare MIME types ("video/webm" etc.), so
  // strip any "; codecs=…" parameters MediaRecorder appends.
  const photoCt = stripMimeParams(opts.photoContentType || opts.photo.type || 'image/png')
  // Flag whether videos are on their way, so a customer who scans the QR
  // during the upload window is told to wait rather than shown a
  // photo-only page.
  // Only the COMPOSED videos count. The raw session recording is not delivered
  // (see below), so it must not make the download page promise a video.
  const willHaveVideos = !!(opts.layoutVideo || opts.storyVideo)
  const photoSigned = await uploadPhotoWithRetry({
    photo: opts.photo,
    photoCt,
    willHaveVideos,
    retryForMs: opts.retryForMs ?? 0,
    epoch: epochAtStart,
  })
  console.log(`[UPLOAD] ✅ Photo committed in ${((Date.now() - t0) / 1000).toFixed(1)}s — token=${photoSigned.token} (videos uploading in background)`)

  // THE GUARD. This upload can take minutes on a slow uplink, so it can
  // finish AFTER its customer has gone and the session has been reset —
  // even after the NEXT customer has started. Every caller then does
  // setCloudToken(token), which wrote the departed customer's token into
  // the store. The print screen's upload effect begins
  // `if (cloudToken) return`, so the next customer's photos were never
  // uploaded at all, and their QR opened the PREVIOUS customer's photos.
  // A real customer received strangers' photos this way (2026-10).
  //
  // So: if the session was reset while we were working, refuse to hand the
  // token back. Every caller already catches and logs. The departed
  // customer loses nothing — their QR could only appear on a Bye page that
  // no longer exists.
  if (getSessionEpoch() !== epochAtStart) {
    throw new Error(SESSION_ENDED_MSG)
  }

  // Hand the videos to the bridge and move on. No awaiting, no retry
  // bookkeeping, no commit chain here any more — the bridge owns delivery
  // from this point, including telling the relay. See video-queue.js for
  // why that moved: a browser tab is the worst possible owner of a file
  // that must survive an internet outage.
  //
  // The raw FULL-SESSION recording (opts.video) is deliberately NOT sent. It is
  // tens of MB, it can never cross the booth's ~1 Mbit/s uplink inside one
  // PUT timeout, and customers have never seen it: the Download Video button
  // uses the composed layout video and the page background is the blurred
  // photo. Queueing it made the bridge retry it all day and saturate the line,
  // so no customer photo could finish uploading - no QR (2026-10-28).
  if (opts.layoutVideo || opts.storyVideo) {
    void Promise.all([
      queueVideoWithBridge(opts.layoutVideo, 'video/mp4', 'layout video', photoSigned.token, 'layout', photoSigned.key),
      queueVideoWithBridge(opts.storyVideo, 'video/mp4', 'story video', photoSigned.token, 'story', photoSigned.key),
    ]).then(() => {
      console.log(`[UPLOAD] all videos handed to the bridge in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    })
  }

  return photoSigned.token
}

/**
 * Ping the relay's /api/health endpoint so Render doesn't cold-sleep the
 * dyno between customers. Render free tier idles the service after ~15 min
 * of no requests, and the cold-start to wake it can take 30-60s — long
 * enough for the kiosk's upload fetch to time out and the customer's QR
 * to land empty. Fire-and-forget: errors are logged but don't matter.
 *
 * Call from a setInterval on app mount (every 10 min is plenty).
 */
export async function pingRelay(): Promise<void> {
  try {
    const res = await fetch(`/api/relay/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    })
    console.log(`[UPLOAD] keep-warm ping: ${res.status}`)
  } catch (err) {
    console.warn('[UPLOAD] keep-warm ping failed:', (err as Error).message)
  }
}

function stripMimeParams(mime: string): string {
  return mime.split(';')[0].trim()
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(',')
  const mimeMatch = meta.match(/data:([^;]+)/)
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream'
  const bytes = atob(b64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
