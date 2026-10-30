import { diagnosticFetch } from './diagnostics'
/**
 * l'INCONNU — session mode (formerly "Lost Connection"; renamed by spec
 * amendment 1. Internal identifiers — shootType 'lost_connection', the
 * 'lostConnection' revenue category, the pool/ R2 prefixes — keep the
 * original names so persisted data and admin stats stay stable).
 *
 * Amendment-1 architecture: the quiz lives on the visitor's PHONE
 * (capturism-quiz web app). They get a 6-digit code, bring it to the
 * studio, and the kiosk redeems it for their quiz record (name, handle,
 * answers, consents — all collected and validated server-side). After
 * the shoot and customize steps, a FINAL confirmation screen shows the
 * actual portrait that would enter the pool; declining forfeits the
 * match print and prints a second copy of their own card instead
 * (strict reciprocity, amendment B1).
 *
 * Everything mode-specific is centralised here:
 *   - kill switch + pool-size gating
 *   - the quiz URL (QR on the code-entry screen)
 *   - CONFIG.show_handle_on_card (amendment B4 — pending Claire:
 *     handle on the card vs first-name-only mystery mode)
 *   - all kiosk-side copy (fr/en/ko)
 *   - the relay API client (via the bridge proxy at /api/relay/* so the
 *     booth key stays out of the browser)
 *
 * Question content lives in ONE place: capturism-relay/questions.json,
 * served at GET /api/quiz/config. The kiosk fetches it at code entry
 * (for answer labels on the reveal + card) — Claire's final set is a
 * config-only swap.
 */

export type LcLang = 'en' | 'fr' | 'ko'
export type LcText = Record<LcLang, string>

export interface LcAnswerOption {
  id: string
  text: LcText
}

export interface LcQuestion {
  id: string
  text: LcText
  options: LcAnswerOption[]
}

export interface LcAnswer {
  questionId: string
  answerId: string
}

export interface LcMatch {
  entryId: string
  firstName: string
  handle: string
  /** ISO timestamp of the matched entry's visit (render month + year only). */
  createdAt: string
  score: number
  sharedAnswers: LcAnswer[]
}

/** The redeemed phone-quiz record, as returned by the relay. */
export interface LcQuizRecord {
  code: string
  firstName: string
  handle: string
  language: LcLang
  answers: LcAnswer[]
  marketingConsent: boolean
}

/**
 * Per-machine kill switch (VITE_LINCONNU_DISABLED). The
 * pool-size gate (min_pool) is enforced by the relay via /pool/status —
 * this switch is for turning the whole mode off on a booth.
 */
const LC_DISABLED =
  (typeof import.meta !== 'undefined'
    ? import.meta.env?.VITE_LINCONNU_DISABLED
    : undefined) === '1'

export function isLinconnuEnabled(): boolean {
  return !LC_DISABLED
}

/**
 * Amendment B4, DECIDED by Claire 2026-08-21: cards are FIRST-NAME-ONLY
 * (NYC-style mystery mode). The Instagram handle is now collected on the
 * quiz only with the optional marketing consent, purely so Capturism can
 * credit the person in its own posts — most pool entries won't have one
 * at all. Flip back to true only if the decision reverses AND the quiz
 * resumes collecting handles for everyone.
 */
export const SHOW_HANDLE_ON_CARD = false

/**
 * The public phone-quiz URL — Instagram bio, café-table QR, press.
 * linconnu.capturism.com is a Cloudflare Pages custom domain on the
 * capturism-linconnu project (owner decision 2026-08-20; the
 * *.pages.dev URL keeps working as a fallback). Overridable per-machine
 * with VITE_LINCONNU_QUIZ_URL — no code change.
 */
export const QUIZ_URL: string =
  (typeof import.meta !== 'undefined'
    ? (import.meta.env?.VITE_LINCONNU_QUIZ_URL as string | undefined)
    : undefined) || 'https://linconnu.capturism.com'

// ─── Copy (fr / en / ko) ────────────────────────────────────────────
// "l'INCONNU" is the mode's brand name in every language. KR is working
// copy — Claire (native) reviews all Korean before ship.

export const LC_COPY = {
  // Capital L, deliberately. Set in all-caps Inter, a lowercase "l" is an
  // unadorned vertical stroke indistinguishable from capital "I", so the
  // kiosk was reading "I'INCONNU" (operator, 2026-09-05). The brand is
  // still written l'INCONNU in prose and lowercase UI (admin sidebar).
  brand: { en: "L'INCONNU", fr: "L'INCONNU", ko: "L'INCONNU" } as LcText,
  codeTitle: {
    en: 'Enter your code',
    fr: 'Entrez votre code',
    ko: '코드를 입력하세요',
  } as LcText,
  codeSubtitle: {
    en: 'The 6-digit code from the quiz on your phone.',
    fr: 'Le code à 6 chiffres du quiz sur votre téléphone.',
    ko: '휴대폰 퀴즈에서 받은 6자리 코드입니다.',
  } as LcText,
  noCodeYet: {
    en: 'No code yet? The quiz takes 90 seconds —',
    fr: 'Pas encore de code ? Le quiz prend 90 secondes —',
    ko: '아직 코드가 없나요? 퀴즈는 90초면 충분합니다 —',
  } as LcText,
  codeInvalid: {
    en: 'This code has expired or was already used — the quiz takes 90 seconds:',
    fr: 'Ce code a expiré ou a déjà été utilisé — le quiz prend 90 secondes :',
    ko: '이 코드는 만료되었거나 이미 사용되었습니다 — 퀴즈는 90초면 충분합니다:',
  } as LcText,
  codeNetworkError: {
    en: 'Connection hiccup — try the code again.',
    fr: 'Petit souci de connexion — réessayez le code.',
    ko: '연결이 원활하지 않습니다 — 코드를 다시 입력해 주세요.',
  } as LcText,
  codeWelcome: {
    en: 'Welcome, {name}.',
    fr: 'Bienvenue, {name}.',
    ko: '{name}님, 환영합니다.',
  } as LcText,
  confirmTitle: {
    en: 'This is the portrait that will wait in the pool.',
    fr: 'Voici le portrait qui attendra dans le pool.',
    ko: '풀에서 기다리게 될 초상은 바로 이 사진입니다.',
  } as LcText,
  confirmBody: {
    en: 'A compatible stranger will one day walk out with it — your first name printed on it. Confirm?',
    fr: 'Un·e inconnu·e compatible repartira un jour avec — votre prénom imprimé dessus. Vous confirmez ?',
    ko: '언젠가 당신과 닮은 답을 한 낯선 사람이 이 사진을 가져가게 됩니다 — 이름이 함께 인쇄됩니다. 확인하시겠어요?',
  } as LcText,
  confirmCta: {
    en: 'Yes — my portrait enters the pool',
    fr: 'Oui — mon portrait entre dans le pool',
    ko: '네 — 제 초상을 풀에 남깁니다',
  } as LcText,
  confirmDecline: {
    en: 'No — print a second one of me instead',
    fr: 'Non — imprimez-moi un deuxième tirage à la place',
    ko: '아니요 — 대신 제 사진을 한 장 더 인쇄할게요',
  } as LcText,
  // Withdrawal note under the confirm CTA (amendment 2 §1) — the address
  // AND the exact subject line, verbatim in every language. The subject
  // stays identical (untranslated) so requests are filterable.
  confirmWithdraw: {
    en: 'Withdraw anytime: email paris@capturism.com — subject “L’INCONNU — RETRAIT”',
    fr: 'Retrait à tout moment : paris@capturism.com — objet « L’INCONNU — RETRAIT »',
    ko: '철회는 언제든 가능: paris@capturism.com — 제목 “L’INCONNU — RETRAIT”',
  } as LcText,
  // Printed across the top of the stranger's card (owner reference,
  // 2026-10-10). The stranger introduces themselves; the name follows
  // on its own line underneath.
  helloMyNameIs: {
    en: 'Hi, my name is',
    fr: 'Bonjour, je m’appelle',
    // Korean stays on the English line (owner, 2026-10-10) — like the
    // mode's own name, it reads as part of the mark rather than as copy
    // to translate. Keep it Latin: the card sets this in Inter.
    ko: 'Hi, my name is',
  } as LcText,
  revealTitle: {
    en: 'Your inconnu·e is on the way…',
    fr: 'Votre inconnu·e arrive…',
    ko: '당신의 inconnu가 나오는 중…',
  } as LcText,
  bothChose: {
    en: 'You both chose:',
    fr: 'Vous avez choisi tou·te·s les deux :',
    ko: '두 사람 모두 이렇게 답했습니다:',
  } as LcText,
  waitingCard: {
    en: 'Your inconnu·e hasn’t walked in yet. Your portrait waits for them.',
    fr: 'Votre inconnu·e n’est pas encore entré·e. Votre portrait l’attend.',
    ko: '당신의 인연은 아직 이곳에 오지 않았습니다. 당신의 초상이 그를 기다립니다.',
  } as LcText,
  cardMark: {
    en: 'l’Inconnu — Capturism Studio',
    fr: 'l’Inconnu — Capturism Studio',
    ko: 'l’Inconnu — Capturism Studio',
  } as LcText,
}

/** "June 2026" / "juin 2026" / "2026년 6월" — poetic, not clinical. */
export function formatVisitMonth(iso: string, lang: LcLang): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'ko' ? 'ko-KR' : 'en-GB'
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(d)
}

// ─── Question config (fetched from the relay, cached per app load) ──

let cachedQuestions: LcQuestion[] | null = null

/**
 * The question set from capturism-relay/questions.json, via the bridge
 * proxy. Cached in-module; also mirrored into the session store by the
 * code-entry screen so answer labels survive a mid-session reload.
 */
export async function fetchQuizConfig(): Promise<LcQuestion[] | null> {
  if (cachedQuestions) return cachedQuestions
  try {
    const res = await fetch('/api/relay/quiz/config', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const data = await res.json()
    if (Array.isArray(data?.questions) && data.questions.length) {
      cachedQuestions = data.questions as LcQuestion[]
      return cachedQuestions
    }
    return null
  } catch (err) {
    console.warn('[linconnu] quiz config unavailable:', (err as Error).message)
    return null
  }
}

/** Option label for a stored answer, from an explicit question list. */
export function answerLabel(a: LcAnswer, questions: LcQuestion[], lang: LcLang): string | null {
  const q = questions.find((qq) => qq.id === a.questionId)
  const opt = q?.options.find((o) => o.id === a.answerId)
  return opt ? opt.text[lang] : null
}

// ─── Relay API client (all same-origin via the bridge proxy) ────────

export interface PoolStatus {
  activeCount: number
  minPool: number
  featureEnabled: boolean
  requireOptinToReceive: boolean
}

async function relayFetch(path: string, init?: RequestInit): Promise<Response> {
  if (['/api/relay/pool/sign-upload', '/api/relay/pool/join'].includes(path)) return diagnosticFetch(path, { ...init, signal: AbortSignal.timeout(20_000) }, path.endsWith('sign-upload') ? 'pool.sign' : 'pool.join')
  return fetch(path, { ...init, signal: AbortSignal.timeout(20_000) })
}

export async function fetchPoolStatus(): Promise<PoolStatus | null> {
  try {
    const res = await relayFetch('/api/relay/pool/status')
    if (!res.ok) return null
    return (await res.json()) as PoolStatus
  } catch (err) {
    console.warn('[linconnu] pool status unavailable:', (err as Error).message)
    return null
  }
}

/**
 * Redeem a 6-digit phone-quiz code. Single-use: a successful redemption
 * consumes the code server-side. Returns the quiz record, or a typed
 * failure so the code-entry screen can show the right message.
 */
export async function redeemQuizCode(code: string): Promise<
  { ok: true; record: LcQuizRecord } | { ok: false; reason: 'invalid' | 'network' }
> {
  try {
    const res = await relayFetch('/api/relay/quiz/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (res.status === 404) return { ok: false, reason: 'invalid' }
    if (!res.ok) return { ok: false, reason: 'network' }
    const data = await res.json()
    if (!data?.record) return { ok: false, reason: 'network' }
    return { ok: true, record: data.record as LcQuizRecord }
  } catch (err) {
    console.warn('[linconnu] redeem failed:', (err as Error).message)
    return { ok: false, reason: 'network' }
  }
}

/**
 * Ask the relay for a compatible stranger. Consumes one distribution on
 * the chosen entry, so call this exactly once per session (the printing
 * screen guards with a ref).
 */
export async function requestPoolMatch(
  answers: LcAnswer[],
  sessionId: string,
  joined: boolean,
): Promise<LcMatch | null> {
  try {
    const res = await relayFetch('/api/relay/pool/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, sessionId, joined }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return (data && data.match) || null
  } catch (err) {
    console.warn('[linconnu] match request failed:', (err as Error).message)
    return null
  }
}

/**
 * The matched stranger's portrait, fetched same-origin through the bridge
 * and converted to a blob object URL — html-to-image can rasterize it
 * without canvas taint (see the 2026-07-06 Photo ID taint incident).
 */
export async function fetchMatchPortrait(entryId: string): Promise<string | null> {
  try {
    const res = await relayFetch(`/api/relay/pool/portrait?id=${encodeURIComponent(entryId)}`)
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch (err) {
    console.warn('[linconnu] portrait fetch failed:', (err as Error).message)
    return null
  }
}

/** PNG/JPEG data URL → JPEG blob (q0.9, #FDFDFD underlay for transparency). */
async function dataUrlToJpegBlob(dataUrl: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.fillStyle = '#FDFDFD'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9)
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

/**
 * Create the pool entry after the FINAL in-studio confirmation: sign an
 * upload, PUT the portrait JPEG to R2, then join. Identity + consents
 * are joined server-side from the redeemed quiz record (we only send the
 * code). Fire-and-forget from the printing screen — a failed join must
 * never break the customer's own prints. Resolves true on full success.
 */
export async function joinPool(args: {
  portraitDataUrl: string
  code: string
  sessionId: string
  seed: boolean
}): Promise<boolean> {
  try {
    const blob = await dataUrlToJpegBlob(args.portraitDataUrl)
    if (!blob) return false

    const signRes = await relayFetch('/api/relay/pool/sign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg' }),
    })
    if (!signRes.ok) return false
    const { entryId, key, uploadUrl } = await signRes.json()
    if (!entryId || !key || !uploadUrl) return false

    const putRes = await diagnosticFetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
      signal: AbortSignal.timeout(120_000),
    }, 'pool.put')
    if (!putRes.ok) return false

    const joinRes = await relayFetch('/api/relay/pool/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryId,
        portraitKey: key,
        code: args.code,
        sessionId: args.sessionId,
        seed: args.seed,
      }),
    })
    if (!joinRes.ok) return false
    console.log('[linconnu] pool entry created')
    return true
  } catch (err) {
    console.warn('[linconnu] pool join failed:', (err as Error).message)
    return false
  }
}
