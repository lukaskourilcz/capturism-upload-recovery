import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ByePage from './ByePage'
import { getSessionEpoch, useSessionStore } from '../../store/sessionStore'
import { getQrUploadState, resetQrUpload, setQrUploadState } from '../../lib/qrUploadState'

vi.mock('../../lib/lightsClient', () => ({ applyPresetWithRetry: vi.fn() }))
vi.mock('../../lib/sessionVideo', () => ({ clearSessionVideo: vi.fn() }))
vi.mock('../layout/PageHeader', () => ({ PageHeader: () => null }))
vi.mock('../layout/SessionVideoBackground', () => ({ SessionVideoBackground: () => null }))
vi.mock('../glass/FigmaGlassCard', () => ({ FigmaGlassCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('../DownloadQR', () => ({ DownloadQR: ({ cloudToken }: { cloudToken: string | null }) => <div data-testid="download-qr">{cloudToken || 'PREPARING'}</div> }))

describe('thank-you QR deadline and recovery', () => {
  let host: HTMLDivElement, root: Root
  const mount = async () => { await act(async () => root.render(<MemoryRouter><ByePage /></MemoryRouter>)) }
  beforeEach(() => {
    vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    useSessionStore.getState().reset(); useSessionStore.setState({ wantsQrCode: true, language: 'en' })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); resetQrUpload()
    vi.useRealTimers(); vi.unstubAllGlobals()
  })
  it('shows recovery at the original deadline even after touches, without resetting the session', async () => {
    const expire = vi.fn(() => setQrUploadState({ phase: 'failed', reason: 'timeout', canRetry: true }))
    setQrUploadState({ phase: 'uploading', canRetry: false, deadlineAt: Date.now() + 1000 }, { expire })
    const epoch = getSessionEpoch(); await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(900); window.dispatchEvent(new Event('pointerdown')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(expire).toHaveBeenCalledTimes(1); expect(getSessionEpoch()).toBe(epoch)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('taking too long')
    expect(host.querySelector('[data-testid="download-qr"]')).toBeNull()
    expect(host.textContent).toContain('RETRY DOWNLOAD')
  })
  it('a recovery tap retries only the saved upload and then displays its token', async () => {
    const retry = vi.fn(async () => {
      setQrUploadState({ phase: 'ready', canRetry: false, epoch: getSessionEpoch(), token: 'original-token' })
      return 'original-token'
    })
    setQrUploadState({ phase: 'failed', reason: 'timeout', canRetry: true }, { retry })
    await mount()
    const button = [...host.querySelectorAll('button')].find(el => el.textContent === 'RETRY DOWNLOAD')!
    await act(async () => { button.click() })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().cloudToken).toBe('original-token')
    expect(host.querySelector('[data-testid="download-qr"]')?.textContent).toBe('original-token')
  })
  it('failed recovery has a fresh five-minute privacy window and reset drops its callback', async () => {
    const cancel = vi.fn(); setQrUploadState({ phase: 'failed', canRetry: true, reason: 'upload' }, { cancel })
    const epoch = getSessionEpoch(); await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(300000) })
    expect(getSessionEpoch()).toBe(epoch + 1); expect(cancel).toHaveBeenCalledTimes(1)
    expect(getQrUploadState().phase).toBe('idle')
  })
  it.each(['fr', 'en', 'ko'] as const)('preparation failure gives studio-help instructions in %s', async language => {
    useSessionStore.setState({ language }); setQrUploadState({ phase: 'failed', reason: 'preparation', canRetry: false })
    await mount()
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy()
    expect(host.querySelector('button:disabled')).not.toBeNull()
    expect(host.querySelector('[data-testid="download-qr"]')).toBeNull()
  })
})
