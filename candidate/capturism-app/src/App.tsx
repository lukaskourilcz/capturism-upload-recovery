import { startPageDiagnostics } from './lib/diagnostics'
import { useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { HomePage } from './components/screens/HomePage'
import { TypeSelection } from './components/screens/TypeSelection'
import { FrameSelection } from './components/screens/FrameSelection'
import { BackgroundSelection } from './components/screens/BackgroundSelection'
import { PhotoPrintSize } from './components/screens/PhotoPrintSize'
import { PhotoIdBackground } from './components/screens/PhotoIdBackground'
import { PhotoIdVisaSize } from './components/screens/PhotoIdVisaSize'
import PhotoIdCamera from './components/screens/PhotoIdCamera'
import PhotoIdInstructions from './components/screens/PhotoIdInstructions'
import PhotoIdSelectPrint from './components/screens/PhotoIdSelectPrint'
import PhotoIdPrinting from './components/screens/PhotoIdPrinting'
import PrintCount from './components/screens/PrintCount'
import LInconnuCodeEntry from './components/screens/LInconnuCodeEntry'
import LInconnuConfirm from './components/screens/LInconnuConfirm'
import PaymentMode from './components/screens/PaymentMode'
import PaymentProcessing from './components/screens/PaymentProcessing'
import LightingAdjust from './components/screens/LightingAdjust'
import CameraCapture from './components/screens/CameraCapture'
import PhotoChoice from './components/screens/PhotoChoice'
import BackgroundFilterPreview from './components/screens/BackgroundFilterPreview'
import Printing from './components/screens/Printing'
import ByePage from './components/screens/ByePage'
import { connectBoothRelay } from './lib/boothRelay'
import { pingRelay } from './lib/relayUpload'
import { primeCountdownAudio } from './lib/countdownBeep'
import { useSessionStore } from './store/sessionStore'
import { API_BASE } from './lib/apiBase'
import { acquireDigicamLiveView, releaseDigicamLiveView } from './lib/digicamLiveView'
import { acquireCamera, releaseCamera } from './lib/sharedCamera'

/**
 * Source of the always-on ambient background feed that gives the
 * liquid-glass cards live content to refract.
 *
 *   'webcam' — system webcam via getUserMedia (the booth's Logitech
 *              c920). DEFAULT — the booth has a dedicated ambient
 *              webcam, so this just works after a git pull with no
 *              .env edit. Shares one camera stream with the shoot
 *              preview via lib/sharedCamera.
 *   'off'    — no ambient feed; glass cards refract a static color.
 *              Set VITE_AMBIENT_BG_SOURCE=off to use this.
 *   'dslr'   — refcount-acquire the DSLR's HDMI live view. Legacy;
 *              left available for fallback.
 *
 * Override via VITE_AMBIENT_BG_SOURCE in capturism-app/.env.
 */
const AMBIENT_BG_SOURCE = (
  (import.meta.env.VITE_AMBIENT_BG_SOURCE as string | undefined) || 'webcam'
) as 'off' | 'webcam' | 'dslr'

const pageVariants = {
  initial: { opacity: 0, x: 30 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -30 },
}

const pageTransition = {
  duration: 0.25,
  ease: [0.175, 0.885, 0.32, 1.275] as [number, number, number, number],
}

function AnimatedPage({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={pageTransition}
      style={{ position: 'absolute', inset: 0 }}
    >
      {children}
    </motion.div>
  )
}

function BoothLayout() {
  const location = useLocation()
  const bgVideoRef = useRef<HTMLVideoElement>(null)
  const [bgReady, setBgReady] = useState(false)

  // Enter fullscreen on first user interaction
  useEffect(() => {
    const enterFullscreen = () => {
      document.documentElement.requestFullscreen?.().catch(() => {})
    }
    const handler = () => {
      enterFullscreen()
      document.removeEventListener('click', handler)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  // Optional always-on ambient feed behind every screen, so the
  // liquid-glass cards have moving content to refract. Source is
  // configured via VITE_AMBIENT_BG_SOURCE (see top of file). Default
  // 'off' on the production kiosk — the DSLR is left alone except
  // during shoots, glass cards refract a static color.
  useEffect(() => {
    if (AMBIENT_BG_SOURCE === 'off') return
    const video = bgVideoRef.current
    if (!video) return
    let cancelled = false
    let acquiredCamera = false
    let acquiredDigicam = false

    if (AMBIENT_BG_SOURCE === 'webcam') {
      // Go through the shared-camera module — the camera-capture screen
      // also wants the c920, and a USB webcam can only be opened once.
      // acquireCamera() always increments the refcount, so EVERY path
      // out of here releases exactly once.
      acquireCamera().then((stream) => {
        if (cancelled || !stream) {
          releaseCamera()
          return
        }
        acquiredCamera = true
        video.srcObject = stream
        video.play().catch(() => {})
        setBgReady(true)
      })
    } else if (AMBIENT_BG_SOURCE === 'dslr') {
      acquireDigicamLiveView(API_BASE).then((res) => {
        if (cancelled) {
          if (res) releaseDigicamLiveView()
          return
        }
        if (!res) {
          console.warn('[booth] ambient bg requested DSLR but bridge has no camera')
          return
        }
        acquiredDigicam = true
        video.srcObject = res.stream
        video.play().catch(() => {})
        setBgReady(true)
      })
    }

    return () => {
      cancelled = true
      if (acquiredCamera) releaseCamera()
      if (acquiredDigicam) releaseDigicamLiveView()
    }
  }, [])

  // Auto-scale the 1920×1080 frame to fit the viewport while keeping aspect ratio.
  useEffect(() => {
    const apply = () => {
      const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
      document.documentElement.style.setProperty('--booth-scale', String(s))
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: '#797A7C', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '1920px', height: '1080px', position: 'relative', transform: 'scale(var(--booth-scale, 1))', transformOrigin: 'center center', flexShrink: 0 }}>
      {/* Live webcam feed — sits behind every screen so liquid-glass cards
          have moving content underneath to refract / blur. */}
      <video
        ref={bgVideoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          // scaleX(-1) mirrors selfie-style (a mirrored ambient feed reads
          // naturally, like a mirror in the room). The extra rotate(180deg)
          // is a WEBCAM-mount correction only — the c920 was to be mounted
          // physically upside-down. The DSLR pipeline delivers frames
          // already upright (VITE_DIGICAM_ROTATE_DEG in digicamLiveView),
          // so applying the 180° here flipped the dslr background upside
          // down (Mabillon, 2026-07-22).
          transform: AMBIENT_BG_SOURCE === 'webcam' ? 'scaleX(-1) rotate(180deg)' : 'scaleX(-1)',
          opacity: bgReady ? 1 : 0,
          transition: 'opacity 0.6s ease',
          zIndex: 0,
        }}
      />
      {/* Ambient scrim — a soft vertical darkening between the live webcam
          (zIndex 0) and the UI (zIndex 1). Without this, midday booth
          lighting + white walls + light-coloured customer clothing make the
          webcam feed so bright that white glass tint + white text dissolve
          into the background and customers can't read the buttons. Only the
          type-selection cards survive bare because each has its own internal
          grey artwork swatch acting as a contrast anchor. The scrim gives
          every screen the same baseline. pointerEvents:none so it never
          eats taps. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.32) 100%)',
          zIndex: 0,
          pointerEvents: 'none',
        }}
      />
      <div style={{ position: 'relative', width: '100%', height: '100%', zIndex: 1 }}>
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<AnimatedPage><HomePage /></AnimatedPage>} />
          <Route path="/type-selection" element={<AnimatedPage><TypeSelection /></AnimatedPage>} />
          <Route path="/frame-selection" element={<AnimatedPage><FrameSelection /></AnimatedPage>} />
          <Route path="/background-selection" element={<AnimatedPage><BackgroundSelection /></AnimatedPage>} />
          <Route path="/print-size" element={<AnimatedPage><PhotoPrintSize /></AnimatedPage>} />
          <Route path="/photo-id-background" element={<AnimatedPage><PhotoIdBackground /></AnimatedPage>} />
          <Route path="/photo-id-visa-size" element={<AnimatedPage><PhotoIdVisaSize /></AnimatedPage>} />
          <Route path="/photo-id-instructions" element={<AnimatedPage><PhotoIdInstructions /></AnimatedPage>} />
          <Route path="/photo-id-camera" element={<AnimatedPage><PhotoIdCamera /></AnimatedPage>} />
          <Route path="/photo-id-select" element={<AnimatedPage><PhotoIdSelectPrint /></AnimatedPage>} />
          <Route path="/photo-id-printing" element={<AnimatedPage><PhotoIdPrinting /></AnimatedPage>} />
          <Route path="/print-count" element={<AnimatedPage><PrintCount /></AnimatedPage>} />
          <Route path="/linconnu-code" element={<AnimatedPage><LInconnuCodeEntry /></AnimatedPage>} />
          <Route path="/linconnu-confirm" element={<AnimatedPage><LInconnuConfirm /></AnimatedPage>} />
          <Route path="/payment" element={<AnimatedPage><PaymentMode /></AnimatedPage>} />
          <Route path="/payment-processing" element={<AnimatedPage><PaymentProcessing /></AnimatedPage>} />
          <Route path="/lighting" element={<AnimatedPage><LightingAdjust /></AnimatedPage>} />
          <Route path="/camera" element={<AnimatedPage><CameraCapture /></AnimatedPage>} />
          <Route path="/photo-choice" element={<AnimatedPage><PhotoChoice /></AnimatedPage>} />
          <Route path="/preview" element={<AnimatedPage><BackgroundFilterPreview /></AnimatedPage>} />
          <Route path="/printing" element={<AnimatedPage><Printing /></AnimatedPage>} />
          <Route path="/bye" element={<AnimatedPage><ByePage /></AnimatedPage>} />
          {/* Catch-all: any address that is not a booth screen goes HOME. There
              was none, so an unknown route (a stale bookmark, a screen we
              retired like the THEOS size page) rendered a blank grey screen
              with nothing on it and no way forward on a touch-only kiosk.
              Home also resets the session, so it is always a safe landing. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AnimatePresence>
      </div>
      </div>
    </div>
  )
}

function App() {
  const navigate = useNavigate()
  const location = useLocation()

  // Stale-session sweep: if Zustand persist rehydrated a session whose
  // sessionStartedAt is older than the idle threshold, wipe everything
  // and force the kiosk back to HomePage. Handles cases where someone
  // refreshes mid-flow or the kiosk reboots during a session — without
  // this, the next customer would land mid-flow on the previous
  // customer's selections.
  //
  // Runs once on mount only; per-screen PageHeader timers handle the
  // shorter-window "customer walked away mid-session" cases.
  useEffect(() => {
    const STALE_MS = 10 * 60 * 1000 // 10 minutes
    const { sessionStartedAt, reset } = useSessionStore.getState()
    if (sessionStartedAt && Date.now() - sessionStartedAt > STALE_MS) {
      const ageMin = Math.round((Date.now() - sessionStartedAt) / 60_000)
      console.log(`[SESSION] stale session detected (${ageMin} min old) — resetting`)
      reset()
      if (location.pathname !== '/') {
        navigate('/', { replace: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open the booth ↔ relay WebSocket on first mount. The client itself is a
  // singleton with reconnect logic, so it's safe to call on every mount —
  // subsequent calls are no-ops.
  useEffect(() => {
    connectBoothRelay()
    return startPageDiagnostics()
  }, [])

  // Keep-warm: ping the relay's /api/health every 10 minutes so Render's
  // free-tier dyno never cold-sleeps between customers. Cold starts can take
  // 30-60s, long enough for the upload pipeline's fetch to time out before
  // the relay wakes — which is the most common reason customer QR codes have
  // been arriving blank (the upload effect throws, cloudToken stays null,
  // the QR encodes the bare download domain). Fire once immediately so we
  // warm up the moment the booth boots, then every 10 min on a timer.
  useEffect(() => {
    pingRelay()
    const id = window.setInterval(pingRelay, 10 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [])

  // Unlock the Web Audio context on the FIRST user touch, globally.
  // The countdown beeps + shutter sound are first triggered from a
  // setInterval callback (the countdown tick), NOT from a user gesture —
  // and browsers park a freshly-created AudioContext in 'suspended'
  // state until a gesture resumes it. Creating/resuming it here, on the
  // customer's first tap (language select / any screen), guarantees the
  // context is running by the time the countdown fires, so the beeps and
  // shutter are actually audible. One-shot: removes itself after firing.
  useEffect(() => {
    const unlock = () => {
      primeCountdownAudio()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('touchstart', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('touchstart', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('touchstart', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  return (
    <Routes>
      {/* All booth screens */}
      <Route path="/*" element={<BoothLayout />} />
    </Routes>
  )
}

export default App
