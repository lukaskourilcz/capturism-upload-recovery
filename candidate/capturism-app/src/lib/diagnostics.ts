type Event = { stage: string; outcome?: string; durationMs?: number; status?: number; error?: string; driftMs?: number; trace?: string; bytes?: number; clientAtMs?: number }
let pending: Event[] = []
let sending = false
export function diagnostic(event: Event): void {
  pending.push({ ...event, clientAtMs: Date.now() }); pending = pending.slice(-50)
  void flush()
}
async function flush() {
  if (sending || !pending.length) return
  sending = true
  const batch = pending.splice(0, 50)
  try {
    const response = await fetch('/api/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch), signal: AbortSignal.timeout(2000) })
    if (!response.ok) pending = [...batch, ...pending].slice(-50)
    else if (pending.length) queueMicrotask(() => { void flush() })
  } catch { pending = [...batch, ...pending].slice(-50) }
  finally { sending = false }
  // A single follow-up handles events collected during the request. Failed
  // batches wait for a future event; diagnostics never form a retry loop.
}
export async function diagnosticFetch(url: string, init: RequestInit, stage: string): Promise<Response> {
  const trace = crypto.randomUUID(), start = performance.now()
  diagnostic({ stage, trace, outcome: 'start', bytes: init.body instanceof Blob ? init.body.size : undefined })
  const headers = new Headers(init.headers)
  if (url.startsWith('/api/relay/')) headers.set('X-Capturism-Trace', trace)
  try {
    const response = await fetch(url, { ...init, headers })
    diagnostic({ stage, trace, outcome: response.ok ? 'ok' : 'error', status: response.status, durationMs: performance.now() - start, error: response.ok ? undefined : 'http' })
    return response
  } catch (e) {
    const name = (e as Error).name
    diagnostic({ stage, trace, outcome: 'error', durationMs: performance.now() - start, error: name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'aborted' : 'network' })
    throw e
  }
}
export async function measureStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now(), trace = crypto.randomUUID()
  diagnostic({ stage, trace, outcome: 'start' })
  try { const value = await operation(); diagnostic({ stage, trace, outcome: 'ok', durationMs: performance.now() - start }); return value }
  catch (e) { diagnostic({ stage, trace, outcome: 'error', error: 'other', durationMs: performance.now() - start }); throw e }
}
export function startPageDiagnostics(): () => void {
  diagnostic({ stage: 'page.boot', outcome: 'ok' })
  const visibility = () => diagnostic({ stage: 'page.visibility', outcome: document.visibilityState === 'visible' ? 'visible' : 'hidden' })
  visibility(); document.addEventListener('visibilitychange', visibility)
  let expected = Date.now() + 60000
  const timer = setInterval(() => { diagnostic({ stage: 'page.timer', driftMs: Math.max(0, Date.now() - expected) }); expected = Date.now() + 60000 }, 60000)
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
}
