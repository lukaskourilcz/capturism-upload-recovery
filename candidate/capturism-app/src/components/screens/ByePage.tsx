import { useEffect, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { DownloadQR } from '../DownloadQR'
import { getSessionEpoch, useSessionStore } from '../../store/sessionStore'
import { PageHeader } from '../layout/PageHeader'
import { FigmaGlassCard } from '../glass/FigmaGlassCard'
import { SessionVideoBackground } from '../layout/SessionVideoBackground'
import { clearSessionVideo } from '../../lib/sessionVideo'
import { applyPresetWithRetry } from '../../lib/lightsClient'
import { qrInactivityDelay } from '../../lib/qrWaitPolicy'
import { expireQrUpload, getQrUploadState, retryQrUpload, subscribeQrUpload } from '../../lib/qrUploadState'

// Frame: 1920×1080. Centered glass panel (868×620 at left:526, top:277)
// holds the thank-you message, share prompt, QR code, and restart button.

const PANEL = { x: 526, y: 277, w: 868, h: 620, radius: 100 }

// 5 minutes of inactivity before the kiosk auto-returns home. The previous
// 25s was too aggressive — customers couldn't scan their QR code in time.
// Any touch / tap on the page resets this timer (see effect below) so a
// customer slowly reading instructions isn't kicked off mid-action.
const AUTO_RESET_MS = 5 * 60 * 1000  // 300_000

export default function ByePage() {
  const navigate = useNavigate()
  const reset = useSessionStore((s) => s.reset)
  const language = useSessionStore((s) => s.language)
  const cloudToken = useSessionStore((s) => s.cloudToken)
  const setCloudToken = useSessionStore((s) => s.setCloudToken)
  const upload = useSyncExternalStore(subscribeQrUpload, getQrUploadState)
  const failed = upload.phase === 'failed' && !cloudToken
  const shootType = useSessionStore((s) => s.shootType)
  const wantsQrCode = useSessionStore((s) => s.wantsQrCode)
  const isPhotoId = shootType === 'photo_id'

  useEffect(() => {
    if (upload.phase === 'ready' && upload.token && upload.epoch === getSessionEpoch()) setCloudToken(upload.token)
  }, [upload, setCloudToken])

  // Session is over — kill the studio lights so the booth goes back to
  // its idle "dark" state until the next customer reaches LightingAdjust
  // (or PhotoIdInstructions).
  useEffect(() => {
    // Retry variant: lights stuck ON after a failed one-shot 'off' would
    // cook the booth until the next session — worth the ~10 s of retries.
    applyPresetWithRetry('off')
  }, [])

  // Touch cannot extend a pending upload's absolute deadline. Expiry shows
  // recovery rather than immediately discarding the customer's session.
  // Ready/failed states get five minutes to scan/retry before privacy reset.
  useEffect(() => {
    let timerId: number | null = null
    const pending = wantsQrCode && !cloudToken && !failed
    const pendingDeadline = upload.deadlineAt ?? Date.now() + 10 * 60_000

    const goHome = () => {
      // Drop the recorded session video so the next customer doesn't
      // accidentally see the previous person's footage as a backdrop.
      clearSessionVideo()
      reset()
      navigate('/')
    }
    const arm = () => {
      if (timerId !== null) window.clearTimeout(timerId)
      timerId = window.setTimeout(pending ? expireQrUpload : goHome, qrInactivityDelay({
        needsQr: wantsQrCode, hasToken: !!cloudToken, failed, deadlineAt: pendingDeadline, scanWindowMs: AUTO_RESET_MS,
      }))
    }

    arm()
    window.addEventListener('pointerdown', arm, { passive: true })
    window.addEventListener('keydown', arm)

    return () => {
      if (timerId !== null) window.clearTimeout(timerId)
      window.removeEventListener('pointerdown', arm)
      window.removeEventListener('keydown', arm)
    }
  }, [navigate, reset, wantsQrCode, cloudToken, failed, upload.deadlineAt])

  const handleRestart = () => {
    clearSessionVideo()
    reset()
    navigate('/')
  }

  // NB: we deliberately DON'T build a bare-domain fallback URL here.
  // Encoding `${DOWNLOAD_BASE}` (no /d/<token>) produced a scannable QR
  // that landed the customer on an EMPTY download page — the reported
  // Photo ID bug. The DownloadQR component below shows a "preparing"
  // placeholder until cloudToken arrives, then swaps in the real
  // /d/<token> QR (reactively — so a late upload still lights it up).

  const labels = {
    fr: {
      thanks: 'MERCI !',
      enjoy: 'PROFITEZ DE VOS PHOTOS',
      shareTitle: 'PARTAGEZ VOTRE MOMENT',
      shareBody: 'IDENTIFIEZ @CAPTURISM.STUDIO SUR RÉSEAUX SOCIAUX\nPOUR GAGNER UNE SÉANCE GRATUITE',
      handle: '@CAPTURISM.STUDIO',
      digital: 'RECEVEZ VOS PHOTOS EN NUMÉRIQUE',
      scan: 'SCANNEZ POUR TÉLÉCHARGER SUR VOTRE TÉLÉPHONE',
      restart: 'RECOMMENCER',
      retry: 'RÉESSAYER LE QR',
      help: 'DEMANDEZ DE L’AIDE',
      timeout: 'La connexion prend trop de temps. Réessayez pour obtenir votre QR.',
      failed: 'Le téléchargement n’a pas abouti. Réessayez ou demandez de l’aide à l’équipe.',
      preparation: 'Vos photos numériques n’ont pas pu être préparées. Demandez de l’aide à l’équipe.',
    },
    en: {
      thanks: 'THANK YOU!',
      enjoy: 'ENJOY YOUR PHOTOS',
      shareTitle: 'SHARE YOUR MOMENT',
      shareBody: 'TAG @CAPTURISM.STUDIO ON SOCIAL MEDIA\nTO WIN A FREE SESSION',
      handle: '@CAPTURISM.STUDIO',
      digital: 'GET YOUR PHOTOS DIGITALLY',
      scan: 'SCAN TO DOWNLOAD ON YOUR PHONE',
      restart: 'START OVER',
      retry: 'RETRY DOWNLOAD',
      help: 'ASK THE STUDIO',
      timeout: 'The connection is taking too long. Try again to get your QR.',
      failed: 'The download could not be prepared. Try again or ask the studio team.',
      preparation: 'Your digital photos could not be prepared. Please ask the studio team.',
    },
    ko: {
      thanks: '감사합니다!',
      enjoy: '사진을 즐기세요',
      shareTitle: '여러분의 순간을 공유하세요',
      shareBody: '@CAPTURISM.STUDIO를 SNS에 태그하고\n무료 세션의 기회를 잡으세요',
      handle: '@CAPTURISM.STUDIO',
      digital: '디지털 사진 받기',
      scan: '휴대폰으로 다운로드하려면 스캔하세요',
      restart: '다시 시작',
      retry: '다운로드 재시도',
      help: '직원에게 문의',
      timeout: '연결이 너무 오래 걸립니다. QR 코드를 받으려면 다시 시도하세요.',
      failed: '다운로드를 준비하지 못했습니다. 다시 시도하거나 직원에게 문의하세요.',
      preparation: '디지털 사진을 준비하지 못했습니다. 직원에게 문의하세요.',
    },
  }[language]

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      style={{
        position: 'relative',
        width: '1920px',
        height: '1080px',
        overflow: 'hidden',
        userSelect: 'none',
        WebkitTouchCallout: 'none',
        touchAction: 'manipulation',
        background: 'transparent',
      }}
    >
      {/* Recorded photoshoot continues to play behind the thank-you panel
          (matching the printing screen's backdrop). Hidden for photo-ID
          flow, which intentionally records nothing. */}
      {!isPhotoId && <SessionVideoBackground blur={3} dim={0.55} zIndex={0} />}

      {/* No visible countdown — 60s was too short for QR scanning. The
          5-minute inactivity timeout is handled silently in the effect
          above (with reset-on-touch), and PageHeader just shows the logo. */}
      <PageHeader hideTimer />

      {/* ── Centered glass panel ──────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.175, 0.885, 0.32, 1.2] }}
        style={{
          position: 'absolute',
          left: `${PANEL.x}px`,
          top: `${PANEL.y}px`,
          width: `${PANEL.w}px`,
          height: `${PANEL.h}px`,
        }}
      >
        <FigmaGlassCard width={PANEL.w} height={PANEL.h} radius={PANEL.radius}>
          {/* MERCI ! — Inter 500 30px white, centered around frame x=960 */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${355 - PANEL.y}px`,
              height: '36px',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 500,
              fontSize: '30px',
              lineHeight: '36px',
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: '#FDFDFD',
            }}
          >
            {labels.thanks}
          </div>

          {/* PROFITEZ DE VOS PHOTOS — Inter 300 15px */}
          <div
            style={{
              position: 'absolute',
              left: `${855 - PANEL.x}px`,
              top: `${403 - PANEL.y}px`,
              width: '210px',
              height: '18px',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 300,
              fontSize: '15px',
              lineHeight: '18px',
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: '#FDFDFD',
              whiteSpace: 'nowrap',
            }}
          >
            {labels.enjoy}
          </div>

          {/* PARTAGEZ VOTRE MOMENT — Inter 500 15px */}
          <div
            style={{
              position: 'absolute',
              left: `${850 - PANEL.x}px`,
              top: `${460 - PANEL.y}px`,
              width: '218px',
              height: '18px',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 500,
              fontSize: '15px',
              lineHeight: '18px',
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: '#FDFDFD',
              whiteSpace: 'nowrap',
            }}
          >
            {labels.shareTitle}
          </div>

          {/* IDENTIFIEZ @CAPTURISM... — Inter 300 15px white/50%, centered */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${485 - PANEL.y}px`,
              height: '36px',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 300,
              fontSize: '15px',
              lineHeight: '18px',
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: 'rgba(255,255,255,0.5)',
              whiteSpace: 'pre-line',
            }}
          >
            {labels.shareBody}
          </div>

          {/* @CAPTURISM.STUDIO — Inter 500 15px white */}
          <div
            style={{
              position: 'absolute',
              left: `${871 - PANEL.x}px`,
              top: `${526 - PANEL.y}px`,
              width: '177px',
              height: '18px',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 500,
              fontSize: '15px',
              lineHeight: '18px',
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: '#FDFDFD',
              whiteSpace: 'nowrap',
            }}
          >
            {labels.handle}
          </div>

          {/* Digital-copy block (heading + QR + caption). Rendered only
              when the customer opted in on PrintCount. If they unchecked
              the QR-code box, none of this appears on the bye screen. */}
          {wantsQrCode && (
            <>
              {/* RECEVEZ VOS PHOTOS EN NUMÉRIQUE — Inter 500 15px white */}
              <div
                style={{
                  position: 'absolute',
                  left: `${805 - PANEL.x}px`,
                  top: `${583 - PANEL.y}px`,
                  width: '311px',
                  height: '18px',
                  fontFamily: "'Inter', sans-serif",
                  fontWeight: 500,
                  fontSize: '15px',
                  lineHeight: '18px',
                  letterSpacing: '0.05em',
                  textAlign: 'center',
                  color: '#FDFDFD',
                  whiteSpace: 'nowrap',
                }}
              >
                {labels.digital}
              </div>

              {/* QR code box — 100×100 white, radius 5 */}
              <div
                style={{
                  position: 'absolute',
                  left: `${910 - PANEL.x}px`,
                  top: `${612 - PANEL.y}px`,
                  width: '100px',
                  height: '100px',
                  // QR wrapper — pure white to match the QR's bgColor and ensure
                  // the scanner sees solid contrast. NOT the design-system #FDFDFD.
                  background: '#FFFFFF',
                  borderRadius: '5px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
                }}
              >
                {failed ? (
                  <button
                    type="button"
                    disabled={!upload.canRetry}
                    onClick={() => { void retryQrUpload().catch(() => {}) }}
                    style={{ width: '100%', height: '100%', border: 'none', background: '#FFFFFF', color: '#111111', borderRadius: 5, padding: 8, fontSize: 15, fontWeight: 600, cursor: upload.canRetry ? 'pointer' : 'default' }}
                  >
                    {upload.canRetry ? labels.retry : labels.help}
                  </button>
                ) : <DownloadQR
                  cloudToken={cloudToken}
                  size={84}
                  fgColor="#000000"
                  bgColor="#FFFFFF"
                  placeholderLabel={
                    language === 'en' ? 'PREPARING…'
                      : language === 'ko' ? '준비 중…'
                        : 'PRÉPARATION…'
                  }
                />}
              </div>

              {/* SCANNEZ POUR TÉLÉCHARGER... — Inter 300 15px */}
              <div
                style={{
                  position: 'absolute',
                  left: `${(PANEL.w - 660) / 2}px`,
                  top: `${724 - PANEL.y}px`,
                  width: '660px',
                  height: '36px',
                  fontFamily: "'Inter', sans-serif",
                  fontWeight: 300,
                  fontSize: '15px',
                  lineHeight: '18px',
                  letterSpacing: '0.05em',
                  textAlign: 'center',
                  color: '#FDFDFD',
                  whiteSpace: 'normal',
                }}
              >
                <span role={failed ? 'alert' : undefined}>
                  {failed ? upload.reason === 'timeout' ? labels.timeout : upload.reason === 'preparation' ? labels.preparation : labels.failed : labels.scan}
                </span>
              </div>
            </>
          )}

          {/* RECOMMENCER — glass capsule button 361×84 */}
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={handleRestart}
            style={{
              position: 'absolute',
              left: `${781.5 - PANEL.x}px`,
              top: `${772 - PANEL.y}px`,
              width: '361px',
              height: '84px',
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <FigmaGlassCard width={361} height={84} radius={42} nested>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: "'Inter', sans-serif",
                  fontWeight: 500,
                  fontSize: '20px',
                  lineHeight: '24px',
                  letterSpacing: '0.05em',
                  color: '#FDFDFD',
                  textTransform: 'uppercase',
                }}
              >
                {labels.restart}
              </div>
            </FigmaGlassCard>
          </motion.button>
        </FigmaGlassCard>
      </motion.div>
    </motion.div>
  )
}
