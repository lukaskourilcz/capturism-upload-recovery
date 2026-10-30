import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { toPng } from 'html-to-image'
import { waitForImages } from '../../lib/waitForImages'
import { getSessionEpoch, useSessionStore } from '../../store/sessionStore'
import { PageHeader } from '../layout/PageHeader'
import { FigmaGlassCard } from '../glass/FigmaGlassCard'
import { DownloadQR } from '../DownloadQR'
import { cloudUploadConfigured, photoBlobForUpload, uploadSessionToCloud } from '../../lib/relayUpload'
import { callPrint } from '../../lib/printClient'
import { VISA_SHEET_TEMPLATES } from '../../lib/visaSheetTemplates'
import { rotatePngDataUrl90CW } from '../../lib/rotatePng'
import { CapturismMark } from '../layout/CapturismMark'
import { usePrintFlow } from '../../hooks/usePrintFlow'
import { PrintFailedOverlay } from './PrintFailedOverlay'

// Frame: 1920×1080. Print-sheet on the left (size-specific via
// VISA_SHEET_TEMPLATES). Glass panel (868×620 at 925,277) on the right holds
// the printing-progress UI + QR code.

const PANEL = { x: 925, y: 277, w: 868, h: 620, radius: 100 }

export default function PhotoIdPrinting() {
  const language = useSessionStore((s) => s.language)
  const capturedPhotos = useSessionStore((s) => s.capturedPhotos)
  const selectedPhotos = useSessionStore((s) => s.selectedPhotos)
  const cloudToken = useSessionStore((s) => s.cloudToken)
  const setCloudToken = useSessionStore((s) => s.setCloudToken)
  const visaSize = useSessionStore((s) => s.visaSize)

  const tpl = VISA_SHEET_TEMPLATES[visaSize] || VISA_SHEET_TEMPLATES['35x45']
  const SHEET = tpl.sheet
  const SHEET_SLOTS = tpl.slots

  const chosenIndex = selectedPhotos[0] ?? 0
  const chosenPhoto = capturedPhotos[chosenIndex] ?? null

  const sheetRef = useRef<HTMLDivElement>(null)
  // percent / phase / settle + navigation are owned by usePrintFlow. The
  // print effect below calls onPrintResolved(true|false) when the printer
  // responds; the screen no longer advances on a fixed timer.
  const { percent, phase, onPrintResolved } = usePrintFlow()

  // Physical print — fire the visa sheet to /api/printer/print exactly once.
  // Ref check lives INSIDE run() so React 19 StrictMode's mount → cleanup →
  // re-mount cycle doesn't cancel the timeout before it can fire (same pattern
  // as PhotoPrinting). Photo-ID always prints a single visa sheet, regardless
  // of selectedPhotos count.
  const physicalPrintFiredRef = useRef(false)
  useEffect(() => {
    if (!chosenPhoto) return
    console.log('[PHOTO-ID-PRINT] effect armed, will run in 800ms')

    const run = async () => {
      if (physicalPrintFiredRef.current) return
      physicalPrintFiredRef.current = true
      const el = sheetRef.current
      if (!el) {
        console.warn('[PHOTO-ID-PRINT] sheetRef still null after 800ms — bailing')
        onPrintResolved(false)
        return
      }
      try {
        // Diagnostic: log the SOURCE photo resolution. A real DSLR frame is
        // ~6000×4000 (24 MP); a live-view fallback grab is ~1280×960 (~1 MP).
        // If this prints ~1 MP, the camera fell back to live view and THAT —
        // not the rasterizer — is why the print looks soft. Check the
        // [CAMERA] capture log on the camera screen to confirm.
        if (chosenPhoto) {
          const probe = new Image()
          probe.onload = () => console.log(`[PHOTO-ID-PRINT] source photo resolution: ${probe.naturalWidth}×${probe.naturalHeight}px`)
          probe.src = chosenPhoto
        }
        console.log('[PHOTO-ID-PRINT] rasterizing sheet via toPng...')
        await waitForImages(el)
        // pixelRatio 5: the visa sheet element is only 750×500 CSS px, so a
        // 3× raster capped each photo near 375 dpi. At 5× a 40×60 photo lands
        // ~1000px wide (~625 dpi), matching the DS620's max — visibly sharper
        // faces. The element is small enough that the bigger canvas is cheap.
        const dataUrl = await toPng(el, {
          pixelRatio: 5,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: '#FDFDFD',
          style: { position: 'static', left: '0', top: '0', margin: '0', transform: 'none' },
        })
        // The visa sheet renders LANDSCAPE (750×500, 6:4). The DNP cut
        // is portrait, so rotate 90° CW → 4×6 portrait, filling the
        // paper with no squish. (The visa sizes used to declare 3.5×6
        // sheets, but that cut doesn't exist in the DS620 Windows
        // driver — see the printSize doc in visaSheetTemplates.ts.)
        const rotated = await rotatePngDataUrl90CW(dataUrl)
        const sizeMode = tpl.printSize
        console.log(`[PHOTO-ID-PRINT] toPng done (${(dataUrl.length / 1024).toFixed(1)}KB), rotated, POSTing /api/printer/print at ${sizeMode}...`)
        const { delivered } = await callPrint({ imageDataUrl: rotated, copies: 1, sizeMode })
        onPrintResolved(delivered)
      } catch (err) {
        console.warn('[PHOTO-ID-PRINT] ❌ Print request error:', (err as Error).message)
        onPrintResolved(false)
      }
    }
    const t = window.setTimeout(run, 800)
    return () => window.clearTimeout(t)
  }, [chosenPhoto, tpl.printSize, onPrintResolved])

  // Cloud upload — rasterize the visa sheet (the actual tirage being printed)
  // and push it to R2 so the customer downloads what they see on paper, not
  // just the raw photo. Runs once when the sheet has rendered.
  // Ref-guard (same pattern as the physical-print effect) instead of a
  // `cancelled` flag. CRITICAL: the previous `cancelled`-gated version
  // discarded the token via `if (cancelled) return` right before
  // setCloudToken — so if the customer advanced from this printing screen
  // to the bye screen while the ~2-3 s upload was still in flight, the
  // upload SUCCEEDED but its token was thrown away, leaving the bye page
  // with no token (→ the empty-download-page bug). cloudToken lives in the
  // global Zustand store, so setting it after this component unmounts is
  // safe and the bye page picks it up reactively.
  const uploadFiredRef = useRef(false)
  useEffect(() => {
    if (!chosenPhoto || cloudToken || !cloudUploadConfigured) return
    const run = async () => {
      if (uploadFiredRef.current) return
      uploadFiredRef.current = true
      const uploadEpoch = getSessionEpoch()
      // Small delay so the photo <img> has time to load into the DOM. The
      // toPng below needs sheetRef while still mounted; the upload +
      // setCloudToken that follow are safe to finish post-unmount.
      await new Promise(r => setTimeout(r, 600))
      const el = sheetRef.current
      if (!el) { uploadFiredRef.current = false; return }
      try {
        // Pin width/height to the visible sheet element so the captured PNG
        // is exactly the visa-sheet dimensions. Override position/transform
        // on the cloned root: the sheet is absolutely-positioned within the
        // 1920×1080 booth layout, and html-to-image otherwise honors that
        // offset and pushes the content into a corner with white margins.
        await waitForImages(el)
        const dataUrl = await toPng(el, {
          pixelRatio: 3,
          width: el.offsetWidth,
          height: el.offsetHeight,
          backgroundColor: '#FDFDFD',
          style: {
            position: 'static',
            left: '0',
            top: '0',
            margin: '0',
            transform: 'none',
          },
        })
        // JPEG transcode for the upload copy — ~10× smaller PUT so the QR
        // commits in seconds instead of straddling the 120s timeout.
        const uploadPhoto = await photoBlobForUpload(dataUrl)
        const token = await uploadSessionToCloud({ sessionEpoch: uploadEpoch, photo: uploadPhoto.blob, photoContentType: uploadPhoto.contentType })
        setCloudToken(token) // global store — fine even if we've unmounted
        console.log(`[PHOTO-ID] Cloud upload complete: token=${token}`)
      } catch (err) {
        uploadFiredRef.current = false // allow a retry on transient failure
        console.warn('[PHOTO-ID] Cloud upload failed:', (err as Error).message)
      }
    }
    run()
  }, [chosenPhoto, cloudToken, setCloudToken])

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
      {/* No timer on the printing screen — the print job has its own progress bar. */}
      <PageHeader hideTimer />

      {/* ── Print sheet (left) — 6× chosen photo ──────────── */}
      <motion.div
        ref={sheetRef}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        style={{
          position: 'absolute',
          left: `${SHEET.x}px`,
          top: `${SHEET.y}px`,
          width: `${SHEET.w}px`,
          height: `${SHEET.h}px`,
          background: '#FDFDFD',
          boxShadow: '0 12px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
        }}
      >
        {SHEET_SLOTS.map((slot, i) => {
          const left = slot.x - SHEET.x
          const top = slot.y - SHEET.y
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${left}px`,
                top: `${top}px`,
                width: `${slot.w}px`,
                height: `${slot.h}px`,
                background: chosenPhoto ? '#000' : 'rgba(0,0,0,0.5)',
                overflow: 'hidden',
              }}
            >
              {chosenPhoto && (
                <img
                  src={chosenPhoto}
                  alt=""
                  draggable={false}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              )}
            </div>
          )
        })}

        {/* Mini logo bottom-right — unified CapturismMark (serif CAPTURISM
            + cursive Studio) replacing the old hardcoded text wordmark, so
            the PRINTED visa sheet carries the current logo. */}
        <div
          style={{
            position: 'absolute',
            left: `${tpl.logo.x - SHEET.x}px`,
            top: `${tpl.logo.y - SHEET.y}px`,
            width: '89px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CapturismMark width={tpl.logo.w} ink="rgba(0,0,0,0.5)" />
        </div>
      </motion.div>

      {/* ── Right glass panel — printing progress + QR ──── */}
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
          {/* Title — IMPRESSION EN COURS */}
          <div
            style={{
              position: 'absolute',
              left: `${1174 - PANEL.x}px`,
              top: `${355 - PANEL.y}px`,
              width: '370px',
              height: '36px',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 300,
              fontSize: '30px',
              lineHeight: '36px',
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: '#FDFDFD',
              whiteSpace: 'nowrap',
            }}
          >
            {labels.printing}
          </div>

          {/* Progress bar — 3px rounded line, sits 43px below the title (title
              top 78 + height 36 + 43 = 157, in panel-relative coords) */}
          <div
            style={{
              position: 'absolute',
              left: `${1174 - PANEL.x}px`,
              top: `${PANEL.y + 78 + 36 + 43 - PANEL.y}px`,
              width: '370px',
              height: '3px',
              background: 'rgba(255,255,255,0.2)',
              borderRadius: '1.5px',
              overflow: 'hidden',
            }}
          >
            <motion.div
              animate={{ width: `${percent}%` }}
              transition={{ duration: 0.2, ease: 'linear' }}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                background: 'rgba(255,255,255,0.85)',
                borderRadius: '1.5px',
              }}
            />
          </div>

          {/* Percent text */}
          <div
            style={{
              position: 'absolute',
              left: `${1330 - PANEL.x}px`,
              top: `${448 - PANEL.y}px`,
              width: '58px',
              height: '18px',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 300,
              fontSize: '15px',
              lineHeight: '18px',
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: '#FDFDFD',
            }}
          >
            {percent}%
          </div>

          {/* Please-do-not-leave message — each line must stay on one row */}
          <div
            style={{
              position: 'absolute',
              left: `${1259 - PANEL.x}px`,
              top: `${552 - PANEL.y}px`,
              width: '199px',
              fontFamily: "'Inter', sans-serif",
              fontWeight: 500,
              fontSize: '15px',
              lineHeight: '18px',
              letterSpacing: '0.05em',
              textAlign: 'center',
              color: '#FDFDFD',
            }}
          >
            <div style={{ whiteSpace: 'nowrap' }}>{labels.doNotLeave}</div>
            <div style={{ whiteSpace: 'nowrap' }}>{labels.printsArriving}</div>
          </div>

          {/* Digital photos heading */}
          <div
            style={{
              position: 'absolute',
              left: `${1204 - PANEL.x}px`,
              top: `${674 - PANEL.y}px`,
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
            {labels.digitalPhotos}
          </div>

          {/* QR code box — white square 100×100 with QR centered */}
          <div
            style={{
              position: 'absolute',
              left: `${1309 - PANEL.x}px`,
              top: `${715 - PANEL.y}px`,
              width: '100px',
              height: '100px',
              // QR wrapper — pure white to match the QR's bgColor for clean
              // scanner contrast. NOT the design-system #FDFDFD.
              background: '#FFFFFF',
              borderRadius: '5px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
            }}
          >
            <DownloadQR cloudToken={cloudToken} size={84} />
          </div>

          {/* Scan instruction */}
          <div
            style={{
              position: 'absolute',
              left: `${1140 - PANEL.x}px`,
              top: `${838 - PANEL.y}px`,
              width: '439px',
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
            {labels.scan}
          </div>
        </FigmaGlassCard>
      </motion.div>

      {phase === 'failed' && <PrintFailedOverlay />}
    </motion.div>
  )
}
