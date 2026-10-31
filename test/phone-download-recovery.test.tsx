import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadPage } from './DownloadPage'
vi.mock('./VideoBackground', () => ({ VideoBackground: () => null }))
vi.mock('./PhotoCard', () => ({ PhotoCard: ({ photoSrc }: { photoSrc?: string }) => <div data-photo={photoSrc} /> }))
vi.mock('./ActionMenu', () => ({ ActionMenu: () => null }))
vi.mock('./ShareButtons', () => ({ ShareButtons: () => null }))
vi.mock('./Logo', () => ({ Logo: () => null }))
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> } }))
const ready = { photoUrl: 'http://127.0.0.1/photo.jpg', videoUrl: null, videoPending: false, date: '2026-10-31T10:00:00Z' }
let root: Root, container: HTMLDivElement
const flush = async () => { await act(async () => { await Promise.resolve() }) }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.history.replaceState({}, '', '/d/synthetic-token')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('phone download recovery', () => {
  it.each([503, 500])('offers explicit retry for %s and retrieves the SAME token without upload or polling loops', async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status })).mockResolvedValueOnce(new Response(JSON.stringify(ready)))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DownloadPage />)); await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please try again')
    const button = container.querySelector('button')!; expect(button.textContent).toBe('Try again')
    await act(async () => { button.click() }); await flush()
    expect(container.querySelector('[data-photo]')?.getAttribute('data-photo')).toBe(ready.photoUrl)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['http://127.0.0.1:4317/api/download/synthetic-token', 'http://127.0.0.1:4317/api/download/synthetic-token'])
  })
  it('offers retry after a network exception', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValueOnce(new Response(JSON.stringify(ready)))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DownloadPage />)); await flush()
    await act(async () => { container.querySelector('button')!.click() }); await flush()
    expect(container.querySelector('[data-photo]')?.getAttribute('data-photo')).toBe(ready.photoUrl)
  })
  it.each([404, 410])('keeps actual expiry terminal for %s', async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status })); vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DownloadPage />)); await flush()
    expect(container.textContent).toContain('This link has expired or is invalid.')
    expect(container.querySelector('button')).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('cancels the old request when leaving the page and ignores its late response', async () => {
    let resolve!: (value: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(r => { resolve = r })); vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DownloadPage />)); const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!
    await act(async () => root.unmount()); expect(signal.aborted).toBe(true)
    await act(async () => resolve(new Response(JSON.stringify(ready))));
    root = createRoot(container); expect(container.textContent).toBe('')
  })
  it('recovers a failed video poll and resumes bounded pending-video polling', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...ready, videoPending: true })))
      .mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ ...ready, videoPending: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify(ready)))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DownloadPage />)); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) }); await flush()
    expect(container.querySelector('button')?.textContent).toBe('Try again')
    await act(async () => { container.querySelector('button')!.click() }); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) }); await flush()
    expect(fetcher).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0)
  })
})

describe('whole phone read deadline', () => {
  it.each(['headers', 'body'])('times out stalled %s, retries once and ignores the old late result', async phase => {
    vi.useFakeTimers()
    let resolveOld!: (value: Response | typeof ready) => void
    const never = new Promise<Response | typeof ready>(r => { resolveOld = r })
    const body = new Response('{}'); body.json = () => never as Promise<typeof ready>
    const fetcher = vi.fn().mockImplementationOnce(() => phase === 'headers' ? never : Promise.resolve(body))
      .mockResolvedValueOnce(new Response(JSON.stringify(ready)))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DownloadPage />)); await flush()
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    await act(async () => { await vi.advanceTimersByTimeAsync(19999) })
    expect(container.querySelector('button')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) }); await flush()
    expect(signal.aborted).toBe(true); expect(container.textContent).toContain('taking too long')
    const button = container.querySelector('button')!
    await act(async () => { button.click(); button.click() }); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    const old = { ...ready, photoUrl: 'http://127.0.0.1/stale.jpg' }
    await act(async () => resolveOld(phase === 'headers' ? new Response(JSON.stringify(old)) : old)); await flush()
    expect(container.querySelector('[data-photo]')?.getAttribute('data-photo')).toBe(ready.photoUrl)
    expect(container.querySelector('[role="alert"]')).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  })

  it('times out a stalled video poll and recovers with the same token', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...ready, videoPending: true })))
      .mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(new Response(JSON.stringify(ready)))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DownloadPage />)); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(24000) }); await flush()
    expect(container.textContent).toContain('taking too long')
    expect(container.querySelector('[data-photo]')?.getAttribute('data-photo')).toBe(ready.photoUrl)
    await act(async () => { container.querySelector('button')!.click() }); await flush()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(call => call[0].endsWith('/api/download/synthetic-token'))).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a response after the wall-clock deadline even before the timer runs', async () => {
    vi.useFakeTimers()
    let resolve!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolve = r })))
    await act(async () => root.render(<DownloadPage />)); await flush()
    vi.setSystemTime(Date.now() + 20001)
    await act(async () => resolve(new Response(JSON.stringify(ready)))); await flush()
    expect(container.textContent).toContain('taking too long')
    expect(container.querySelector('[data-photo]')).toBeNull()
    expect(container.querySelector('button')?.textContent).toBe('Try again'); expect(vi.getTimerCount()).toBe(0)
  })

  it('manual retry does not renew the page polling budget', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...ready, videoPending: true })))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DownloadPage />)); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(11 * 60000 + 1) })
    await act(async () => { container.querySelector('button')!.click() }); await flush()
    expect(vi.getTimerCount()).toBe(0); expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('expiry returned after a timed-out read remains terminal', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(new Response('{}', { status: 410 })))
    await act(async () => root.render(<DownloadPage />)); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    await act(async () => { container.querySelector('button')!.click() }); await flush()
    expect(container.textContent).toContain('expired or is invalid'); expect(container.querySelector('button')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
