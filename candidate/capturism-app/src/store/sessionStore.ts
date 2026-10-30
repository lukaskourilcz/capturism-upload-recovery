import { resetQrUpload } from '../lib/qrUploadState'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { LcAnswer, LcMatch, LcQuestion, LcQuizRecord } from '../lib/linconnu'

/**
 * localStorage wrapper whose setItem NEVER throws. zustand's persist
 * middleware calls storage.setItem synchronously inside every set(), and
 * a QuotaExceededError there propagates out of the store action into
 * whatever React effect triggered it — with no ErrorBoundary in the app,
 * that unmounts the root and white-screens the kiosk mid-session.
 *
 * The session store holds capturedPhotos as data URLs on the Photo ID
 * path (the crop must transform pixels, so it can't keep the short
 * bridge URL the photo flow stores). Four multi-MB JPEGs can approach
 * Chrome's ~5 MB localStorage ceiling. Persistence is a nice-to-have
 * (survives an accidental F5 mid-session); a customer's live session
 * must never crash because the disk copy didn't fit. On quota failure
 * we drop the persisted copy and keep going — the in-memory store is
 * unaffected.
 */
const safeLocalStorage: Storage = {
  get length() { return localStorage.length },
  clear: () => localStorage.clear(),
  key: (i: number) => localStorage.key(i),
  getItem: (k: string) => localStorage.getItem(k),
  removeItem: (k: string) => localStorage.removeItem(k),
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch (err) {
      // Most likely QuotaExceededError. Best-effort: clear our own key so
      // a later, smaller write can succeed, then swallow. Never rethrow.
      console.warn('[store] persist skipped (localStorage write failed):', (err as Error).name)
      try { localStorage.removeItem(k) } catch { /* ignore */ }
    }
  },
}

interface SessionState {
  language: 'en' | 'fr' | 'ko'
  shootType: 'photo' | 'photo_id' | 'calendar' | 'postcard' | 'lost_connection' | null
  frameType: string | null
  background: string | null
  printCount: number
  /** Photo layouts only: 'normal' = 10x15 cm (4x6 in), 'large' = 15x23 cm
   *  (6x9 in). Both are 2:3, so the SAME composition just prints bigger —
   *  no second set of templates. Postcards and Photo ID never offer it. */
  photoPrintSize: 'normal' | 'large'
  /** Photo layouts only: swap ONE of the paid prints for a sheet of nine
   *  minis of the same composition, +EUR 1 once. The customer who orders 3
   *  prints with this on walks out with 2 prints + 1 sheet of 9 — the sheet
   *  REPLACES a print, it is not an extra one. Deliberately not offered on
   *  Photo ID (government size rules), postcards (worldwide standard) or
   *  calendars (owner, 2026-09-14: "ONLY the portrait mode"). */
  photoMiniSheet: boolean
  // Whether the customer wants the QR-code/download surface (shown on
  // the bye page and possibly future export targets). Toggled on
  // PrintCount via a checkbox; defaults to true since most customers
  // will want the digital copy. Persisted to localStorage with the
  // rest of the session.
  wantsQrCode: boolean
  paymentMethod: 'card' | 'cash' | null
  splitCount: number
  lighting: { top: number; left: number; right: number }
  capturedPhotos: string[]
  /**
   * Offset in milliseconds from the start of the session video recording
   * at which each photo in `capturedPhotos` was captured. Same length and
   * indexing as capturedPhotos. Used by the layout-video compositor to
   * seek the session video to each photo's moment when stitching clips.
   */
  photoTimestampsMs: number[]
  selectedPhotos: number[]
  // Segmented (transparent-background) versions of capturedPhotos, indexed
  // by the same index as capturedPhotos. `null` = not yet processed or
  // segmentation failed (in which case rendering falls back to the
  // original photo). Not persisted — derived from capturedPhotos.
  segmentedPhotos: (string | null)[]
  // Per-photo transform (scale + translation). Indexed by capturedPhotos
  // index. scale is clamped to [1.0, 3.0] and offset is clamped so the
  // photo always fully covers its slot (no blank background ever shows
  // behind the photo). Applied via a single CSS `translate scale` so it
  // propagates faithfully to the html-to-image rasterised print.
  // Default { scale: 1, offsetX: 0, offsetY: 0 } = no transform.
  photoZoom: Record<number, { scale: number; offsetX: number; offsetY: number }>
  selectedFilter: string | null
  finalBackground: string | null
  paperBackground: string | null
  customNames: string
  calendarMonth: number
  calendarYear: number
  currentStep: number
  sessionId: string
  // Wall-clock ms when the current session started (set when the user
  // picks a language on HomePage). Used by App.tsx to detect a stale
  // session on app mount — if the persisted state is older than the
  // idle threshold, we wipe it and force the customer back to HomePage
  // so a previous customer's selections never bleed into a new shoot.
  sessionStartedAt: number | null
  // sessionId of the last session whose booth:session_complete event was
  // sent to the relay. Used to prevent double-counting when PaymentProcessing
  // remounts (StrictMode in dev, accidental back-button navigation, page
  // refresh mid-flow, etc). Reset by reset() at the end of each session.
  lastReportedSessionId: string | null
  cloudToken: string | null
  visaSize: '35x45' | '51x51' | '40x60' | '33x48'
  /**
   * l'INCONNU session state (see lib/linconnu.ts). Only meaningful while
   * shootType === 'lost_connection' (internal id kept from the original
   * spec — the mode was renamed by amendment 1).
   *
   *   lcQuizCode      — the redeemed 6-digit phone-quiz code.
   *   lcAnswers/lcFirstName/lcHandle/lcMarketingConsent — from the
   *                     redeemed quiz record (collected on the phone).
   *   lcQuestions     — the question config fetched at code entry, kept
   *                     here so answer labels survive a mid-session reload.
   *   lcPoolConfirmed — null until the FINAL in-studio confirmation; true
   *                     = portrait enters the pool + match print; false =
   *                     declined → second print of themselves instead
   *                     (strict reciprocity, amendment B1).
   *   lcMatch         — the compatible stranger picked by the relay, or
   *                     null (not yet requested / pool empty → waiting card).
   *   lcMatchPortrait — blob object URL of the stranger's portrait. NOT
   *                     persisted (blob URLs don't survive a reload).
   */
  lcQuizCode: string | null
  lcAnswers: LcAnswer[]
  lcFirstName: string
  lcHandle: string
  lcMarketingConsent: boolean
  lcQuestions: LcQuestion[]
  lcPoolConfirmed: boolean | null
  lcMatch: LcMatch | null
  lcMatchPortrait: string | null
  // Payment terminal status — driven by capturism-server's /api/payment/* in
  // PaymentProcessing.tsx. Other screens can read this to know what happened.
  paymentTransactionStatus:
    | 'idle'
    | 'connecting'
    | 'waiting_card'
    | 'approved'
    | 'declined'
    | 'error'
  paymentDiagnostic: string | null
  paymentLastError: string | null
  /**
   * Operator-only bypass for the payment screen — set true when the
   * operator scans a signed admin QR code on the SE1042 terminal
   * (PaymentMode → "Code" button → AJ/05 scan → HMAC verified server-side).
   * When true, PaymentProcessing skips the real AK→AL pair and just
   * advances to the next screen, so the operator can test the booth
   * flow many times without burning real card auths.
   *
   * Not persisted across reloads (partialize drops it) and cleared by
   * reset() at the end of every session — a real customer arriving
   * after a test session will NOT inherit bypass.
   */
  devBypassPayment: boolean

  /**
   * Whether THIS bypass session should produce a real physical print.
   * Two paths flip devBypassPayment with different intents:
   *   - Logo long-press on Home  → audit. bypassPrint=false → NO print.
   *   - CAP-ADM QR scan          → comp. bypassPrint=true  → print.
   * Only consulted when devBypassPayment is true. Cleared by reset().
   */
  bypassPrint: boolean

  /**
   * Discount percent applied to the session price after the operator (or
   * a promo holder) scans a signed CAP-DSC-NNN-HMAC QR code via the same
   * AJ/05 flow. null = no discount. 1–100 = percent off. The pricing
   * helper (lib/pricing.ts) applies this multiplicatively to the table
   * price; for 100% the session is effectively free (booth still goes
   * through PaymentProcessing but with amountCents=0).
   *
   * Same lifecycle as devBypassPayment: not persisted, cleared by reset().
   */
  discountPercent: number | null

  /**
   * Card-authorization lifecycle for the "authorize → print → capture/cancel"
   * money flow (the SE1042 vending pattern). PaymentProcessing places an
   * authorization (AK) and sets these; the printing screen later CAPTURES
   * (AL at the real amount) on a successful print or CANCELS (AL at 0) on a
   * failed one — see lib/paymentSettlement.ts. Before this flow, the booth
   * captured immediately on the payment screen, so a print failure meant the
   * customer was charged for nothing.
   *
   *   paymentAuthorized   — an AK was approved (or bypassed); a capture/cancel is owed.
   *   authorizedAmountCents — the amount held, to capture verbatim on success.
   *   paymentBypassed     — this authorization was an operator test (no real terminal).
   *   paymentSettled      — the capture/cancel has run; guards against double-settle.
   *
   * All four persist through the multi-screen flow (and a mid-flow reload)
   * and are cleared by reset() at session end.
   */
  paymentAuthorized: boolean
  authorizedAmountCents: number
  paymentBypassed: boolean
  paymentSettled: boolean

  /**
   * Anonymized fingerprint of the card that paid this session — SHA-256
   * (hex, truncated) of the AK response's appInfoText, computed on the
   * kiosk. Powers the admin's "new vs returning clients" stats: the same
   * physical card produces the same appInfoText → same hash on a later
   * visit. null when no real card paid (bypass, 100% promo, appInfo
   * empty). Deliberately NOT persisted to localStorage (partialize drops
   * it) — card-derived data doesn't belong on disk, even hashed.
   */
  cardFingerprint: string | null

  setLanguage: (lang: 'en' | 'fr' | 'ko') => void
  setShootType: (type: 'photo' | 'photo_id' | 'calendar' | 'postcard' | 'lost_connection') => void
  setFrameType: (frame: string) => void
  setBackground: (bg: string) => void
  setPrintCount: (count: number) => void
  setPhotoPrintSize: (size: 'normal' | 'large') => void
  setPhotoMiniSheet: (on: boolean) => void
  setWantsQrCode: (wants: boolean) => void
  setPaymentMethod: (method: 'card' | 'cash') => void
  setSplitCount: (count: number) => void
  setLighting: (lighting: { top: number; left: number; right: number }) => void
  addCapturedPhoto: (photo: string, timestampMs?: number) => void
  setCapturedPhotos: (photos: string[]) => void
  setPhotoTimestampsMs: (timestamps: number[]) => void
  setSelectedPhotos: (indices: number[]) => void
  toggleSelectedPhoto: (index: number) => void
  setSegmentedPhoto: (index: number, dataUrl: string | null) => void
  clearSegmentedPhotos: () => void
  setPhotoZoom: (index: number, transform: { scale: number; offsetX: number; offsetY: number }) => void
  setSelectedFilter: (filter: string) => void
  setFinalBackground: (bg: string) => void
  setPaperBackground: (bg: string) => void
  setCustomNames: (names: string) => void
  setCalendarMonth: (month: number) => void
  setCalendarYear: (year: number) => void
  setSessionId: (id: string) => void
  setSessionStartedAt: (ts: number | null) => void
  setLastReportedSessionId: (id: string | null) => void
  setCloudToken: (token: string | null) => void
  setCurrentStep: (step: number) => void
  setVisaSize: (size: '35x45' | '51x51' | '40x60' | '33x48') => void
  /** Load the redeemed phone-quiz record into the session. */
  setLcRedemption: (record: LcQuizRecord) => void
  setLcQuestions: (questions: LcQuestion[]) => void
  setLcPoolConfirmed: (confirmed: boolean) => void
  setLcMatch: (match: LcMatch | null) => void
  setLcMatchPortrait: (url: string | null) => void
  setPaymentTransactionStatus: (status: SessionState['paymentTransactionStatus']) => void
  setPaymentDiagnostic: (diag: string | null) => void
  setPaymentLastError: (err: string | null) => void
  setDevBypassPayment: (on: boolean) => void
  setBypassPrint: (on: boolean) => void
  setDiscountPercent: (pct: number | null) => void
  /** Record an approved authorization that still owes a capture/cancel. */
  setPaymentAuthorization: (amountCents: number, bypassed: boolean) => void
  /** Mark the held authorization as captured-or-cancelled (idempotency guard). */
  setPaymentSettled: (settled: boolean) => void
  setCardFingerprint: (fp: string | null) => void
  reset: () => void
}

/**
 * Counts how many times the session has been reset. Lives at MODULE scope,
 * not in the store, on purpose: reset() does set(initialState), which would
 * wipe a counter held in state, and a counter that is wiped cannot tell
 * you the session changed.
 *
 * Why it exists: an async job that STARTED in one customer's session (the
 * cloud upload) can FINISH after that session ended, and used to write its
 * result straight into whatever session was current by then. See
 * uploadSessionToCloud, which captures this at the start and refuses to
 * return a token if it has moved. Not persisted — a page reload kills every
 * in-flight promise anyway, so there is nothing to protect across one.
 */
let sessionEpoch = 0
export function getSessionEpoch(): number {
  return sessionEpoch
}

const initialState = {
  language: 'en' as const,
  shootType: null,
  frameType: null,
  background: null,
  printCount: 2,
  photoPrintSize: 'normal' as const,
  photoMiniSheet: false,
  wantsQrCode: true,
  paymentMethod: null,
  splitCount: 1,
  lighting: { top: 3, left: 3, right: 3 },
  capturedPhotos: [],
  photoTimestampsMs: [],
  selectedPhotos: [],
  segmentedPhotos: [],
  photoZoom: {},
  selectedFilter: null,
  finalBackground: null,
  paperBackground: null,
  customNames: '',
  calendarMonth: new Date().getMonth(),
  calendarYear: new Date().getFullYear(),
  currentStep: 1,
  sessionId: '',
  sessionStartedAt: null,
  lastReportedSessionId: null,
  cloudToken: null,
  visaSize: '35x45' as const,
  lcQuizCode: null as string | null,
  lcAnswers: [] as LcAnswer[],
  lcFirstName: '',
  lcHandle: '',
  lcMarketingConsent: false,
  lcQuestions: [] as LcQuestion[],
  lcPoolConfirmed: null as boolean | null,
  lcMatch: null as LcMatch | null,
  lcMatchPortrait: null as string | null,
  paymentTransactionStatus: 'idle' as const,
  paymentDiagnostic: null,
  paymentLastError: null,
  devBypassPayment: false,
  bypassPrint: true,
  discountPercent: null,
  paymentAuthorized: false,
  authorizedAmountCents: 0,
  paymentBypassed: false,
  paymentSettled: false,
  cardFingerprint: null,
}

export const useSessionStore = create<SessionState>()(persist((set) => ({
  ...initialState,

  setLanguage: (lang) => set({ language: lang }),
  setShootType: (type) => set({ shootType: type }),
  setFrameType: (frame) => set({ frameType: frame }),
  setBackground: (bg) => set({ background: bg }),
  setPrintCount: (count) => set({ printCount: count }),
  setPhotoPrintSize: (size) => set({ photoPrintSize: size }),
  setPhotoMiniSheet: (on) => set({ photoMiniSheet: on }),
  setWantsQrCode: (wants) => set({ wantsQrCode: wants }),
  setPaymentMethod: (method) => set({ paymentMethod: method }),
  setSplitCount: (count) => set({ splitCount: count }),
  setLighting: (lighting) => set({ lighting }),
  addCapturedPhoto: (photo, timestampMs) => set((s) => ({
    capturedPhotos: [...s.capturedPhotos, photo],
    photoTimestampsMs: timestampMs != null
      ? [...s.photoTimestampsMs, timestampMs]
      : s.photoTimestampsMs,
  })),
  setCapturedPhotos: (photos) => set({ capturedPhotos: photos }),
  setPhotoTimestampsMs: (timestamps) => set({ photoTimestampsMs: timestamps }),
  setSelectedPhotos: (indices) => set({ selectedPhotos: indices }),
  toggleSelectedPhoto: (index) => set((s) => {
    const current = s.selectedPhotos
    if (current.includes(index)) {
      return { selectedPhotos: current.filter((i) => i !== index) }
    }
    return { selectedPhotos: [...current, index] }
  }),
  setSegmentedPhoto: (index, dataUrl) => set((s) => {
    const next = s.segmentedPhotos.slice()
    while (next.length <= index) next.push(null)
    next[index] = dataUrl
    return { segmentedPhotos: next }
  }),
  clearSegmentedPhotos: () => set({ segmentedPhotos: [] }),
  setPhotoZoom: (index, transform) => set((s) => ({
    photoZoom: { ...s.photoZoom, [index]: transform },
  })),
  setSelectedFilter: (filter) => set({ selectedFilter: filter }),
  setFinalBackground: (bg) => set({ finalBackground: bg }),
  setPaperBackground: (bg) => set({ paperBackground: bg }),
  setCustomNames: (names) => set({ customNames: names }),
  setCalendarMonth: (month) => set({ calendarMonth: month }),
  setCalendarYear: (year) => set({ calendarYear: year }),
  setSessionId: (id) => set({ sessionId: id }),
  setSessionStartedAt: (ts) => set({ sessionStartedAt: ts }),
  setLastReportedSessionId: (id) => set({ lastReportedSessionId: id }),
  setCloudToken: (token) => set({ cloudToken: token }),
  setCurrentStep: (step) => set({ currentStep: step }),
  setVisaSize: (size) => set({ visaSize: size }),
  setLcRedemption: (record) => set({
    lcQuizCode: record.code,
    lcFirstName: record.firstName,
    lcHandle: record.handle,
    lcAnswers: record.answers,
    lcMarketingConsent: record.marketingConsent,
  }),
  setLcQuestions: (questions) => set({ lcQuestions: questions }),
  setLcPoolConfirmed: (confirmed) => set({ lcPoolConfirmed: confirmed }),
  setLcMatch: (match) => set({ lcMatch: match }),
  setLcMatchPortrait: (url) => set({ lcMatchPortrait: url }),
  setPaymentTransactionStatus: (status) => set({ paymentTransactionStatus: status }),
  setPaymentDiagnostic: (diag) => set({ paymentDiagnostic: diag }),
  setPaymentLastError: (err) => set({ paymentLastError: err }),
  setDevBypassPayment: (on) => set({ devBypassPayment: on }),
  setBypassPrint: (on) => set({ bypassPrint: on }),
  setDiscountPercent: (pct) => set({ discountPercent: pct }),
  setPaymentAuthorization: (amountCents, bypassed) => set({
    paymentAuthorized: true,
    authorizedAmountCents: amountCents,
    paymentBypassed: bypassed,
    paymentSettled: false,
  }),
  setPaymentSettled: (settled) => set({ paymentSettled: settled }),
  setCardFingerprint: (fp) => set({ cardFingerprint: fp }),
  reset: () => {
    sessionEpoch += 1
    resetQrUpload()
    set(initialState)
  },
}), {
  name: 'capturism-session',
  // Quota-safe storage: a failed write (large capturedPhotos vs the
  // localStorage ceiling) must never crash the live session — see
  // safeLocalStorage above.
  storage: createJSONStorage(() => safeLocalStorage),
  // segmentedPhotos are large base64 PNGs derived from capturedPhotos.
  // Recompute on reload rather than blowing out localStorage.
  // devBypassPayment + discountPercent are operator-set per session — never
  // persist; the next browser load (e.g. kiosk boot, F5) MUST start with
  // neither active so a refresh during a paid session doesn't accidentally
  // become a free one.
  // lcMatchPortrait is a blob object URL — dead after a reload, so
  // persisting it would only leak a broken reference.
  // cardFingerprint is card-derived (hashed) — never write it to disk.
  partialize: (state) => {
    // cloudToken is excluded: it identifies ONE customer's photos, and a
    // value that survives a reload is a value the next customer can inherit.
    // The upload effect skips uploading whenever a token is already set, so
    // an inherited token means the new customer's photos are never uploaded
    // and their QR opens someone else's.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { segmentedPhotos, devBypassPayment, bypassPrint, discountPercent, lcMatchPortrait, cardFingerprint, cloudToken, ...rest } = state
    return rest
  },
}))