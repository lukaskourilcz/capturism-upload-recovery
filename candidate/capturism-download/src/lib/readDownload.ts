/** A single deadline covers headers and JSON, even if a transport ignores abort. */
export async function readDownload<T>(url: string, signal: AbortSignal): Promise<T> {
  const aborted = () => new DOMException('Download read cancelled', 'AbortError')
  if (signal.aborted) throw aborted()
  const controller = new AbortController()
  const deadline = Date.now() + 20_000
  const timedOut = () => new Error('The connection is taking too long. Please try again.')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => { reject(aborted()); controller.abort() }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { reject(timedOut()); controller.abort() }, 20_000)
  })
  const request = (async () => {
    const response = await fetch(url, { signal: controller.signal })
    if (response.status === 404 || response.status === 410) {
      throw Object.assign(new Error('This link has expired or is invalid.'), { terminal: true })
    }
    if (!response.ok) throw new Error('Could not load your photos. Please try again.')
    return await response.json() as T
  })()
  try {
    const data = await Promise.race([request, interrupted])
    // Also enforce the wall-clock deadline after a suspended main thread wakes.
    if (signal.aborted) throw aborted()
    if (Date.now() >= deadline) { controller.abort(); throw timedOut() }
    return data
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
