// Passing assertions reproduce the phone consequence of OPEN R8; not a safety test.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DownloadPage } from './DownloadPage'
vi.mock('./VideoBackground', () => ({ VideoBackground: () => null }))
vi.mock('./PhotoCard', () => ({ PhotoCard: () => null }))
vi.mock('./ActionMenu', () => ({ ActionMenu: () => null }))
vi.mock('./ShareButtons', () => ({ ShareButtons: () => null }))
vi.mock('./Logo', () => ({ Logo: () => null }))
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> } }))
it('OPEN R8: false-absence response stops phone polling and offers no retry after the provider recovers', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers()
  window.history.replaceState({}, '', '/d/synthetic-token')
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
    photoUrl: 'http://127.0.0.1/photo.jpg', videoUrl: null, layoutVideoUrl: null, videoPending: false,
    videoFailed: true, date: '2026-10-31T10:00:00Z',
  }))))
  vi.stubGlobal('fetch', fetcher)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    await act(async () => root.render(<DownloadPage />))
    await act(async () => { await vi.advanceTimersByTimeAsync(12 * 60000) })
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
    expect(container.querySelector('button')).toBeNull(); expect(container.querySelector('[role="alert"]')).toBeNull()
    console.log(JSON.stringify({ finding: 'R8', interpretation: 'unsafe consequence reproduced, not fixed', automaticRefetches: 0, retryControl: false }))
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers() }
})
