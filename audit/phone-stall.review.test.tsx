// The former R6 reproduction now asserts bounded read recovery.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadPage } from './DownloadPage'
vi.mock('./VideoBackground', () => ({ VideoBackground: () => null }))
vi.mock('./PhotoCard', () => ({ PhotoCard: () => null }))
vi.mock('./ActionMenu', () => ({ ActionMenu: () => null }))
vi.mock('./ShareButtons', () => ({ ShareButtons: () => null }))
vi.mock('./Logo', () => ({ Logo: () => null }))
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> } }))
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers()
  window.history.replaceState({}, '', '/d/synthetic-token')
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('fixed phone read deadline regression', () => {
  it.each(['headers', 'body'])('offers retry after 20 seconds of stalled %s', async phase => {
    const never = () => new Promise<never>(() => {})
    const response = new Response('{}'); response.json = never
    const fetcher = phase === 'headers' ? vi.fn(never) : vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<DownloadPage />))
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      expect(container.textContent).toContain('taking too long')
      expect(container.querySelector('button')?.textContent).toBe('Try again')
      const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!
      expect(signal.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1)
      console.log(JSON.stringify({ finding: 'R6', phase, elapsedMs: 20000, retryButton: true, requestAborted: true, interpretation: 'fixed locally: read aborted and explicit retry offered' }))
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
