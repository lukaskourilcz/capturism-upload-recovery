export class UploadDeadlineError extends Error {
  constructor() { super('QR upload deadline exceeded'); this.name = 'UploadDeadlineError' }
}

export const SESSION_ENDED_MSG = 'session ended before the upload finished — token discarded so it cannot leak into the next customer\'s session'

// The root timer covers requests, response bodies AND retry sleeps. Aborting
// the transport alone is insufficient: a stalled body/non-cooperative promise
// must not keep the caller waiting or return a late token.
export function createUploadDeadline(ms: number, isCurrent: () => boolean) {
  const controller = new AbortController()
  const deadlineAt = Date.now() + ms
  const expire = () => controller.abort(new UploadDeadlineError())
  const timer = setTimeout(expire, ms)
  function check() {
    if (!isCurrent()) controller.abort(new Error(SESSION_ENDED_MSG))
    if (Date.now() >= deadlineAt) expire()
    if (controller.signal.aborted) throw controller.signal.reason
  }
  async function attempt<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    check()
    const request = new AbortController()
    const abort = () => request.abort(controller.signal.reason)
    controller.signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => request.abort(new Error('Upload request timed out')), Math.min(timeoutMs, Math.max(0, deadlineAt - Date.now())))
    let rejectAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    try {
      const value = await Promise.race([operation(request.signal), aborted])
      check()
      return value
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', abort)
      request.signal.removeEventListener('abort', rejectAbort)
    }
  }
  async function sleep(ms: number) {
    check()
    let id: ReturnType<typeof setTimeout> | undefined
    try {
      await attempt(signal => new Promise<void>(resolve => {
        id = setTimeout(resolve, Math.min(ms, Math.max(0, deadlineAt - Date.now())))
        signal.addEventListener('abort', () => clearTimeout(id), { once: true })
      }), Math.max(1, deadlineAt - Date.now()))
      check()
    } finally { clearTimeout(id) }
  }
  return { deadlineAt, check, attempt, sleep, expire, cancel: () => controller.abort(new Error(SESSION_ENDED_MSG)), dispose: () => clearTimeout(timer) }
}
export type UploadDeadline = ReturnType<typeof createUploadDeadline>
