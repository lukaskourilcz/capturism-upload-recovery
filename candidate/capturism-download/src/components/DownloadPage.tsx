import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { VideoBackground } from './VideoBackground'
import { PhotoCard } from './PhotoCard'
import { ActionMenu } from './ActionMenu'
import { ShareButtons } from './ShareButtons'
import { Logo } from './Logo'
import { readDownload } from '../lib/readDownload'

interface SessionData {
  /** Final print image — shown in the centre PhotoCard. */
  photoUrl?: string
  /** Full session video — used (blurred) as the page background. */
  videoUrl?: string
  /** Polished N-cell layout video — what the "Download the Video" button gives. */
  layoutVideoUrl?: string
  /** Pre-baked 1080×1920 Stories share output. */
  storyVideoUrl?: string
  /**
   * Attachment-disposition presigns (relay ≥ 2026-07-05). Same objects as
   * above, but the browser SAVES them instead of navigating and playing
   * them inline — the display URLs stay separate so the background video
   * and PhotoCard keep streaming normally. Fall back to the display URLs
   * when the relay hasn't been redeployed yet.
   */
  photoDownloadUrl?: string
  videoDownloadUrl?: string
  /** Relay says the booth is still uploading this session's video. */
  videoPending?: boolean
  date?: string
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? ''

function getTokenFromPath(): string | null {
  const match = window.location.pathname.match(/^\/d\/([A-Za-z0-9_-]+)\/?$/)
  return match ? match[1] : null
}

export function DownloadPage() {
  const [token] = useState(getTokenFromPath)
  const [session, setSession] = useState<SessionData>({})
  const [state, setState] = useState<LoadState>(() => !token ? 'idle' : RELAY_URL ? 'loading' : 'error')
  const [errorMessage, setErrorMessage] = useState<string>(() => token && !RELAY_URL ? 'Server not configured' : '')
  const [retryable, setRetryable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [pollStartedAt] = useState(Date.now)

  useEffect(() => {
    if (!token || !RELAY_URL) return
    const controller = new AbortController()

    // ── Wait for the video ──────────────────────────────────────────
    // The booth commits the PHOTO first so the QR works within seconds,
    // then uploads the video in the background. A customer who scanned
    // during that window used to get a photo-only page and walk away —
    // the video buttons only appeared if they happened to refresh, so
    // most people simply never saw their video (operator, 2026-09-28).
    //
    // Now: while the relay reports videoPending we re-fetch on a short
    // interval and the page fills itself in, with a visible "your video
    // is on its way" line so the customer knows to wait a moment.
    //
    // Bounded on purpose. If a video upload genuinely fails the booth
    // never re-commits, so we stop polling and settle on the photo-only
    // page rather than promising something that will never arrive.
    // Sessions that never had a video (Photo ID) never set the flag at
    // all, so they never poll.
    //
    // The relay is the authority on when to give up: it stops reporting
    // videoPending once the session is older than its own grace window, so
    // a customer who returns the next day gets a clean photo-only page
    // instead of a spinner. The limit here only exists so a misbehaving
    // relay can't keep us polling forever, which is why it sits just PAST
    // the relay's window rather than inside it — an earlier 3-minute limit
    // here cut polling off while the relay still said "pending", and the
    // spinner then span forever because nothing ever cleared the flag.
    // That is the bug a customer reported on 2026-10-05.
    // BACKOFF, not a flat 4s. This page used to fetch ONCE. The waiting
    // feature turned that into a poll every 4 seconds for up to 11
    // minutes — as many as 165 requests per customer against the same
    // Render instance that signs the booth's video uploads. When a video
    // failed, that page polled the full 11 minutes, which added load,
    // which made more uploads fail. The 502s and timeouts the booth
    // logged on 2026-10-14..18 are what that looks like from the kiosk.
    //
    // A video that is coming usually lands in the first few seconds, so
    // poll quickly at first and then back off hard. Same responsiveness
    // where it matters, roughly a sixth of the requests over the window.
    const POLL_FAST_MS = 4000
    const POLL_SLOW_MS = 20_000
    const POLL_FAST_UNTIL_MS = 40_000
    const POLL_LIMIT_MS = 11 * 60_000
    let pollTimer: number | undefined
    const load = () => readDownload<{
      photoUrl: string; videoUrl: string | null; layoutVideoUrl?: string | null; storyVideoUrl?: string | null
      photoDownloadUrl?: string | null; videoDownloadUrl?: string | null; videoPending?: boolean; date: string
    }>(`${RELAY_URL}/api/download/${encodeURIComponent(token)}`, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        setSession({
          photoUrl: data.photoUrl,
          videoUrl: data.videoUrl ?? undefined,
          layoutVideoUrl: data.layoutVideoUrl ?? undefined,
          storyVideoUrl: data.storyVideoUrl ?? undefined,
          photoDownloadUrl: data.photoDownloadUrl ?? undefined,
          videoDownloadUrl: data.videoDownloadUrl ?? undefined,
          videoPending: data.videoPending === true,
          date: data.date,
        })
        setState('ready')
        // Still uploading? Come back for it shortly.
        if (data.videoPending === true) {
          const elapsed = Date.now() - pollStartedAt
          if (elapsed < POLL_LIMIT_MS) {
            pollTimer = window.setTimeout(load, elapsed < POLL_FAST_UNTIL_MS ? POLL_FAST_MS : POLL_SLOW_MS)
          } else {
            // Giving up. Clear the flag we just set, or the "on its way"
            // spinner stays on screen with nothing left to resolve it —
            // a promise the page can no longer keep.
            setSession((prev) => ({ ...prev, videoPending: false }))
          }
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setRetryable(err.terminal !== true)
        setState('error')
        setErrorMessage(err.message || 'Something went wrong.')
      })

    load()

    return () => {
      controller.abort()
      if (pollTimer) window.clearTimeout(pollTimer)
    }
  }, [attempt, token, pollStartedAt])

  const formattedDate = session.date
    ? new Date(session.date).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : undefined

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <VideoBackground posterSrc={session.photoUrl} videoSrc={session.videoUrl} />

      <div style={{
        position: 'relative',
        zIndex: 3,
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        WebkitOverflowScrolling: 'touch',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.175, 0.885, 0.32, 1.1] }}
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '36px 24px 12px',
            flexShrink: 0,
          }}
        >
          <Logo width="18vw" color="#FFFFFF" />
        </motion.div>

        <div style={{ padding: '0 32px', flexShrink: 0 }}>
          <PhotoCard
            photoSrc={session.photoUrl}
            date={formattedDate}
          />
        </div>

        {state === 'loading' && (
          <div style={{
            textAlign: 'center',
            padding: '12px 24px 0',
            fontSize: '13px',
            color: 'rgba(255,255,255,0.45)',
            fontWeight: 300,
          }}>
            Loading your photos…
          </div>
        )}

        {state === 'error' && (
          <div role="alert" style={{
            textAlign: 'center',
            padding: '12px 24px 0',
            fontSize: '13px',
            color: 'rgba(255,180,180,0.7)',
            fontWeight: 300,
          }}>
            <p>{errorMessage}</p>
            {retryable && (
              <button type="button" onClick={() => {
                setState('loading')
                setRetryable(false)
                setAttempt(value => value + 1)
              }} style={{
                marginTop: '8px', padding: '10px 24px', borderRadius: '24px',
                border: '1px solid rgba(255,255,255,0.5)', background: 'transparent',
                color: '#FFFFFF', font: 'inherit', cursor: 'pointer',
              }}>
                Try again
              </button>
            )}
          </div>
        )}

        <div style={{
          padding: '16px 12px 0',
          flexShrink: 0,
        }}>
          <ActionMenu
            photoDownloadUrl={session.photoDownloadUrl || session.photoUrl}
            videoDownloadUrl={session.videoDownloadUrl || session.layoutVideoUrl || session.videoUrl}
            videoPending={session.videoPending}
          />
        </div>

        <div style={{
          padding: '8px 24px 0',
          flexShrink: 0,
        }}>
          <ShareButtons
            photoUrl={session.photoUrl}
            videoUrl={session.videoUrl}
            storyVideoUrl={session.storyVideoUrl}
          />
        </div>

        {/* ── Social CTA — tag-to-win prize for word-of-mouth marketing ──
            Sits above the copyright line. Discreet but legible. Same
            navigator.language FR/EN pattern as EmailPopup for now;
            Korean falls through to English. The IG handle is the real
            one (capturism.studio, with the period). */}
        <div style={{
          padding: '8px 24px 16px',
          flexShrink: 0,
          marginTop: 'auto',
          textAlign: 'center',
        }}>
          <a
            href="https://instagram.com/capturism.studio"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '10px 18px',
              borderRadius: '999px',
              background: 'rgba(255,255,255,0.08)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.85)',
              fontSize: '13px',
              fontWeight: 500,
              textDecoration: 'none',
              letterSpacing: '0.01em',
              transition: 'all 0.2s ease',
            }}
          >
            {typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr')
              ? <>Tague <strong>@capturism.studio</strong> dans ta story et gagne ta prochaine séance photo</>
              : <>Tag <strong>@capturism.studio</strong> in your story and win your next photoshoot</>}
          </a>
        </div>

        <div style={{
          padding: '0 24px 36px',
          flexShrink: 0,
          textAlign: 'center',
        }}>
          <span style={{
            fontSize: '11px',
            color: 'rgba(255,255,255,0.2)',
            fontWeight: 300,
          }}>
            &copy; 2026 by Capturism Studio. All rights reserved.
          </span>
        </div>
      </div>
    </div>
  )
}
