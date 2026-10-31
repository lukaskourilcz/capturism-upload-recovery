// The former R8 consequence probe now asserts explicit same-token recovery.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DownloadPage } from './DownloadPage'
vi.mock('./VideoBackground', () => ({ VideoBackground: () => null }))
vi.mock('./PhotoCard', () => ({ PhotoCard: () => null }))
vi.mock('./ActionMenu', () => ({ ActionMenu: ({ videoDownloadUrl }: { videoDownloadUrl?: string }) => <div data-video={videoDownloadUrl} /> }))
vi.mock('./ShareButtons', () => ({ ShareButtons: () => null }))
vi.mock('./Logo', () => ({ Logo: () => null }))
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> } }))
it('fixed R8: unavailable discovery offers retry and the recovered video appears on the same QR', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers()
  window.history.replaceState({}, '', '/d/synthetic-token')
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({
    photoUrl: 'http://127.0.0.1/photo.jpg', videoUrl: null, layoutVideoUrl: 'http://127.0.0.1/layout.mp4', videoPending: false,
    videoFailed: false, date: '2026-10-31T10:00:00Z',
  })))
  vi.stubGlobal('fetch', fetcher)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    await act(async () => root.render(<DownloadPage />))
    await act(async () => { await vi.advanceTimersByTimeAsync(12 * 60000) })
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
    expect(container.querySelector('button')?.textContent).toBe('Try again')
    await act(async () => { container.querySelector('button')!.click() })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0])
    expect(container.querySelector('[data-video]')?.getAttribute('data-video')).toBe('http://127.0.0.1/layout.mp4')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    console.log(JSON.stringify({ finding: 'R8', interpretation: 'fixed: explicit retry retrieves the same QR video', automaticErrorLoops: false, recoveredVideo: true }))
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers() }
})
