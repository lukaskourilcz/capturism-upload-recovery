import { measureStage } from '../../lib/diagnostics'
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { toPng } from 'html-to-image'
import { useSessionStore } from '../../store/sessionStore'
import { LogoHome } from '../layout/LogoHome'
import { PageNumber } from '../layout/PageNumber'
import { resolvePaperBg, resolvePaperInk, resolvePaperPalette, resolvePaperTint, resolveWordmarkInk, NULL_PAPER } from '../../lib/paperColor'
import { resolveFilterCss } from '../../print/filters'
import { PhotoLayers } from '../print/PhotoLayers'
import { compositeFullResWithAlpha } from '../../hooks/useSegmentation'
import { printSizeFor } from '../../lib/paperSize'
import { callPrint } from '../../lib/printClient'
import { buildMiniSheet } from '../../lib/miniSheet'
import { rotatePngDataUrl90CW } from '../../lib/rotatePng'
import { t } from '../../i18n'
import {
  blobToDataUrl,
  renderCardServer,
} from '../../lib/renderCardClient'
import { DownloadQR } from '../DownloadQR'
import { cloudUploadConfigured, photoBlobForUpload, uploadSessionToCloud, SESSION_UPLOAD_PATIENCE_MS } from '../../lib/relayUpload'
import { composeShareVideos } from '../../lib/composeShareVideos'
import { PageHeader } from '../layout/PageHeader'
import { CapturismMark } from '../layout/CapturismMark'
import { FigmaGlassCard } from '../glass/FigmaGlassCard'
import { SessionVideoBackground } from '../layout/SessionVideoBackground'
import { getSessionVideoBlob, getSessionVideoMime } from '../../lib/sessionVideo'
import { waitForImages } from '../../lib/waitForImages'
import { CalendarCardPreview, CALENDAR_CARD_W, CALENDAR_CARD_H } from '../calendar/CalendarCardPreview'
import { usePrintFlow } from '../../hooks/usePrintFlow'
import { PrintFailedOverlay } from './PrintFailedOverlay'
import { settleAuthorizedPayment } from '../../lib/paymentSettlement'
import { sendBoothError } from '../../lib/boothRelay'
import {
  LC_COPY, answerLabel,
  requestPoolMatch, fetchMatchPortrait, joinPool,
} from '../../lib/linconnu'

/**
 * Block until every selected photo has a segmented (transparent-bg)
 * version in the store, OR until the timeout elapses. The segmentation
 * starts on BackgroundFilterPreview but can still be running when the
 * user advances to Printing — if we rasterize before it finishes, the
 * print captures the raw photo (original background) instead of the
 * subject-on-paper-colour result the customer saw in the preview.
 *
 * Times out gracefully: rather than block the print forever on a stuck
 * model load, after `maxWaitMs` we let toPng run with whatever's there
 * (some photos segmented, some raw). Better than no print at all.
 */
/**
 * For each selected photo, replace the small (1800 px) segmented cutout
 * in the store with a full-resolution composite — the Canon's original
 * 24-MP JPEG with the segmented PNG's alpha applied as a mask.
 *
 * Why this matters: PhotoLayers paints the cutout INSIDE the print
 * slot. If the customer pinch-zoomed (scale 2 or 3), the 1800-px source
 * gets stretched to fill 1800*scale px of print → mushy. The full-res
 * composite has 6000 px of source to draw from at any zoom level, so
 * the print stays crisp.
 *
 * Called once per print run, AFTER waitForSegmentation has guaranteed
 * all selected photos have a (low-res) cutout in the store. Idempotent
 * per session: if a photo's stored cutout already looks full-res
 * (matches the natural width of capturedPhoto within 5 %), it's
 * skipped. Failures degrade silently — the print continues with the
 * 1800-px version, which is still usable.
 *
 * Cost: ~300 ms × N selected photos. Hidden behind the existing 18 s
 * print countdown.
 */
async function promoteSelectedToFullRes(selectedPhotos: number[]): Promise<void> {
  const { capturedPhotos, segmentedPhotos, setSegmentedPhoto } = useSessionStore.getState()
  let anyPromoted = false
  await Promise.all(
    selectedPhotos.map(async (idx) => {
      const captured = capturedPhotos[idx]
      const segmented = segmentedPhotos[idx]
      if (!captured || !segmented) return
      // Cheap guard: if segmented is already the same length (in bytes)
      // ballpark as a full-res PNG would be, skip. Full-res 24-MP PNGs
      // are usually 4-15 MB base64 (~5-20 MB string); 1800-px cutouts
      // are typically 100-800 KB. Threshold of 2 MB string length
      // catches the already-promoted case without re-decoding the image.
      if (segmented.length > 2_000_000) return
      try {
        const t0 = performance.now()
        const fullRes = await compositeFullResWithAlpha(captured, segmented)
        setSegmentedPhoto(idx, fullRes)
        anyPromoted = true
        console.log(`[PRINT] photo ${idx} promoted to full-res cutout in ${Math.round(performance.now() - t0)} ms (was ${(segmented.length / 1024).toFixed(0)} KB, now ${(fullRes.length / 1024).toFixed(0)} KB)`)
      } catch (err) {
        console.warn(`[PRINT] full-res promotion failed for photo ${idx}, keeping 1800-px cutout:`, err)
      }
    }),
  )

  // CRITICAL: React's re-render after setSegmentedPhoto is async — the
  // <img>s in the print card DOM still hold the OLD (1800-px) src in
  // their `currentSrc` / `complete` state at this point. If we let
  // waitForImages run now, it sees img.complete=true on the old image
  // and returns immediately → toPng rasterizes the OLD src and the
  // full-res promotion is invisible on the print.
  //
  // Yielding for one paint frame guarantees React's reconciler has
  // committed, the new src has been applied to the img element, and
  // the browser has started decoding the new bytes. waitForImages
  // can then correctly await the new decode.
  if (anyPromoted) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    console.log('[PRINT] React commit flushed — full-res images should now be in the DOM')
  }
}

async function waitForSegmentation(selectedPhotos: number[], maxWaitMs = 12_000): Promise<void> {
  if (selectedPhotos.length === 0) return
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const segmented = useSessionStore.getState().segmentedPhotos
    if (selectedPhotos.every((idx) => segmented[idx] != null)) {
      console.log('[PRINT] Segmentation complete for all selected photos')
      return
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  console.warn('[PRINT] Segmentation timeout — proceeding with whatever is available (some photos may print without the paper-colour bg)')
}

/* ── Status phases ───────────────────────────────────────── */

type Phase = 'printing' | 'almost' | 'done'

/* ── Animated dots ───────────────────────────────────────── */

function LoadingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: '5px', marginLeft: '4px' }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.15, 0.7, 0.15] }}
          transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.25, ease: 'easeInOut' }}
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: '#44433B',
            display: 'inline-block',
          }}
        />
      ))}
    </span>
  )
}

/* ── Paper backgrounds & filters (same as BackgroundFilterPreview) ── */

interface PaperBg { key: string; css: string; image?: string; isDark?: boolean }

const PAPER_BACKGROUNDS: PaperBg[] = [
  { key: 'white', css: '#FAFAF8' },
  { key: 'noir', css: '#1A1A1A', isDark: true },
  { key: 'dark-marble', css: '#1a2a2a', image: '/backgrounds/dark-marble.jpg', isDark: true },
  { key: 'golden-hour', css: '#F0DCC8', image: '/backgrounds/golden-hour.jpg' },
  { key: 'cherry-blossom', css: '#FFD9E4', image: '/backgrounds/cherry-blossom.jpg' },
  { key: 'dried-roses', css: '#E8E0E0', image: '/backgrounds/dried-roses.jpg' },
  { key: 'classical', css: '#D8D0C8', image: '/backgrounds/classical-relief.jpg' },
  { key: 'matcha', css: '#5A7A3A', image: '/backgrounds/matcha.jpg', isDark: true },
  { key: 'cafe-creme', css: '#E8D8C8', image: '/backgrounds/cafe-creme.jpg' },
  { key: 'kraft', css: 'linear-gradient(145deg, #C4A882 0%, #D4B892 40%, #DCC8A8 70%, #E8D8B8 100%)' },
]

function resolvePrintFilterCss(selected: string | null | undefined): string {
  return resolveFilterCss(selected)
}

/* ── Shared: frame layout config ─────────────────────────── */

function getLayout(frameType: string | null) {
  switch (frameType) {
    case '2-cut': return { cols: 1, rows: 2, gap: 5, gridFlex: '0 0 74%' }
    case '3-cut': return { cols: 1, rows: 3, gap: 4, gridFlex: '0 0 88%' }
    case '4-cut': return { cols: 2, rows: 2, gap: 5, gridFlex: '0 0 60%' }
    default:      return { cols: 1, rows: 1, gap: 0, gridFlex: '0 0 50%' }
  }
}

function getCount(frameType: string | null, shootType: string | null): number {
  if (shootType === 'calendar' || shootType === 'photo_id') return 1
  if (shootType === 'postcard') return 2
  switch (frameType) {
    case '2-cut': return 2
    case '3-cut': return 3
    case '4-cut': return 4
    default: return 1
  }
}

/* ── Static preview — reuses exact same look as BackgroundFilterPreview ── */

function StaticPreview({
  shootType, frameType, photos, filterCss, paperBg,
  calendarMonth, calendarYear,
}: {
  shootType: string | null
  frameType: string | null
  photos: string[]
  filterCss: string
  paperBg: PaperBg
  calendarMonth: number
  calendarYear: number
}) {
  const isDark = paperBg.isDark || false
  const textColor = isDark ? '#E8E8E4' : '#44433B'
  const subtleColor = isDark ? 'rgba(255,255,255,0.35)' : '#C8C0B8'
  const lineColor = isDark ? 'rgba(255,255,255,0.2)' : '#E0DDD8'
  const brandColor = isDark ? '#D0D0CC' : '#44433B'

  // ── Calendar ──
  if (shootType === 'calendar') {
    const monthNames = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER']
    const monthLabel = `${monthNames[calendarMonth]} ${calendarYear}`
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate()
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1)
    const firstDow = new Date(calendarYear, calendarMonth, 1).getDay()
    const offset = firstDow === 0 ? 6 : firstDow - 1

    return (
      <div style={{ width: '230px', position: 'relative' }}>
        <div style={{
          position: 'absolute', width: '100%', aspectRatio: '228 / 382',
          background: 'rgba(255,255,255,0.65)', borderRadius: '6px',
          border: '0.5px solid rgba(255,255,255,0.4)', top: 0, left: 0,
        }} />
        <div style={{
          position: 'relative', width: '100%', aspectRatio: '228 / 382',
          background: paperBg.css, borderRadius: '6px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {paperBg.image && (
            <div style={{ position: 'absolute', inset: 0, borderRadius: '6px', overflow: 'hidden', zIndex: 0 }}>
              <img src={paperBg.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.85 }} />
            </div>
          )}
          <div style={{
            flex: '0 0 38%', borderRadius: '4px 4px 0 0',
            position: 'relative', overflow: 'hidden', zIndex: 1,
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
            padding: '8px', background: '#E8E6E3',
          }}>
            {photos[0] && (
              <img src={photos[0]} alt="" style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
                filter: filterCss,
              }} />
            )}
            <div style={{
              position: 'relative', zIndex: 1,
              background: 'rgba(255,255,255,0.8)', padding: '2px 8px', borderRadius: '2px',
            }}>
              <span style={{
                fontFamily: "'ITC Garamond Std', serif",
                fontWeight: 300, fontSize: '9px', color: '#44433B', letterSpacing: '0.15em',
              }}>{monthLabel}</span>
            </div>
          </div>
          <div style={{ flex: 1, padding: '6px 8px 4px', display: 'flex', flexDirection: 'column', minHeight: 0, zIndex: 1 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '1px', marginBottom: '3px' }}>
              {['M','T','W','T','F','S','S'].map((d, i) => (
                <div key={i} style={{
                  textAlign: 'center', fontFamily: "'Georgia Ballpark', 'Georgia', serif",
                  fontSize: '5.5px', color: isDark ? 'rgba(255,255,255,0.5)' : '#AEAEA8',
                }}>{d}</div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '1px', flex: 1 }}>
              {Array.from({ length: offset }).map((_, i) => <div key={`e${i}`} />)}
              {days.map((day) => (
                <div key={day} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: "'Georgia Ballpark', 'Georgia', serif",
                  fontSize: '5px', color: isDark ? 'rgba(255,255,255,0.7)' : '#44433B',
                  borderRadius: '50%', width: '100%', aspectRatio: '1',
                }}>{day}</div>
              ))}
            </div>
            <div style={{ flexShrink: 0, paddingTop: '3px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <CapturismMark width={56} ink={brandColor} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Postcard ──
  if (shootType === 'postcard') {
    return (
      <div style={{ width: '280px', position: 'relative' }}>
        <div style={{
          position: 'absolute', width: '100%', aspectRatio: '382 / 228',
          background: 'rgba(255,255,255,0.65)', borderRadius: '6px',
          border: '0.5px solid rgba(255,255,255,0.4)', top: 0, left: 0,
        }} />
        <div style={{
          position: 'relative', width: '100%', aspectRatio: '382 / 228',
          background: paperBg.css, borderRadius: '6px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)',
          display: 'flex', flexDirection: 'row', overflow: 'hidden',
        }}>
          {paperBg.image && (
            <div style={{ position: 'absolute', inset: 0, borderRadius: '6px', overflow: 'hidden', zIndex: 0 }}>
              <img src={paperBg.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.85 }} />
            </div>
          )}
          <div style={{ flex: '0 0 45%', display: 'flex', flexDirection: 'column', zIndex: 1 }}>
            {[0, 1].map((i) => (
              <div key={i} style={{
                flex: 1, background: '#E8E6E3', overflow: 'hidden',
                borderBottom: i === 0 ? '1px solid rgba(255,255,255,0.5)' : 'none',
                position: 'relative',
              }}>
                {photos[i] && (
                  <img src={photos[i]} alt="" style={{
                    position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
                    filter: filterCss,
                  }} />
                )}
              </div>
            ))}
          </div>
          <div style={{ width: '0.5px', background: lineColor, flexShrink: 0, zIndex: 1 }} />
          <div style={{ flex: 1, padding: '8% 6%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', zIndex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{ width: '28px', height: '32px', border: `1px dashed ${subtleColor}`, borderRadius: '2px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ fontFamily: "'Georgia Ballpark', 'Georgia', serif", fontSize: '4px', color: subtleColor, letterSpacing: '0.05em' }}>STAMP</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
              {[100, 85, 70, 55].map((w, i) => (
                <div key={i} style={{ width: `${w}%`, height: '1px', background: i === 0 ? subtleColor : lineColor, borderRadius: '1px' }} />
              ))}
            </div>
            <div style={{ marginTop: 'auto', paddingTop: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <CapturismMark width={56} ink={textColor} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Photo ID: 2×4 grid of the same photo ──
  if (shootType === 'photo_id') {
    const photo = photos[0]
    return (
      <div style={{
        width: '230px', aspectRatio: '228 / 382',
        background: '#FAFAF8', borderRadius: '6px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          flex: '0 0 auto', padding: '8px 12px 4px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{
            fontFamily: "'ITC Garamond Std', serif",
            fontWeight: 300, fontSize: '7px', color: '#44433B',
            letterSpacing: '0.2em', opacity: 0.6,
          }}>PHOTO IDENTITÉ</div>
          <svg viewBox="0 0 16 16" width="10" height="10" opacity={0.3}>
            <line x1="0" y1="8" x2="5" y2="8" stroke="#44433B" strokeWidth="0.8" />
            <line x1="11" y1="8" x2="16" y2="8" stroke="#44433B" strokeWidth="0.8" />
            <line x1="8" y1="0" x2="8" y2="5" stroke="#44433B" strokeWidth="0.8" />
            <line x1="8" y1="11" x2="8" y2="16" stroke="#44433B" strokeWidth="0.8" />
          </svg>
        </div>
        <div style={{
          flex: 1, display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: 'repeat(4, 1fr)',
          gap: '3px', padding: '0 8px 4px', minHeight: 0,
        }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{
              borderRadius: '3px', overflow: 'hidden',
              background: photo ? 'transparent' : '#E8E6E3',
              position: 'relative', minHeight: 0,
            }}>
              {photo && (
                <img src={photo} alt="" style={{
                  width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                  filter: filterCss,
                }} />
              )}
            </div>
          ))}
        </div>
        <div style={{ flex: '0 0 auto', padding: '4px 0 8px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <CapturismMark width={56} ink="#44433B" />
        </div>
      </div>
    )
  }

  // ── Regular photo print ──
  const layout = getLayout(frameType)
  const count = getCount(frameType, shootType)
  const slots = Array.from({ length: count })

  return (
    <div style={{
      width: '230px', aspectRatio: '228 / 382',
      background: paperBg.css, borderRadius: '6px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)',
      display: 'grid',
      gridTemplateRows: `${frameType === '3-cut' ? '88%' : frameType === '2-cut' ? '74%' : '68%'} 1fr`,
      padding: '5% 7%', overflow: 'hidden', position: 'relative',
    }}>
      {paperBg.image && (
        <div style={{ position: 'absolute', inset: 0, borderRadius: '6px', overflow: 'hidden', zIndex: 0 }}>
          <img src={paperBg.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.85 }} />
        </div>
      )}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
        gap: `${layout.gap}px`, width: '100%', minHeight: 0, zIndex: 1,
      }}>
        {slots.map((_, i) => (
          <div key={i} style={{
            borderRadius: '4px', overflow: 'hidden',
            background: photos[i] ? 'transparent' : '#EBEBEB',
            position: 'relative', minHeight: 0,
          }}>
            {photos[i] && (
              <img src={photos[i]} alt="" style={{
                width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                filter: filterCss,
              }} />
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
        <CapturismMark width={68} ink={brandColor} />
      </div>
    </div>
  )
}

/* ── Progress track ──────────────────────────────────────── */

function ProgressTrack({ progress, phase }: { progress: number; phase: Phase }) {
  return (
    <div style={{
      width: '320px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      alignItems: 'center',
    }}>
      <div style={{
        width: '100%',
        height: '4px',
        borderRadius: '2px',
        background: '#DCDCD8',
        overflow: 'hidden',
      }}>
        <motion.div
          animate={{ width: `${Math.min(progress, 100)}%` }}
          transition={{ duration: 0.15, ease: 'linear' }}
          style={{
            height: '100%',
            borderRadius: '2px',
            background: phase === 'done' ? '#44433B' : '#AEAEA8',
            transition: 'background 0.4s ease',
          }}
        />
      </div>

      <span style={{
        fontFamily: "'georgia ballpark', 'Georgia', serif",
        fontSize: '14px',
        color: '#C0C0BC',
        letterSpacing: '0.1em',
      }}>
        {Math.min(Math.round(progress), 100)}%
      </span>
    </div>
  )
}

/* ── Calendar printing screen ─────────────────────────────────
   Mirrors PostcardPrinting: vertical calendar card on the left,
   identical right-side glass panel (IMPRESSION EN COURS / progress /
   QR download). Skeleton — fine-tune later.                          */

function CalendarPrinting() {
  const {
    language, capturedPhotos, segmentedPhotos, selectedPhotos, photoTimestampsMs, paperBackground, selectedFilter,
    cloudToken, setCloudToken,
    calendarMonth, calendarYear, shootType, frameType, printCount,
  } = useSessionStore()

  const cardRef = useRef<HTMLDivElement>(null)
  // percent / phase / capture-or-cancel + navigation owned by usePrintFlow.
  const { percent, phase, onPrintResolved } = usePrintFlow()

  const PANEL = { x: 925, y: 277, w: 868, h: 620, radius: 100 }
  const CC_W = CALENDAR_CARD_W
  const CC_H = CALENDAR_CARD_H
  const CC_X = 253
  const CC_Y = 165

  const selectedColor = paperBackground || NULL_PAPER
  const photoFilter = resolvePrintFilterCss(selectedFilter)


  // Physical print — fire the calendar card off to /api/printer/print once.
  // Same StrictMode-safe pattern as PhotoPrinting / PhotoIdPrinting: the
  // already-fired ref check lives inside run() so the first mount's cleanup
  // cancels its timeout, and the re-mount schedules a fresh one that fires
  // 800ms later and runs exactly once.
  const physicalPrintFiredRef = useRef(false)
  useEffect(() => {
    if (!selectedPhotos.length) return
    console.log('[CALENDAR-PRINT] effect armed, will run in 800ms')

    const run = async () => {
      if (physicalPrintFiredRef.current) return
      physicalPrintFiredRef.current = true
      const el = cardRef.current
      if (!el) {
        console.warn('[CALENDAR-PRINT] cardRef still null after 800ms — bailing')
        onPrintResolved(false)
        return
      }
      try {
        console.log('[CALENDAR-PRINT] rasterizing card via toPng...')
        await measureStage('render.segmentation', () => waitForSegmentation(selectedPhotos))
        await promoteSelectedToFullRes(selectedPhotos)
        await waitForImages(el)
        // ⚠️ html-to-image applies `backgroundColor` as an inline
        // style.backgroundColor on the cloned root element — passing
        // '#FDFDFD' here would PAINT WHITE OVER the calendar card's
        // `background: paperColor` and the print would lose the chosen
        // studio colour. Pass the resolved paper colour so the override
        // and the original bg agree.
        // pixelRatio 7.2, NOT the 5 used by the smaller cards. The calendar
        // card is 500 CSS px across a SIX-INCH print dimension (6×9″
        // sheet): at ×5 that's 2500 px / 6 in ≈ 417 dpi — well under the
        // DS620's 600 dpi ceiling, so calendars printed ~30% softer than
        // postcards (caught by the operator 2026-07-05: "bigger paper
        // needs more pixels"). 500 × 7.2 = 3600 px / 6 in = 600 dpi
        // exactly; the long side lands at 5400 px / 9 in = 600 dpi too.
        // Going higher would be wasted — the printer can't resolve past
        // ~600 dpi.
        const dataUrl = await measureStage('render.raster', () => toPng(el, {
          pixelRatio: 7.2,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: resolvePaperBg(selectedColor),
          style: { position: 'static', left: '0', top: '0', margin: '0', transform: 'none' },
        }))
        // Calendar prints at the kiosk's configured paper size. In 6×9
        // mode the bridge / driver picks 6×9 paper (operator has loaded
        // the 6×9 ribbon for the day); in 4×6 mode the Calendar fits
        // the standard 4×6 (no Calendar is offered in this mode today,
        // but the print path still works if someone forces it via URL).
        const calendarSize = printSizeFor('calendar')
        console.log(`[CALENDAR-PRINT] toPng done (${(dataUrl.length / 1024).toFixed(1)}KB), POSTing /api/printer/print at ${calendarSize}...`)
        const { delivered } = await callPrint({ imageDataUrl: dataUrl, copies: printCount || 1, sizeMode: calendarSize })
        onPrintResolved(delivered)
      } catch (err) {
        console.warn('[CALENDAR-PRINT] ❌ Print request error:', (err as Error).message)
        onPrintResolved(false)
      }
    }
    const t = window.setTimeout(run, 800)
    return () => window.clearTimeout(t)
    // selectedColor is captured at mount time intentionally — the printer
    // bake is a snapshot of the chosen colour, not reactive to changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPhotos, printCount])

  // Cloud upload — rasterize the calendar card and push to R2.
  //
  // ⚠️ DO NOT REINTRODUCE `cancelled`-gated aborts inside run(). The
  // upload pipeline runs longer than the 18s print countdown auto-
  // advances to /bye; aborting on unmount means setCloudToken never
  // fires and customers land on a tokenless download page. See the
  // matching note in PhotoPrinting / PostcardPrinting.
  const cloudUploadFiredRef = useRef(false)
  useEffect(() => {
    if (cloudToken || !cloudUploadConfigured) return
    if (!selectedPhotos.length) return
    const run = async () => {
      if (cloudUploadFiredRef.current) return
      cloudUploadFiredRef.current = true
      await new Promise(r => setTimeout(r, 600))
      if (!cardRef.current) return
      try {
        // Same trick as PostcardPrinting: the calendar card is rendered
        // inside an absolutely-positioned motion.div (with framer-motion's
        // transform), so html-to-image would otherwise inherit that offset
        // and crop the output. Lock width/height to the card's own box and
        // override position/transform on the clone root so the PNG comes
        // out flush against (0, 0).
        const el = cardRef.current
        await measureStage('render.segmentation', () => waitForSegmentation(selectedPhotos))
        await promoteSelectedToFullRes(selectedPhotos)
        await waitForImages(el)
        // Same html-to-image quirk as the physical-print path above:
        // backgroundColor is applied as an inline style on the cloned
        // root, overriding the card's own bg. Pass the resolved paper
        // colour so the override matches and the cloud render keeps
        // the chosen studio colour.
        const dataUrl = await measureStage('render.raster', () => toPng(el, {
          pixelRatio: 4,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: resolvePaperBg(selectedColor),
          style: {
            position: 'static',
            left: '0',
            top: '0',
            margin: '0',
            transform: 'none',
          },
        }))
        const video = getSessionVideoBlob()
        const selectedTimestamps = selectedPhotos.map((i) => photoTimestampsMs[i] ?? 0)
        const composed = await measureStage('render.video', () => composeShareVideos({
          sessionVideo: video,
          selectedTimestamps,
          shootType,
          frameType,
          printImageDataUrl: dataUrl,
        }))
        // JPEG transcode for the upload copy only — the video-bake above
        // keeps the original PNG bytes. ~10× smaller PUT = the QR commits
        // in seconds instead of straddling the 120s timeout.
        const uploadPhoto = await photoBlobForUpload(dataUrl)
        const token = await uploadSessionToCloud({
          retryForMs: SESSION_UPLOAD_PATIENCE_MS, // background flow: ride out a network blip
          photo: uploadPhoto.blob,
          photoContentType: uploadPhoto.contentType,
          video: video || undefined,
          videoContentType: video ? getSessionVideoMime() : undefined,
          layoutVideo: composed.layoutVideo || undefined,
          storyVideo: composed.storyVideo || undefined,
        })
        setCloudToken(token)
        console.log(`[CALENDAR] Cloud upload complete: token=${token} (video=${!!video}, layout=${!!composed.layoutVideo}, story=${!!composed.storyVideo})`)
      } catch (err) {
        console.warn('[CALENDAR] Cloud upload failed:', (err as Error).message)
      }
    }
    run()
    // shootType / frameType / selectedColor / photoTimestampsMs are stable
    // for the lifetime of this screen — the upload bakes a snapshot of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudToken, setCloudToken, selectedPhotos])

  const labels = {
    fr: {
      printing: 'IMPRESSION EN COURS',
      doNotLeave: 'VEUILLEZ NE PAS PARTIR',
      printsArriving: 'VOS TIRAGES ARRIVENT',
      digitalPhotos: 'RECEVEZ VOS PHOTOS EN NUMÉRIQUE',
      scan: 'SCANNEZ POUR TÉLÉCHARGER SUR VOTRE TÉLÉPHONE',
    },
    en: {
      printing: 'PRINTING IN PROGRESS',
      doNotLeave: 'PLEASE DO NOT LEAVE',
      printsArriving: 'YOUR PRINTS ARE COMING',
      digitalPhotos: 'GET YOUR PHOTOS DIGITALLY',
      scan: 'SCAN TO DOWNLOAD ON YOUR PHONE',
    },
    ko: {
      printing: '프린트 중',
      doNotLeave: '잠시만 기다려 주세요',
      printsArriving: '프린트 중입니다',
      digitalPhotos: '디지털 사진 받기',
      scan: '휴대폰으로 다운로드하려면 스캔하세요',
    },
  }[language]

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}
      style={{ position: 'relative', width: '1920px', height: '1080px', overflow: 'hidden', userSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'manipulation', background: 'transparent' }}
    >
      <SessionVideoBackground blur={3} dim={0.55} zIndex={0} />
      {/* No timer on the printing screen — the print job has its own progress bar. */}
      <PageHeader hideTimer />

      {/* Calendar preview — shared component, ref'd so we can rasterize it
          to PNG for the cloud upload. */}
      <motion.div
        initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4, delay: 0.1 }}
        style={{ position: 'absolute', left: `${CC_X}px`, top: `${CC_Y}px`, width: `${CC_W}px`, height: `${CC_H}px` }}
      >
        <CalendarCardPreview
          forwardedRef={cardRef}
          photo={selectedPhotos[0] !== undefined
            ? (segmentedPhotos[selectedPhotos[0]] ?? capturedPhotos[selectedPhotos[0]])
            : undefined}
          basePhoto={selectedPhotos[0] !== undefined ? capturedPhotos[selectedPhotos[0]] : undefined}
          tint={resolvePaperTint(selectedColor)}
          photoIdx={selectedPhotos[0]}
          filterCss={photoFilter}
          month={calendarMonth}
          year={calendarYear}
          language={language}
          paperColor={resolvePaperBg(selectedColor)}
        />
      </motion.div>

      {/* Right glass panel — same as PostcardPrinting / PhotoIdPrinting */}
      <motion.div
        initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.45, delay: 0.15 }}
        style={{ position: 'absolute', left: `${PANEL.x}px`, top: `${PANEL.y}px`, width: `${PANEL.w}px`, height: `${PANEL.h}px` }}
      >
        <FigmaGlassCard width={PANEL.w} height={PANEL.h} radius={PANEL.radius}>
          <div style={{ position: 'absolute', left: `${1174 - PANEL.x}px`, top: `${355 - PANEL.y}px`, width: '370px', height: '36px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '30px', lineHeight: '36px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
            {labels.printing}
          </div>
          <div style={{ position: 'absolute', left: `${1174 - PANEL.x}px`, top: `${PANEL.y + 78 + 36 + 43 - PANEL.y}px`, width: '370px', height: '3px', background: 'rgba(255,255,255,0.2)', borderRadius: '1.5px', overflow: 'hidden' }}>
            <motion.div animate={{ width: `${percent}%` }} transition={{ duration: 0.2, ease: 'linear' }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'rgba(255,255,255,0.85)', borderRadius: '1.5px' }} />
          </div>
          <div style={{ position: 'absolute', left: `${1330 - PANEL.x}px`, top: `${448 - PANEL.y}px`, width: '58px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD' }}>
            {percent}%
          </div>
          <div style={{ position: 'absolute', left: `${1259 - PANEL.x}px`, top: `${552 - PANEL.y}px`, width: '199px', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD' }}>
            <div style={{ whiteSpace: 'nowrap' }}>{labels.doNotLeave}</div>
            <div style={{ whiteSpace: 'nowrap' }}>{labels.printsArriving}</div>
          </div>
          <div style={{ position: 'absolute', left: `${1204 - PANEL.x}px`, top: `${674 - PANEL.y}px`, width: '311px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
            {labels.digitalPhotos}
          </div>
          <div style={{ position: 'absolute', left: `${1309 - PANEL.x}px`, top: `${715 - PANEL.y}px`, width: '100px', height: '100px', background: '#FFFFFF', borderRadius: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
            <DownloadQR cloudToken={cloudToken} size={84} />
          </div>
          <div style={{ position: 'absolute', left: `${1140 - PANEL.x}px`, top: `${838 - PANEL.y}px`, width: '439px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
            {labels.scan}
          </div>
        </FigmaGlassCard>
      </motion.div>

      {phase === 'failed' && <PrintFailedOverlay />}
    </motion.div>
  )
}

/* ── Shared printing-screen helpers ─────────────────────────────── */

const PRINT_LABELS = {
  fr: {
    printing: 'IMPRESSION EN COURS',
    doNotLeave: 'VEUILLEZ NE PAS PARTIR',
    printsArriving: 'VOS TIRAGES ARRIVENT',
    digitalPhotos: 'RECEVEZ VOS PHOTOS EN NUMÉRIQUE',
    scan: 'SCANNEZ POUR TÉLÉCHARGER SUR VOTRE TÉLÉPHONE',
  },
  en: {
    printing: 'PRINTING IN PROGRESS',
    doNotLeave: 'PLEASE DO NOT LEAVE',
    printsArriving: 'YOUR PRINTS ARE COMING',
    digitalPhotos: 'GET YOUR PHOTOS DIGITALLY',
    scan: 'SCAN TO DOWNLOAD ON YOUR PHONE',
  },
  ko: {
    printing: '프린트 중',
    doNotLeave: '잠시만 기다려 주세요',
    printsArriving: '프린트 중입니다',
    digitalPhotos: '디지털 사진 받기',
    scan: '휴대폰으로 다운로드하려면 스캔하세요',
  },
}

/* Bottom-of-card branding strip (date / Capturism Studio mark / city).
   Ink contrast adapts to the paper colour: 100% white on dark, 50%
   black on light — mirrors the customize-page treatment. */
function PrintCardBrandingOverlay({ language, top, paperColor, ink: inkOverride, wordmarkInk: wordmarkInkOverride }: {
  language: 'en' | 'fr' | 'ko'
  top: number
  paperColor: string
  /**
   * Explicit inks, for a card whose branding row sits on PAPER instead
   * of over the photo. The paper-colour rules assume the latter:
   * resolveWordmarkInk() always returns #FDFDFD (white reads well on a
   * photo), and resolvePaperInk() also returns #FDFDFD for any key that
   * isn't one of the PAPER_GREYS hexes. On the l'INCONNU stranger card
   * — white caption strip, no photo underneath — that printed the whole
   * row white-on-white, i.e. nothing at all. Confirmed on a physical
   * card from the booth, 2026-10-10.
   */
  ink?: string
  wordmarkInk?: string
}) {
  // date + city stay on the general contrast-aware ink, wordmark gets
  // the stricter brand rule (split → colored half, else #FDFDFD) —
  // unless the caller supplies its own ink (see above).
  const ink = inkOverride ?? resolvePaperInk(paperColor)
  const wordmarkInk = wordmarkInkOverride ?? resolveWordmarkInk(paperColor)
  return (
    <div style={{
      position: 'absolute', left: '30px', right: '30px', top: `${top}px`, height: '32px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', pointerEvents: 'none',
    }}>
      <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '12px', lineHeight: '14px', letterSpacing: '0.05em', color: ink, whiteSpace: 'nowrap' }}>
        {formatPostcardDate(language)}
      </div>
      <CapturismMark width={70} ink={wordmarkInk} />
      <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '12px', lineHeight: '14px', letterSpacing: '0.05em', color: ink, whiteSpace: 'nowrap' }}>
        PARIS, FRANCE
      </div>
    </div>
  )
}

/* Right glass panel — IMPRESSION EN COURS title, progress bar + %,
   "VEUILLEZ NE PAS PARTIR" copy, and a QR code that points at the
   download URL. Identical layout to postcard / calendar / photo-id
   printing screens. */
function PrintingRightPanel({ percent, language, cloudToken }: { percent: number; language: 'en' | 'fr' | 'ko'; cloudToken: string | null }) {
  const PANEL = { x: 925, y: 277, w: 868, h: 620, radius: 100 }
  const labels = PRINT_LABELS[language]
  return (
    <motion.div
      initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.45, delay: 0.15 }}
      style={{ position: 'absolute', left: `${PANEL.x}px`, top: `${PANEL.y}px`, width: `${PANEL.w}px`, height: `${PANEL.h}px` }}
    >
      <FigmaGlassCard width={PANEL.w} height={PANEL.h} radius={PANEL.radius}>
        <div style={{ position: 'absolute', left: `${1174 - PANEL.x}px`, top: `${355 - PANEL.y}px`, width: '370px', height: '36px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '30px', lineHeight: '36px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
          {labels.printing}
        </div>
        <div style={{ position: 'absolute', left: `${1174 - PANEL.x}px`, top: `${PANEL.y + 78 + 36 + 43 - PANEL.y}px`, width: '370px', height: '3px', background: 'rgba(255,255,255,0.2)', borderRadius: '1.5px', overflow: 'hidden' }}>
          <motion.div animate={{ width: `${percent}%` }} transition={{ duration: 0.2, ease: 'linear' }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'rgba(255,255,255,0.85)', borderRadius: '1.5px' }} />
        </div>
        <div style={{ position: 'absolute', left: `${1330 - PANEL.x}px`, top: `${448 - PANEL.y}px`, width: '58px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD' }}>
          {percent}%
        </div>
        <div style={{ position: 'absolute', left: `${1259 - PANEL.x}px`, top: `${552 - PANEL.y}px`, width: '199px', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD' }}>
          <div style={{ whiteSpace: 'nowrap' }}>{labels.doNotLeave}</div>
          <div style={{ whiteSpace: 'nowrap' }}>{labels.printsArriving}</div>
        </div>
        <div style={{ position: 'absolute', left: `${1204 - PANEL.x}px`, top: `${674 - PANEL.y}px`, width: '311px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
          {labels.digitalPhotos}
        </div>
        <div style={{ position: 'absolute', left: `${1309 - PANEL.x}px`, top: `${715 - PANEL.y}px`, width: '100px', height: '100px', background: '#FFFFFF', borderRadius: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
          <DownloadQR cloudToken={cloudToken} size={84} />
        </div>
        <div style={{ position: 'absolute', left: `${1140 - PANEL.x}px`, top: `${838 - PANEL.y}px`, width: '439px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
          {labels.scan}
        </div>
      </FigmaGlassCard>
    </motion.div>
  )
}

/* ── PHOTO printing screen (SOLO / SPLIT / TRIPTYCH / GRID) ────────
   500×750 print card at frame (253, 207) with the user's selected
   paper colour as the background. Photo slot layout is driven by
   frameType — same geometry as PhotoChoice / BackgroundFilterPreview
   so the customer sees an identical product before, during, and
   after print. Right glass panel shared with postcard / calendar.
   Cloud upload, physical print, progress + auto-advance to /bye. */

function PhotoPrinting() {
  const {
    language, capturedPhotos, selectedPhotos, photoTimestampsMs, segmentedPhotos, photoZoom, paperBackground, selectedFilter,
    shootType, frameType, cloudToken, setCloudToken, printCount, photoPrintSize, photoMiniSheet,
  } = useSessionStore()

  const cardRef = useRef<HTMLDivElement>(null)
  // percent / phase / capture-or-cancel + navigation owned by usePrintFlow.
  const { percent, phase, onPrintResolved } = usePrintFlow()

  const TC = { x: 253, y: 207, w: 500, h: 750 }

  const selectedColor = paperBackground || NULL_PAPER
  const photoFilter = resolvePrintFilterCss(selectedFilter)

  // Cloud upload — rasterize the print card once it's rendered, then push
  // the PNG (and recorded session video, if any) to R2 via the relay.
  //
  // ⚠️ DO NOT REINTRODUCE `cancelled`-gated aborts inside run(). The full
  // upload pipeline (waitForSegmentation up to 12s + composeShareVideos
  // ~8-10s + R2 PUTs) routinely takes longer than the 18s printing
  // screen auto-advances to /bye. If we abort on unmount, setCloudToken
  // never fires, the QR on /bye encodes the bare download domain (no
  // token), and customers land on a tokenless page — which is exactly
  // why the QR silently stopped working after `waitForSegmentation` was
  // added. Zustand setState after unmount is harmless; let the upload
  // finish and the token will be picked up by /bye's QR via the store.
  const cloudUploadFiredRef = useRef(false)
  useEffect(() => {
    if (cloudToken || !cloudUploadConfigured) return
    if (!selectedPhotos.length) return
    const run = async () => {
      // StrictMode-safe single-fire (matches the physical-print effect
      // pattern below): cleanup of the first mount can't cancel us, but
      // a second concurrent run() bails immediately.
      if (cloudUploadFiredRef.current) return
      cloudUploadFiredRef.current = true
      await new Promise(r => setTimeout(r, 600))
      if (!cardRef.current) return
      try {
        const el = cardRef.current
        await measureStage('render.segmentation', () => waitForSegmentation(selectedPhotos))
        await promoteSelectedToFullRes(selectedPhotos)
        await waitForImages(el)
        // html-to-image applies `backgroundColor` as inline
        // style.backgroundColor on the cloned root, so it must be a
        // VALID CSS colour. Split-cream keys (e.g. '#C08B89-cream') are
        // not — pass the resolved paper colour through so we always
        // hand it a real hex / rgb value.
        const dataUrl = await measureStage('render.raster', () => toPng(el, {
          pixelRatio: 4,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: resolvePaperBg(selectedColor),
          // Override the absolutely-positioned wrapper so the PNG renders
          // flush against (0,0) instead of inheriting the card's frame
          // offset (253, 207) — same fix as postcard / calendar.
          style: { position: 'static', left: '0', top: '0', margin: '0', transform: 'none' },
        }))
        const video = getSessionVideoBlob()
        const selectedTimestamps = selectedPhotos.map((i) => photoTimestampsMs[i] ?? 0)
        const composed = await measureStage('render.video', () => composeShareVideos({
          sessionVideo: video,
          selectedTimestamps,
          shootType,
          frameType,
          printImageDataUrl: dataUrl,
        }))
        // JPEG transcode for the upload copy only — the video-bake above
        // keeps the original PNG bytes. ~10× smaller PUT = the QR commits
        // in seconds instead of straddling the 120s timeout.
        const uploadPhoto = await photoBlobForUpload(dataUrl)
        const token = await uploadSessionToCloud({
          retryForMs: SESSION_UPLOAD_PATIENCE_MS, // background flow: ride out a network blip
          photo: uploadPhoto.blob,
          photoContentType: uploadPhoto.contentType,
          video: video || undefined,
          videoContentType: video ? getSessionVideoMime() : undefined,
          layoutVideo: composed.layoutVideo || undefined,
          storyVideo: composed.storyVideo || undefined,
        })
        setCloudToken(token)
        console.log(`[PHOTO] Cloud upload complete: token=${token} (video=${!!video}, layout=${!!composed.layoutVideo}, story=${!!composed.storyVideo})`)
      } catch (err) {
        console.warn('[PHOTO] Cloud upload failed:', (err as Error).message)
      }
    }
    run()
    // shootType / frameType / photoTimestampsMs are stable for this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudToken, setCloudToken, selectedPhotos, selectedColor])

  // Physical print — fire the card off to /api/printer/print once.
  // The ref check lives INSIDE run() (not in the effect body) so React 19
  // StrictMode's mount → cleanup → re-mount cycle doesn't cancel the
  // timeout before it can fire. With the check inside run(), the first
  // mount's cleanup cancels its own timeout; the re-mount schedules a
  // fresh one which fires 800 ms later and executes exactly once.
  const physicalPrintFiredRef = useRef(false)
  useEffect(() => {
    if (!selectedPhotos.length) return
    console.log('[PHOTO-PRINT] effect armed, will run in 800ms')

    const run = async () => {
      if (physicalPrintFiredRef.current) return
      physicalPrintFiredRef.current = true
      const el = cardRef.current
      if (!el) {
        console.warn('[PHOTO-PRINT] cardRef still null after 800ms — bailing')
        onPrintResolved(false)
        return
      }
      try {
        console.log('[PHOTO-PRINT] rasterizing card via toPng...')
        await measureStage('render.segmentation', () => waitForSegmentation(selectedPhotos))
        await promoteSelectedToFullRes(selectedPhotos)
        await waitForImages(el)
        // Resolve split-cream / etc. so html-to-image gets a VALID CSS
        // colour. Otherwise it sets clone.style.backgroundColor to a
        // garbage value (e.g. '#C08B89-cream') which browsers silently
        // ignore, leaving the cloned card without its paper bg.
        // pixelRatio 5 → ~625 dpi on a 750-CSS-px-wide sheet, saturating the
        // DS620's 600 dpi ceiling. Higher would be wasted; the printer can't
        // resolve past ~600 dpi.
        // LARGE (15x23 cm) prints the SAME composition on a 1.5x bigger
        // cut — 4x6 and 6x9 are both 2:3, so nothing about the layout
        // changes. But the raster must grow with it or the dpi drops:
        // 5 x 1.5 = 7.5 keeps ~625 dpi on the 9-inch dimension, still at
        // the DS620's 600 dpi ceiling. (Same reasoning as the calendar's
        // 7.2 — a bigger sheet at the old pixelRatio prints soft.)
        const isLargePhoto = photoPrintSize === 'large'
        const photoSizeMode = printSizeFor('photo', photoPrintSize)
        const dataUrl = await measureStage('render.raster', () => toPng(el, {
          pixelRatio: isLargePhoto ? 7.5 : 5,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: resolvePaperBg(selectedColor),
          style: { position: 'static', left: '0', top: '0', margin: '0', transform: 'none' },
        }))
        console.log(`[PHOTO-PRINT] toPng done (${(dataUrl.length / 1024).toFixed(1)}KB, ${isLargePhoto ? 'LARGE 15x23' : 'normal 10x15'}), POSTing /api/printer/print at ${photoSizeMode}...`)

        // Mini sheet SWAPS one of the paid prints — it is not an extra one.
        // 3 prints with the swap on = 2 full-size + 1 sheet of 9. The count
        // can never reach 0 here: minPrintCountFor() keeps a mini order at
        // 2+ (normal portraits already start at 2, and large is raised from
        // 1 to 2 when the swap is on) precisely so the customer always walks
        // out with at least one full-size print.
        const wantsMiniSheet = shootType === 'photo' && photoMiniSheet
        const fullSizeCopies = wantsMiniSheet
          ? Math.max(0, (printCount || 1) - 1)
          : (printCount || 1)

        let delivered = true
        if (fullSizeCopies > 0) {
          const r = await callPrint({ imageDataUrl: dataUrl, copies: fullSizeCopies, sizeMode: photoSizeMode })
          delivered = r.delivered
        }
        if (wantsMiniSheet) {
          // Built from the SAME raster, so no second toPng pass. Printed as
          // its own job: one sheet only, never multiplied by printCount.
          console.log('[PHOTO-PRINT] building 9-up mini sheet...')
          const miniUrl = await buildMiniSheet(dataUrl, resolvePaperBg(selectedColor))
          console.log(`[PHOTO-PRINT] mini sheet ready (${(miniUrl.length / 1024).toFixed(1)}KB), POSTing at ${photoSizeMode}...`)
          const r = await callPrint({ imageDataUrl: miniUrl, copies: 1, sizeMode: photoSizeMode })
          // BOTH jobs must land. The money flow captures only after a
          // confirmed print (see project_payment_authorize_then_capture), so
          // a half-delivered order must not report success — the hold is
          // cancelled and the customer is not charged for what they did not get.
          delivered = delivered && r.delivered
        }
        onPrintResolved(delivered)
      } catch (err) {
        console.warn('[PHOTO-PRINT] ❌ Print request error:', (err as Error).message)
        onPrintResolved(false)
      }
    }
    // Small delay so the page paints first.
    const t = window.setTimeout(run, 800)
    return () => window.clearTimeout(t)
  }, [selectedPhotos, printCount, selectedColor, photoPrintSize, photoMiniSheet, shootType, onPrintResolved])

  // Slot layout per frame type — matches the customize page exactly.
  // Each photo slot uses <PhotoLayers> to render the 3-layer stack:
  //   1. original photo (real studio bg visible)
  //   2. 50% paper-colour wash (tints the studio with the chosen colour)
  //   3. MODNet-segmented subject cutout on top (natural skin tones)
  // The filter (B&W / vintage / warm / etc.) is applied to the OUTER
  // print card wrapper, NOT to individual <img>s here, so it composes
  // over subject + tinted bg + frame chrome as one pass.
  const slotTint = resolvePaperTint(selectedColor)
  function imgStyleFor(photoIdx: number): React.CSSProperties {
    const t = photoZoom[photoIdx]
    return {
      position: 'absolute', inset: 0, width: '100%', height: '100%',
      objectFit: 'cover', display: 'block',
      transform: t ? `translate(${t.offsetX}px, ${t.offsetY}px) scale(${t.scale})` : 'none',
      transformOrigin: 'center center',
    }
  }
  function renderSlots(): React.ReactNode {
    if (frameType === '3-cut') {
      const SLOT_H = 250
      return [0, 1, 2].map((slot) => {
        const photoIdx = selectedPhotos[slot]
        return (
          <div key={slot} style={{
            position: 'absolute', left: 0, top: `${slot * SLOT_H}px`,
            width: `${TC.w}px`, height: `${SLOT_H}px`, overflow: 'hidden',
          }}>
            {photoIdx !== undefined && (
              <PhotoLayers
                capturedPhoto={capturedPhotos[photoIdx]}
                segmentedPhoto={segmentedPhotos[photoIdx]}
                tint={slotTint}
                imgStyle={imgStyleFor(photoIdx)}
              />
            )}
          </div>
        )
      })
    }
    if (frameType === '2-cut') {
      const SLOT_H = 375
      return [0, 1].map((slot) => {
        const photoIdx = selectedPhotos[slot]
        return (
          <div key={slot} style={{
            position: 'absolute', left: 0, top: `${slot * SLOT_H}px`,
            width: `${TC.w}px`, height: `${SLOT_H}px`, overflow: 'hidden',
          }}>
            {photoIdx !== undefined && (
              <PhotoLayers
                capturedPhoto={capturedPhotos[photoIdx]}
                segmentedPhoto={segmentedPhotos[photoIdx]}
                tint={slotTint}
                imgStyle={imgStyleFor(photoIdx)}
              />
            )}
          </div>
        )
      })
    }
    if (frameType === '4-cut') {
      const SLOT_W = 250, SLOT_H = 375
      return [0, 1, 2, 3].map((slot) => {
        const col = slot % 2
        const row = Math.floor(slot / 2)
        const photoIdx = selectedPhotos[slot]
        return (
          <div key={slot} style={{
            position: 'absolute', left: `${col * SLOT_W}px`, top: `${row * SLOT_H}px`,
            width: `${SLOT_W}px`, height: `${SLOT_H}px`, overflow: 'hidden',
          }}>
            {photoIdx !== undefined && (
              <PhotoLayers
                capturedPhoto={capturedPhotos[photoIdx]}
                segmentedPhoto={segmentedPhotos[photoIdx]}
                tint={slotTint}
                imgStyle={imgStyleFor(photoIdx)}
              />
            )}
          </div>
        )
      })
    }
    // SOLO ('single' or null) — single photo fills the card.
    return (
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        {selectedPhotos[0] !== undefined && (
          <PhotoLayers
            capturedPhoto={capturedPhotos[selectedPhotos[0]]}
            segmentedPhoto={segmentedPhotos[selectedPhotos[0]]}
            tint={slotTint}
            imgStyle={imgStyleFor(selectedPhotos[0])}
          />
        )}
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}
      style={{
        position: 'relative', width: '1920px', height: '1080px', overflow: 'hidden',
        userSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'manipulation', background: 'transparent',
      }}
    >
      <SessionVideoBackground blur={3} dim={0.55} zIndex={0} />
      {/* No timer on the printing screen — the print job has its own progress bar. */}
      <PageHeader hideTimer />

      <motion.div
        ref={cardRef}
        initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        style={{
          position: 'absolute', left: `${TC.x}px`, top: `${TC.y}px`,
          width: `${TC.w}px`, height: `${TC.h}px`,
          background: resolvePaperBg(selectedColor),
          boxShadow: '0 24px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)',
          overflow: 'hidden',
          // NB: photoFilter is INTENTIONALLY not applied here — see the
          // inner wrapper below. Chrome's foreignObject SVG rasterizer
          // (the engine html-to-image uses) drops `filter:` when it's
          // on the very element being rasterised (the cardRef root).
          // The preview shows it fine because that's live DOM, but the
          // print PNG comes out unfiltered. Moving the filter one level
          // deeper sidesteps the bug — the inner wrapper is a child of
          // the rasterised root, so its filter survives. Verified
          // 2026-05-25.
        }}
      >
        {/* Inner paper-colour layer — duplicates the root card's bg one
            level deeper. html-to-image's `backgroundColor` option
            overwrites the cloned root's inline style.backgroundColor,
            which can wipe out paperColor on the print. Layering the
            same colour underneath the photo slots guarantees the
            segmented subject still sits on the chosen studio colour
            in the rasterized PNG — same pattern that makes the
            postcard print bg work. Sits OUTSIDE the filter wrapper so
            the paper colour itself isn't filtered (filters should only
            touch the photo + frame chrome, not the paper). */}
        <div style={{ position: 'absolute', inset: 0, background: resolvePaperBg(selectedColor) }} />
        {/* Filter wrapper — see comment on the cardRef above. Holds the
            photo slots + the date/wordmark/decorative chrome so a B&W
            or vintage filter composes over them as a single pass. */}
        <div style={{ position: 'absolute', inset: 0, filter: photoFilter }}>
          {renderSlots()}
          <PrintCardBrandingOverlay language={language} top={703} paperColor={selectedColor} />
        </div>
      </motion.div>

      <PrintingRightPanel percent={percent} language={language} cloudToken={cloudToken} />

      {phase === 'failed' && <PrintFailedOverlay />}
    </motion.div>
  )
}

/* ── Postcard printing screen (Figma 1920×1080) ──────────────────
   Shared layout with PhotoIdPrinting: postcard preview on the left,
   glass panel on the right with title / progress / "do not leave" /
   QR download.                                                      */

const POSTCARD_PRINT_PANEL = { x: 925, y: 277, w: 868, h: 620, radius: 100 }

function formatPostcardDate(language: 'en' | 'fr' | 'ko'): string {
  const d = new Date()
  const day = String(d.getDate()).padStart(2, '0')
  const year = d.getFullYear()
  if (language === 'fr') {
    const months = ['JAN', 'FÉV', 'MARS', 'AVR', 'MAI', 'JUIN', 'JUIL', 'AOÛT', 'SEPT', 'OCT', 'NOV', 'DÉC']
    return `${day} ${months[d.getMonth()]} ${year}`
  }
  if (language === 'ko') {
    return `${year}년 ${d.getMonth() + 1}월 ${day}일`
  }
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  return `${day} ${months[d.getMonth()]} ${year}`
}

function PostcardPrinting() {
  const {
    language, capturedPhotos, segmentedPhotos, selectedPhotos, photoZoom, paperBackground, selectedFilter,
    cloudToken, printCount,
  } = useSessionStore()

  const cardRef = useRef<HTMLDivElement>(null)
  // percent / phase / capture-or-cancel + navigation owned by usePrintFlow.
  const { percent, phase, onPrintResolved } = usePrintFlow()

  const PANEL = POSTCARD_PRINT_PANEL
  const PC = { x: 128, y: 332, w: 750, h: 500 }
  const SLOT = { w: 334, h: 250 }

  const selectedColor = paperBackground || NULL_PAPER
  const photoFilter = resolvePrintFilterCss(selectedFilter)

  // Adapt ink colours to the chosen paper for legibility
  const isDarkPaper = (() => {
    const m = /^#([0-9a-f]{6})$/i.exec(selectedColor)
    if (!m) return false
    const r = parseInt(m[1].slice(0, 2), 16)
    const g = parseInt(m[1].slice(2, 4), 16)
    const b = parseInt(m[1].slice(4, 6), 16)
    return (r * 299 + g * 587 + b * 114) / 1000 < 128
  })()
  // Light-paper soft ink bumped 0.2 → 0.3 on 2026-07-06 (operator: printed
  // address lines / stamp box too faint) — matches the same bump in
  // resolvePaperPalette so preview and print stay identical.
  const inkSoft = isDarkPaper ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)'
  // Date + city get their own, stronger inks (operator tuning 2026-07-05:
  // date 20% → 40%, PARIS FRANCE 50% → 75%). Sourced from the shared
  // palette so the customize preview and the printed card stay identical.
  const { inkDate, inkCity } = resolvePaperPalette(selectedColor)

  // Physical print — fire the postcard off to /api/printer/print once.
  // Same StrictMode-safe pattern as Calendar/Photo/PhotoId variants: the
  // already-fired ref check lives inside run() so the first mount's
  // cleanup cancels its timeout, and the re-mount schedules a fresh one
  // that fires 800ms later and runs exactly once.
  const physicalPrintFiredRef = useRef(false)
  useEffect(() => {
    if (!selectedPhotos.length) return
    console.log('[POSTCARD-PRINT] effect armed, will run in 800ms')

    const run = async () => {
      if (physicalPrintFiredRef.current) return
      physicalPrintFiredRef.current = true
      const el = cardRef.current
      if (!el) {
        console.warn('[POSTCARD-PRINT] cardRef still null after 800ms — bailing')
        onPrintResolved(false)
        return
      }
      try {
        console.log('[POSTCARD-PRINT] rasterizing card via toPng...')
        await measureStage('render.segmentation', () => waitForSegmentation(selectedPhotos))
        await promoteSelectedToFullRes(selectedPhotos)
        await waitForImages(el)
        // Postcard's outer card is white (right half) and the photo
        // slots carry their own paperColor bg, so this canvas-fallback
        // colour only matters for transparent regions of the clone.
        // Keep it white to match the right half of the postcard.
        // pixelRatio 5 → ~625 dpi on a 750-CSS-px-wide sheet, saturating the
        // DS620's 600 dpi ceiling. Higher would be wasted; the printer can't
        // resolve past ~600 dpi.
        const dataUrl = await measureStage('render.raster', () => toPng(el, {
          pixelRatio: 5,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: '#FDFDFD',
          style: { position: 'static', left: '0', top: '0', margin: '0', transform: 'none' },
        }))
        // Postcard is the only landscape variant. The DNP DS620 driver
        // defaults to portrait 4×6 (1200×1800) and won't auto-rotate
        // landscape input — it squishes the 3:2 image into the 2:3
        // page. Rotating the PNG 90° CW here makes it portrait-aspect
        // (500×750) so the driver fills the paper crisply edge to edge.
        // The customer rotates the physical print 90° in hand to view
        // it as a landscape postcard, which is the normal handling for
        // 4×6 postcards anyway.
        const rotated = await rotatePngDataUrl90CW(dataUrl)
        console.log(`[POSTCARD-PRINT] toPng done (${(dataUrl.length / 1024).toFixed(1)}KB), rotated to ${(rotated.length / 1024).toFixed(1)}KB, POSTing /api/printer/print...`)
        const { delivered } = await callPrint({ imageDataUrl: rotated, copies: printCount || 1 })
        onPrintResolved(delivered)
      } catch (err) {
        console.warn('[POSTCARD-PRINT] ❌ Print request error:', (err as Error).message)
        onPrintResolved(false)
      }
    }
    const t = window.setTimeout(run, 800)
    return () => window.clearTimeout(t)
  }, [selectedPhotos, printCount, onPrintResolved])

  const labels = {
    fr: {
      printing: 'IMPRESSION EN COURS',
      doNotLeave: 'VEUILLEZ NE PAS PARTIR',
      printsArriving: 'VOS TIRAGES ARRIVENT',
      digitalPhotos: 'RECEVEZ VOS PHOTOS EN NUMÉRIQUE',
      scan: 'SCANNEZ POUR TÉLÉCHARGER SUR VOTRE TÉLÉPHONE',
    },
    en: {
      printing: 'PRINTING IN PROGRESS',
      doNotLeave: 'PLEASE DO NOT LEAVE',
      printsArriving: 'YOUR PRINTS ARE COMING',
      digitalPhotos: 'GET YOUR PHOTOS DIGITALLY',
      scan: 'SCAN TO DOWNLOAD ON YOUR PHONE',
    },
    ko: {
      printing: '프린트 중',
      doNotLeave: '잠시만 기다려 주세요',
      printsArriving: '프린트 중입니다',
      digitalPhotos: '디지털 사진 받기',
      scan: '휴대폰으로 다운로드하려면 스캔하세요',
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
      {/* Recorded session video plays as a soft, blurred backdrop while the
          tirage prints. Sits behind every other layer — z-index < 0. */}
      <SessionVideoBackground blur={3} dim={0.55} zIndex={0} />

      {/* No timer on the printing screen — the print job has its own progress bar. */}
      <PageHeader hideTimer />

      {/* Postcard preview (left) — same shape & content as customize step */}
      <motion.div
        ref={cardRef}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        style={{
          position: 'absolute',
          left: `${PC.x}px`,
          top: `${PC.y}px`,
          width: `${PC.w}px`,
          height: `${PC.h}px`,
          background: '#FDFDFD',
          boxShadow: '0 24px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)',
          overflow: 'hidden',
          // NB: photoFilter intentionally NOT applied here — moved to the
          // inner wrapper below. Chrome's foreignObject SVG rasterizer
          // (used by html-to-image) drops `filter:` set on the very
          // element being rasterised. Preview shows it (live DOM), print
          // PNG doesn't. One level of indirection works around it.
        }}
      >
      {/* Filter wrapper — see note on the cardRef above. Holds every
          drawable child of the postcard so a B&W / vintage filter
          composes over photos + paper-colour right half + date /
          wordmark / lines as a single pass. */}
      <div style={{ position: 'absolute', inset: 0, filter: photoFilter }}>
        {/* Top photo slot — 3-layer render (original studio bg + 50%
            paper-colour wash + segmented customer cutout). Same pattern
            as PHOTO solo/split/triptych/grid. */}
        <div style={{ position: 'absolute', left: 0, top: 0, width: `${SLOT.w}px`, height: `${SLOT.h}px`, overflow: 'hidden' }}>
          {selectedPhotos[0] !== undefined && (
            <PhotoLayers
              capturedPhoto={capturedPhotos[selectedPhotos[0]]}
              segmentedPhoto={segmentedPhotos[selectedPhotos[0]]}
              tint={resolvePaperTint(selectedColor)}
              imgStyle={(() => {
                const t = photoZoom[selectedPhotos[0]]
                return {
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'cover', display: 'block',
                  transform: t ? `translate(${t.offsetX}px, ${t.offsetY}px) scale(${t.scale})` : 'none',
                  transformOrigin: 'center center',
                }
              })()}
            />
          )}
        </div>
        <div style={{ position: 'absolute', left: 0, top: `${SLOT.h}px`, width: `${SLOT.w}px`, height: `${SLOT.h}px`, overflow: 'hidden' }}>
          {selectedPhotos[1] !== undefined && (
            <PhotoLayers
              capturedPhoto={capturedPhotos[selectedPhotos[1]]}
              segmentedPhoto={segmentedPhotos[selectedPhotos[1]]}
              tint={resolvePaperTint(selectedColor)}
              imgStyle={(() => {
                const t = photoZoom[selectedPhotos[1]]
                return {
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'cover', display: 'block',
                  transform: t ? `translate(${t.offsetX}px, ${t.offsetY}px) scale(${t.scale})` : 'none',
                  transformOrigin: 'center center',
                }
              })()}
            />
          )}
        </div>
        <div style={{ position: 'absolute', left: `${SLOT.w}px`, top: 0, width: `${PC.w - SLOT.w}px`, height: `${PC.h}px`, background: resolvePaperBg(selectedColor) }} />
        <div style={{ position: 'absolute', left: '432px', top: '33px', width: '96px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
          <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '10px', lineHeight: '12px', letterSpacing: '0.05em', color: inkDate, whiteSpace: 'nowrap' }}>
            {formatPostcardDate(language)}
          </div>
          <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '10px', lineHeight: '12px', letterSpacing: '0.05em', color: inkCity, whiteSpace: 'nowrap' }}>
            PARIS, FRANCE
          </div>
        </div>
        <div style={{ position: 'absolute', left: '606px', top: '30px', width: '124px', height: '156px', border: `1px solid ${inkSoft}`, boxSizing: 'border-box' }} />
        {[290, 338, 386, 434].map((y) => (
          <div key={y} style={{ position: 'absolute', left: '355px', top: `${y}px`, width: '375px', height: '1px', background: inkSoft }} />
        ))}
        <div style={{ position: 'absolute', left: '613px', top: '453px', width: '89px', height: '32px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          {/* Wordmark uses resolveWordmarkInk (split → colored half, else
              #FDFDFD) — the rest of the calendar chrome stays on the
              palette's inkMid for contrast. Matches preview surfaces. */}
          <CapturismMark width={80} ink={resolveWordmarkInk(selectedColor)} />
        </div>
      </div>
      </motion.div>

      {/* Right glass panel — same layout as PhotoIdPrinting */}
      <motion.div
        initial={{ opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.45, delay: 0.15 }}
        style={{
          position: 'absolute',
          left: `${PANEL.x}px`,
          top: `${PANEL.y}px`,
          width: `${PANEL.w}px`,
          height: `${PANEL.h}px`,
        }}
      >
        <FigmaGlassCard width={PANEL.w} height={PANEL.h} radius={PANEL.radius}>
          <div style={{ position: 'absolute', left: `${1174 - PANEL.x}px`, top: `${355 - PANEL.y}px`, width: '370px', height: '36px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '30px', lineHeight: '36px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
            {labels.printing}
          </div>
          <div style={{ position: 'absolute', left: `${1174 - PANEL.x}px`, top: `${PANEL.y + 78 + 36 + 43 - PANEL.y}px`, width: '370px', height: '3px', background: 'rgba(255,255,255,0.2)', borderRadius: '1.5px', overflow: 'hidden' }}>
            <motion.div animate={{ width: `${percent}%` }} transition={{ duration: 0.2, ease: 'linear' }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'rgba(255,255,255,0.85)', borderRadius: '1.5px' }} />
          </div>
          <div style={{ position: 'absolute', left: `${1330 - PANEL.x}px`, top: `${448 - PANEL.y}px`, width: '58px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD' }}>
            {percent}%
          </div>
          <div style={{ position: 'absolute', left: `${1259 - PANEL.x}px`, top: `${552 - PANEL.y}px`, width: '199px', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD' }}>
            <div style={{ whiteSpace: 'nowrap' }}>{labels.doNotLeave}</div>
            <div style={{ whiteSpace: 'nowrap' }}>{labels.printsArriving}</div>
          </div>
          <div style={{ position: 'absolute', left: `${1204 - PANEL.x}px`, top: `${674 - PANEL.y}px`, width: '311px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
            {labels.digitalPhotos}
          </div>
          <div style={{ position: 'absolute', left: `${1309 - PANEL.x}px`, top: `${715 - PANEL.y}px`, width: '100px', height: '100px', background: '#FFFFFF', borderRadius: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
            <DownloadQR cloudToken={cloudToken} size={84} />
          </div>
          <div style={{ position: 'absolute', left: `${1140 - PANEL.x}px`, top: `${838 - PANEL.y}px`, width: '439px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
            {labels.scan}
          </div>
        </FigmaGlassCard>
      </motion.div>

      {phase === 'failed' && <PrintFailedOverlay />}
    </motion.div>
  )
}

/* ── Default fallthrough — photo-ID printing ─────────────────
   Extracted from the dispatcher below so the hooks here aren't
   called conditionally on shootType (rules-of-hooks). */

function PhotoIdPrinting() {
  const navigate = useNavigate()
  const {
    frameType, setCurrentStep, shootType,
    capturedPhotos, selectedPhotos, photoTimestampsMs, selectedFilter,
    paperBackground, calendarMonth, calendarYear,
    language, customNames, printCount,
    cloudToken, setCloudToken,
  } = useSessionStore()
  const [phase, setPhase] = useState<Phase>('printing')
  const [progress, setProgress] = useState(0)
  const cardRef = useRef<HTMLDivElement>(null)

  const photos = selectedPhotos.map(i => capturedPhotos[i]).filter(Boolean)
  const filterCss = resolveFilterCss(selectedFilter)
  const paperBg = PAPER_BACKGROUNDS.find(p => p.key === paperBackground) || PAPER_BACKGROUNDS[0]

  // Render the card and upload to the gallery so the QR-scan page has a PNG
  // to show. We prefer the SERVER render (single source of truth for "what
  // prints on paper") and only fall back to DOM rasterization via html-to-
  // image when we don't have a server template for the current product yet.
  //
  // The gallery endpoint expects a base64 dataURL inside `{ photos: [...] }`,
  // so we convert the server PNG blob before posting — keeps the gallery
  // upload shape stable while the source of the bytes changes underneath.
  useEffect(() => {
    if (photos.length === 0) return
    const renderAndUpload = async () => {
      try {
        // Brief delay so the "printing..." phase has time to show on screen.
        await new Promise(r => setTimeout(r, 800))

        let dataUrl: string | null = null

        // 1. Preferred path: server-rendered PNG via /api/render.
        const serverPng = await renderCardServer({
          shootType,
          frameType,
          photos,
          paperBg,
          filter: selectedFilter,
          caption: customNames,
        })
        if (serverPng) {
          dataUrl = await blobToDataUrl(serverPng)
          console.log('[PRINT] Using server-rendered card for gallery')
        }

        // 2. Fallback: rasterize the visible DOM card (html-to-image). Used
        //    for shoot types we don't have a server template for yet
        //    (calendar, photo_id, 2-cut, 3-cut, single). Pin width/height to
        //    the element's box and override position so the cloned root
        //    renders at (0,0) — see PostcardPrinting for the same fix.
        if (!dataUrl && cardRef.current) {
          const el = cardRef.current
          await measureStage('render.segmentation', () => waitForSegmentation(selectedPhotos))
          await promoteSelectedToFullRes(selectedPhotos)
          await waitForImages(el)
          dataUrl = await measureStage('render.raster', () => toPng(el, {
            pixelRatio: 4,
            width: el.offsetWidth,
            height: el.offsetHeight,
            style: {
              position: 'static',
              left: '0',
              top: '0',
              margin: '0',
              transform: 'none',
            },
            backgroundColor: '#FAFAF8',
          }))
          console.log('[PRINT] Using DOM-rasterized card for gallery (no server template)')
        }

        if (!dataUrl) {
          console.warn('[PRINT] No card image produced — skipping gallery upload')
          return
        }

        // Cloud upload (R2 via relay) — produces the token that powers the
        // public /d/<token> download page. Photo + recorded session video
        // (if available) get uploaded together. Photo-ID never reaches this
        // path (it has its own component), so the video here is always from
        // a non-photo-ID flow.
        const sessionVideo = getSessionVideoBlob()
        const selectedTimestamps = selectedPhotos.map((i) => photoTimestampsMs[i] ?? 0)
        const cloudUpload = cloudUploadConfigured
          ? measureStage('render.video', () => composeShareVideos({
              sessionVideo,
              selectedTimestamps,
              shootType,
              frameType,
              printImageDataUrl: dataUrl,
            })).then(async (composed) => {
              // JPEG transcode for the upload copy only — the physical
              // print below and the video-bake above keep the original
              // PNG bytes. ~10× smaller PUT = the QR commits in seconds
              // instead of straddling the 120s timeout.
              const uploadPhoto = await photoBlobForUpload(dataUrl)
              return uploadSessionToCloud({
                photo: uploadPhoto.blob,
                photoContentType: uploadPhoto.contentType,
                video: sessionVideo || undefined,
                videoContentType: sessionVideo ? getSessionVideoMime() : undefined,
                layoutVideo: composed.layoutVideo || undefined,
                storyVideo: composed.storyVideo || undefined,
              })
            })
              .then(token => {
                setCloudToken(token)
                console.log(`[PRINT] Cloud upload complete: token=${token} (video=${!!sessionVideo})`)
              })
              .catch(err => console.warn('[PRINT] Cloud upload failed:', err.message))
          : Promise.resolve()

        const physicalPrint = callPrint({
          imageDataUrl: dataUrl,
          copies: printCount || 1,
        }).then(r => r.delivered)

        const [, printOutcome] = await Promise.allSettled([cloudUpload, physicalPrint])
        const delivered = printOutcome.status === 'fulfilled' ? printOutcome.value === true : false
        // Capture (on success) or cancel (on failure) the held card auth so the
        // customer is never charged for a print they didn't get. This
        // fallthrough is rarely reached — the real Photo-ID flow uses the
        // standalone PhotoIdPrinting screen — but settle still guards the money.
        await settleAuthorizedPayment(delivered)
      } catch (err) {
        console.warn('[PRINT] Card render/upload error:', err)
      }
    }
    renderAndUpload()
    // We intentionally omit paperBg / selectedFilter / customNames from the
    // dep array — this runs once per session (not every time a filter flips).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length])

  // Animate progress over ~8 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(interval)
          return 100
        }
        return p + 1.25
      })
    }, 100)
    return () => clearInterval(interval)
  }, [])

  // Phase transitions
  useEffect(() => {
    if (progress >= 65 && phase === 'printing') setPhase('almost')
    if (progress >= 100 && phase === 'almost') setPhase('done')
  }, [progress, phase])

  // Auto-advance to bye screen
  useEffect(() => {
    if (phase === 'done') {
      const timer = setTimeout(() => {
        setCurrentStep(12)
        navigate('/bye')
      }, 2500)
      return () => clearTimeout(timer)
    }
  }, [phase, navigate, setCurrentStep])

  const phaseText: Record<Phase, string> = {
    printing: t('printingYourPhotos', language),
    almost: t('almostReady', language),
    done: t('done', language),
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'transparent',
        position: 'relative',
        padding: '20px 40px',
      }}
    >
      {/* Recorded session video as a soft, blurred backdrop. Skipped for
          photo-ID because that flow doesn't record. */}
      {shootType !== 'photo_id' && (
        <SessionVideoBackground blur={3} dim={0.55} zIndex={0} />
      )}

      {/* ── Top bar ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          height: '80px',
          flexShrink: 0,
        }}
      >
        <LogoHome>
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}
          >
            <CapturismMark width={170} ink="#44433B" />
          </motion.div>
        </LogoHome>
      </div>

      {/* ── Main content ── */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '80px',
        }}
      >
        {/* Left — same preview as previous page */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.175, 0.885, 0.32, 1.5] }}
        >
          <div ref={cardRef}>
            <StaticPreview
              shootType={shootType}
              frameType={frameType}
              photos={photos}
              filterCss={filterCss}
              paperBg={paperBg}
              calendarMonth={calendarMonth}
              calendarYear={calendarYear}
            />
          </div>
        </motion.div>

        {/* Right — status & progress */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '28px',
          }}
        >
          {/* Status text */}
          <AnimatePresence mode="wait">
            <motion.div
              key={phase}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <span style={{
                fontFamily: "'georgia ballpark', 'Georgia', serif",
                fontSize: '26px',
                fontWeight: 400,
                color: '#44433B',
                letterSpacing: '0.08em',
              }}>
                {phaseText[phase]}
              </span>
              {phase !== 'done' && <LoadingDots />}
            </motion.div>
          </AnimatePresence>

          {/* Progress */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.3 }}
          >
            <ProgressTrack progress={progress} phase={phase} />
          </motion.div>

          {/* Decorative divider */}
          <motion.div
            initial={{ opacity: 0, scaleX: 0 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            style={{
              width: '40px',
              height: '0.5px',
              background: '#C8C8C4',
              marginTop: '4px',
            }}
          />

          {/* Subtle message */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.6 }}
            style={{
              fontFamily: "'georgia ballpark', 'Georgia', serif",
              fontSize: '14px',
              color: '#C0C0BC',
              letterSpacing: '0.06em',
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            {t('pleaseDoNotLeave', language)}<br />
            {t('printsOnTheWay', language)}
          </motion.div>

          {/* QR Code — digital download */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 1.2 }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '10px',
              marginTop: '8px',
            }}
          >
            <div style={{
              width: '40px', height: '0.5px',
              background: '#C8C8C4',
            }} />
            <div style={{
              fontFamily: "'georgia ballpark', 'Georgia', serif",
              fontSize: '15px',
              color: '#44433B',
              letterSpacing: '0.08em',
              fontWeight: 400,
            }}>
              {t('getYourPhotosDigitally', language)}
            </div>
            <div style={{
              background: '#fff',
              borderRadius: '12px',
              padding: '12px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.06)',
            }}>
              <DownloadQR
                cloudToken={cloudToken}
                size={110}
                fgColor="#44433B"
                bgColor="#FFFFFF"
              />
            </div>
            <div style={{
              fontFamily: "'georgia ballpark', 'Georgia', serif",
              fontSize: '12px',
              color: '#AEAEA8',
              letterSpacing: '0.06em',
            }}>
              {t('scanToDownload', language)}
            </div>
          </motion.div>
        </div>
      </div>

      <PageNumber n={10} />
    </div>
  )
}

// The stranger card and the waiting card print their chrome on the white
// caption strip rather than over a photo, so they carry their own ink —
// the same soft grey as the month/mark line directly above it. Keeping
// this row is a deliberate default (owner, 2026-10-10).
const LC_CHROME_INK = '#9CA3AF'

// The stranger card is now full bleed. A stored pool portrait is itself
// a COMPLETE card render — including its own branding row baked in at
// its y 703 — so the image is scaled up and top-anchored: that pushes
// their row out of frame and leaves this card with exactly one. 750/556
// is the old caption-strip crop, kept so the framing is unchanged.
const LC_PORTRAIT_ZOOM = 750 / 556

/* ── l'INCONNU printing screen ───────────────────────────────────
   CONFIRMED at the final pool screen → two SEPARATE 4×6 print jobs:
     1. The visitor's own portrait — identical solo card to PhotoPrinting.
        This job GATES the payment capture (usePrintFlow / onPrintResolved),
        exactly like every other shoot type.
     2. The l'INCONNU card — the matched stranger's portrait, first name,
        IG handle (CONFIG.show_handle_on_card), shared answers, plus the
        standard second-print branding row (date + city — amendment B4).
        BEST-EFFORT: a failure here logs a booth error (warning) but never
        cancels the card authorization. When the pool has no candidate at
        the match floor, the Waiting Card prints instead.
   DECLINED at the final pool screen (amendment B1, strict reciprocity) →
   no match is requested at all; the own-portrait job simply prints TWO
   copies (one job — which also re-enables the DS620's 6×9 auto-gang).
   The matching request runs exactly once (it consumes a distribution on
   the chosen pool entry). On confirmation the composed card is uploaded
   to the pool as part of the cloud-upload pass.                        */

function LostConnectionPrinting() {
  const {
    language, capturedPhotos, selectedPhotos, photoTimestampsMs, segmentedPhotos, photoZoom,
    paperBackground, selectedFilter, shootType, frameType, cloudToken, setCloudToken,
    sessionId, lcAnswers, lcQuizCode, lcQuestions, lcPoolConfirmed, lcMatch, setLcMatch,
    lcMatchPortrait, setLcMatchPortrait, devBypassPayment,
  } = useSessionStore()

  // Amendment B1: a decline at the final confirmation forfeits the match
  // print — the visitor gets a second copy of their own card instead.
  const declined = lcPoolConfirmed !== true

  const cardRef = useRef<HTMLDivElement>(null)
  const lcCardRef = useRef<HTMLDivElement>(null)
  const { percent, phase, onPrintResolved } = usePrintFlow()

  const TC = { x: 253, y: 207, w: 500, h: 750 }
  const selectedColor = paperBackground || NULL_PAPER
  const photoFilter = resolvePrintFilterCss(selectedFilter)
  const koFont = language === 'ko' ? "'Noto Sans KR', 'Inter', sans-serif" : "'Inter', sans-serif"

  // 'pending' → matching in flight; 'matched' → lcMatch + portrait URL
  // ready to render/print; 'waiting' → no candidate at the match floor
  // (or portrait fetch failed) → the Waiting Card prints as the second
  // job; 'declined' → no second card at all (own job prints 2 copies).
  const [matchState, setMatchState] = useState<'pending' | 'matched' | 'waiting' | 'declined'>('pending')

  // ── 1. Matching — exactly once per session (consumes a distribution).
  // Skipped entirely on decline: strict reciprocity means no pool entry
  // is touched for a visitor who kept their portrait out.
  const matchFiredRef = useRef(false)
  useEffect(() => {
    const run = async () => {
      if (matchFiredRef.current) return
      matchFiredRef.current = true
      if (declined) {
        setMatchState('declined')
        return
      }
      const match = await requestPoolMatch(lcAnswers, sessionId, true)
      if (!match) {
        console.log('[LC] no match — waiting card')
        setMatchState('waiting')
        return
      }
      setLcMatch(match)
      const portraitUrl = await fetchMatchPortrait(match.entryId)
      if (!portraitUrl) {
        // Rare: match consumed but the portrait bytes didn't arrive. The
        // waiting card keeps the session whole; flag it for the operator.
        sendBoothError({
          code: 'print_failed', severity: 'warning',
          message: "l'INCONNU: matched portrait failed to load — waiting card printed instead",
          context: { sessionId, entryId: match.entryId },
        })
        setMatchState('waiting')
        return
      }
      setLcMatchPortrait(portraitUrl)
      setMatchState('matched')
      console.log(`[LC] matched: ${match.firstName} (@${match.handle}), score ${match.score}`)
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 2. Cloud upload of the visitor's own card (QR download) + the pool
  // join when they opted in. Same no-abort pipeline as PhotoPrinting —
  // see the ⚠️ comment there; do NOT add cancelled-gated aborts.
  const cloudUploadFiredRef = useRef(false)
  const poolJoinFiredRef = useRef(false)
  useEffect(() => {
    if (!selectedPhotos.length) return
    const run = async () => {
      if (cloudUploadFiredRef.current) return
      cloudUploadFiredRef.current = true
      await new Promise(r => setTimeout(r, 600))
      if (!cardRef.current) return
      try {
        const el = cardRef.current
        await measureStage('render.segmentation', () => waitForSegmentation(selectedPhotos))
        await promoteSelectedToFullRes(selectedPhotos)
        await waitForImages(el)
        const dataUrl = await measureStage('render.raster', () => toPng(el, {
          pixelRatio: 4,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: resolvePaperBg(selectedColor),
          style: { position: 'static', left: '0', top: '0', margin: '0', transform: 'none' },
        }))

        // Pool join — the portrait stored for future strangers is exactly
        // the card this visitor printed. Identity + consents are joined
        // server-side from the redeemed quiz code. Fire-and-forget; a
        // failed join never blocks the session.
        if (!declined && lcQuizCode && !poolJoinFiredRef.current) {
          poolJoinFiredRef.current = true
          void joinPool({
            portraitDataUrl: dataUrl,
            code: lcQuizCode,
            sessionId,
            // Admin-bypassed sessions are the seed/friends-event path.
            seed: devBypassPayment,
          }).then((ok) => {
            if (!ok) {
              sendBoothError({
                code: 'print_failed', severity: 'warning',
                message: "l'INCONNU: pool join failed after confirmation — entry NOT stored",
                context: { sessionId },
              })
            }
          })
        }

        if (cloudUploadConfigured) {
          const video = getSessionVideoBlob()
          const selectedTimestamps = selectedPhotos.map((i) => photoTimestampsMs[i] ?? 0)
          const composed = await measureStage('render.video', () => composeShareVideos({
            sessionVideo: video,
            selectedTimestamps,
            shootType,
            frameType,
            printImageDataUrl: dataUrl,
          }))
          const uploadPhoto = await photoBlobForUpload(dataUrl)
          const token = await uploadSessionToCloud({
            retryForMs: SESSION_UPLOAD_PATIENCE_MS, // background flow: ride out a network blip
            photo: uploadPhoto.blob,
            photoContentType: uploadPhoto.contentType,
            video: video || undefined,
            videoContentType: video ? getSessionVideoMime() : undefined,
            layoutVideo: composed.layoutVideo || undefined,
            storyVideo: composed.storyVideo || undefined,
          })
          setCloudToken(token)
          console.log(`[LC] Cloud upload complete: token=${token}`)
        }
      } catch (err) {
        console.warn('[LC] Cloud upload / pool join failed:', (err as Error).message)
      }
    }
    if (!cloudToken || (!declined && !poolJoinFiredRef.current)) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudToken, setCloudToken, selectedPhotos, selectedColor])

  // ── 3. Physical print #1 — the visitor's own card. Gates payment.
  const physicalPrintFiredRef = useRef(false)
  useEffect(() => {
    if (!selectedPhotos.length) return
    const run = async () => {
      if (physicalPrintFiredRef.current) return
      physicalPrintFiredRef.current = true
      const el = cardRef.current
      if (!el) {
        console.warn('[LC-PRINT] cardRef still null after 800ms — bailing')
        onPrintResolved(false)
        return
      }
      try {
        await measureStage('render.segmentation', () => waitForSegmentation(selectedPhotos))
        await promoteSelectedToFullRes(selectedPhotos)
        await waitForImages(el)
        const dataUrl = await measureStage('render.raster', () => toPng(el, {
          pixelRatio: 5,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: resolvePaperBg(selectedColor),
          style: { position: 'static', left: '0', top: '0', margin: '0', transform: 'none' },
        }))
        // Declined → this single job carries BOTH prints (2 copies of the
        // visitor's own card); confirmed → 1 copy here, the l'INCONNU
        // card follows as job 2.
        const copies = declined ? 2 : 1
        console.log(`[LC-PRINT] own card rasterized (${(dataUrl.length / 1024).toFixed(1)}KB), printing ×${copies}...`)
        const { delivered } = await callPrint({ imageDataUrl: dataUrl, copies })
        onPrintResolved(delivered)
      } catch (err) {
        console.warn('[LC-PRINT] ❌ own-card print error:', (err as Error).message)
        onPrintResolved(false)
      }
    }
    const t = window.setTimeout(run, 800)
    return () => window.clearTimeout(t)
    // `declined` is fixed for the whole screen (set on the confirm screen
    // before navigation) — including it would only re-arm a fired ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPhotos, selectedColor, onPrintResolved])

  // ── 4. Physical print #2 — the l'INCONNU card (or Waiting Card).
  // Fires once the match settles. Best-effort: never touches
  // onPrintResolved (print #1 owns the payment decision).
  const lcPrintFiredRef = useRef(false)
  useEffect(() => {
    if (matchState === 'pending' || matchState === 'declined') return
    const run = async () => {
      if (lcPrintFiredRef.current) return
      lcPrintFiredRef.current = true
      const el = lcCardRef.current
      if (!el) {
        console.warn('[LC-PRINT] lcCardRef null — second card not printed')
        return
      }
      try {
        await waitForImages(el)
        const dataUrl = await measureStage('render.raster', () => toPng(el, {
          pixelRatio: 5,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: '#FDFDFD',
          style: { position: 'static', left: '0', top: '0', margin: '0', transform: 'none' },
        }))
        console.log(`[LC-PRINT] connection card rasterized (${(dataUrl.length / 1024).toFixed(1)}KB, ${matchState}), printing...`)
        const { delivered } = await callPrint({ imageDataUrl: dataUrl, copies: 1 })
        if (!delivered) {
          sendBoothError({
            code: 'print_failed', severity: 'warning',
            message: "l'INCONNU card (second print) failed — customer received their own print only",
            context: { sessionId, matchState },
          })
        }
      } catch (err) {
        console.warn('[LC-PRINT] ❌ connection-card print error:', (err as Error).message)
        sendBoothError({
          code: 'print_failed', severity: 'warning',
          message: "l'INCONNU card (second print) errored — customer received their own print only",
          context: { sessionId, error: (err as Error).message },
        })
      }
    }
    const t = window.setTimeout(run, 400)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchState])

  const slotTint = resolvePaperTint(selectedColor)
  const soloIdx = selectedPhotos[0]
  const soloZoom = soloIdx !== undefined ? photoZoom[soloIdx] : undefined
  const soloImgStyle: React.CSSProperties = {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    objectFit: 'cover', display: 'block',
    transform: soloZoom ? `translate(${soloZoom.offsetX}px, ${soloZoom.offsetY}px) scale(${soloZoom.scale})` : 'none',
    transformOrigin: 'center center',
  }

  const sharedAnswerText = lcMatch
    ? lcMatch.sharedAnswers.map((a) => answerLabel(a, lcQuestions, language)).filter(Boolean).join(' · ')
    : ''

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}
      style={{
        position: 'relative', width: '1920px', height: '1080px', overflow: 'hidden',
        userSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'manipulation', background: 'transparent',
      }}
    >
      <SessionVideoBackground blur={3} dim={0.55} zIndex={0} />
      <PageHeader hideTimer />

      {/* The visitor's own card — identical solo composition to
          PhotoPrinting so the print matches the customize preview. */}
      <motion.div
        ref={cardRef}
        initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        style={{
          position: 'absolute', left: `${TC.x}px`, top: `${TC.y}px`,
          width: `${TC.w}px`, height: `${TC.h}px`,
          background: resolvePaperBg(selectedColor),
          boxShadow: '0 24px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)',
          overflow: 'hidden',
          // filter intentionally NOT here — see PhotoPrinting's cardRef
          // comment (foreignObject rasterizer drops root-level filters).
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: resolvePaperBg(selectedColor) }} />
        <div style={{ position: 'absolute', inset: 0, filter: photoFilter }}>
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            {soloIdx !== undefined && (
              <PhotoLayers
                capturedPhoto={capturedPhotos[soloIdx]}
                segmentedPhoto={segmentedPhotos[soloIdx]}
                tint={slotTint}
                imgStyle={soloImgStyle}
              />
            )}
          </div>
          <PrintCardBrandingOverlay language={language} top={703} paperColor={selectedColor} />
        </div>
      </motion.div>

      {/* The reveal — the l'INCONNU card flips in over the visitor's
          card once the match settles. This same DOM is what print #2
          rasterizes (matched card or waiting card). Declined sessions
          never render it — their second print is a copy of job 1. */}
      {(matchState === 'matched' || matchState === 'waiting') && (
        <motion.div
          ref={lcCardRef}
          initial={{ opacity: 0, scale: 0.92, rotateY: 60 }}
          animate={{ opacity: 1, scale: 1, rotateY: 0 }}
          transition={{ duration: 0.7, delay: 0.2, ease: [0.175, 0.885, 0.32, 1.1] }}
          style={{
            position: 'absolute', left: `${TC.x}px`, top: `${TC.y}px`,
            width: `${TC.w}px`, height: `${TC.h}px`,
            background: '#FDFDFD',
            boxShadow: '0 24px 60px rgba(0,0,0,0.28), 0 4px 12px rgba(0,0,0,0.12)',
            overflow: 'hidden',
          }}
        >
          {matchState === 'matched' && lcMatch && lcMatchPortrait ? (
            <>
              {/* The stranger's portrait, full bleed — no caption strip
                  (owner, 2026-10-10). See LC_PORTRAIT_ZOOM for why it is
                  scaled rather than fitted. */}
              <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
                <img
                  src={lcMatchPortrait}
                  alt=""
                  style={{
                    position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
                    width: `${TC.w * LC_PORTRAIT_ZOOM}px`, height: `${TC.h * LC_PORTRAIT_ZOOM}px`,
                    objectFit: 'cover', objectPosition: 'top center', display: 'block',
                  }}
                />
              </div>
              {/* Scrims. All the chrome on this card is white now that it
                  sits on the photo, and a pool portrait can easily be a
                  light one (cream paper, bright subject) — these are
                  invisible on a dark portrait and the difference between
                  a readable name and none at all on a pale one. */}
              <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '160px', background: 'linear-gradient(to bottom, rgba(0,0,0,0.40), rgba(0,0,0,0))', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '130px', background: 'linear-gradient(to top, rgba(0,0,0,0.34), rgba(0,0,0,0))', pointerEvents: 'none' }} />
              {/* Always Inter — this line is Latin in all three languages
                  (Korean uses the English wording). */}
              <div style={{ position: 'absolute', left: 0, right: 0, top: '44px', textAlign: 'center', fontFamily: "'Inter', sans-serif", fontWeight: 400, fontSize: '13px', lineHeight: '16px', letterSpacing: '0.18em', color: '#FDFDFD', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                {LC_COPY.helloMyNameIs[language]}
              </div>
              <div style={{ position: 'absolute', left: '24px', right: '24px', top: '68px', textAlign: 'center', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '26px', lineHeight: '32px', letterSpacing: '0.08em', color: '#FDFDFD', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                {lcMatch.firstName}
              </div>
              {/* Branding row — white again, because it sits on the photo
                  now rather than on a white strip. The waiting card keeps
                  its grey override: that one really is on paper. */}
              <PrintCardBrandingOverlay language={language} top={703} paperColor="white" />
            </>
          ) : (
            <>
              {/* Waiting Card — no portrait. The visitor's own portrait
                  sits ghosted behind the text (spec §6-alt). */}
              {soloIdx !== undefined && capturedPhotos[soloIdx] && (
                <img
                  src={segmentedPhotos[soloIdx] || capturedPhotos[soloIdx]}
                  alt=""
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: 0.08 }}
                />
              )}
              <div style={{ position: 'absolute', left: '60px', right: '60px', top: '272px', textAlign: 'center', fontFamily: koFont, fontWeight: 300, fontSize: '24px', lineHeight: '38px', letterSpacing: '0.04em', color: '#44433B' }}>
                {LC_COPY.waitingCard[language]}
              </div>
              <div style={{ position: 'absolute', left: 0, right: 0, top: '648px', textAlign: 'center', fontFamily: "'Inter', sans-serif", fontWeight: 400, fontSize: '13px', letterSpacing: '0.08em', color: '#9CA3AF', whiteSpace: 'nowrap' }}>
                {LC_COPY.cardMark[language]} · @capturism.studio
              </div>
              <PrintCardBrandingOverlay language={language} top={703} paperColor="white" ink={LC_CHROME_INK} wordmarkInk={LC_CHROME_INK} />
            </>
          )}
        </motion.div>
      )}

      {/* Right panel — the reveal copy replaces the generic printing
          title; progress + QR are shared with every printing screen.
          Declined sessions get the standard printing panel (there is no
          stranger to reveal). */}
      {declined ? (
        <PrintingRightPanel percent={percent} language={language} cloudToken={cloudToken} />
      ) : (
        <LostConnectionRightPanel
          percent={percent}
          language={language}
          cloudToken={cloudToken}
          sharedAnswerText={matchState === 'matched' ? sharedAnswerText : ''}
        />
      )}

      {phase === 'failed' && <PrintFailedOverlay />}
    </motion.div>
  )
}

function LostConnectionRightPanel({ percent, language, cloudToken, sharedAnswerText }: {
  percent: number
  language: 'en' | 'fr' | 'ko'
  cloudToken: string | null
  sharedAnswerText: string
}) {
  const PANEL = { x: 925, y: 277, w: 868, h: 620, radius: 100 }
  const labels = PRINT_LABELS[language]
  const koFont = language === 'ko' ? "'Noto Sans KR', 'Inter', sans-serif" : "'Inter', sans-serif"
  return (
    <motion.div
      initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.45, delay: 0.15 }}
      style={{ position: 'absolute', left: `${PANEL.x}px`, top: `${PANEL.y}px`, width: `${PANEL.w}px`, height: `${PANEL.h}px` }}
    >
      <FigmaGlassCard width={PANEL.w} height={PANEL.h} radius={PANEL.radius}>
        <div style={{ position: 'absolute', left: '80px', right: '80px', top: '68px', textAlign: 'center', fontFamily: koFont, fontWeight: 300, fontSize: '28px', lineHeight: '36px', letterSpacing: '0.05em', color: '#FDFDFD' }}>
          {LC_COPY.revealTitle[language]}
        </div>
        {sharedAnswerText && (
          <div style={{ position: 'absolute', left: '90px', right: '90px', top: '128px', textAlign: 'center', fontFamily: koFont, fontWeight: 300, fontSize: '17px', lineHeight: '24px', letterSpacing: '0.04em', color: 'rgba(253,253,253,0.85)' }}>
            {LC_COPY.bothChose[language]} {sharedAnswerText}
          </div>
        )}
        <div style={{ position: 'absolute', left: '249px', top: '208px', width: '370px', height: '3px', background: 'rgba(255,255,255,0.2)', borderRadius: '1.5px', overflow: 'hidden' }}>
          <motion.div animate={{ width: `${percent}%` }} transition={{ duration: 0.2, ease: 'linear' }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'rgba(255,255,255,0.85)', borderRadius: '1.5px' }} />
        </div>
        <div style={{ position: 'absolute', left: '405px', top: '224px', width: '58px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD' }}>
          {percent}%
        </div>
        <div style={{ position: 'absolute', left: '334px', top: '285px', width: '199px', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD' }}>
          <div style={{ whiteSpace: 'nowrap' }}>{labels.doNotLeave}</div>
          <div style={{ whiteSpace: 'nowrap' }}>{labels.printsArriving}</div>
        </div>
        <div style={{ position: 'absolute', left: '279px', top: '397px', width: '311px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
          {labels.digitalPhotos}
        </div>
        <div style={{ position: 'absolute', left: '384px', top: '438px', width: '100px', height: '100px', background: '#FFFFFF', borderRadius: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
          <DownloadQR cloudToken={cloudToken} size={84} />
        </div>
        <div style={{ position: 'absolute', left: '215px', top: '560px', width: '439px', height: '18px', fontFamily: "'Inter', sans-serif", fontWeight: 300, fontSize: '15px', lineHeight: '18px', letterSpacing: '0.05em', textAlign: 'center', color: '#FDFDFD', whiteSpace: 'nowrap' }}>
          {labels.scan}
        </div>
      </FigmaGlassCard>
    </motion.div>
  )
}

/* ── Main Component ──────────────────────────────────────── */

// Dispatcher: each shoot-type renders its own component. Hooks live inside
// those leaf components so they aren't called conditionally here
// (rules-of-hooks).
export default function Printing() {
  const shootType = useSessionStore((s) => s.shootType)

  if (shootType === 'postcard') return <PostcardPrinting />
  if (shootType === 'calendar') return <CalendarPrinting />
  if (shootType === 'photo') return <PhotoPrinting />
  if (shootType === 'lost_connection') return <LostConnectionPrinting />
  return <PhotoIdPrinting />
}
