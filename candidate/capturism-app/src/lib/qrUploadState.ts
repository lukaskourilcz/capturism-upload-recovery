export type QrUploadState = {
  phase: 'idle' | 'uploading' | 'failed' | 'ready'
  epoch?: number
  deadlineAt?: number
  token?: string
  reason?: 'timeout' | 'upload' | 'preparation'
  canRetry: boolean
}
const idle: QrUploadState = { phase: 'idle', canRetry: false }
let state = idle
let actions: { retry?: () => Promise<string>; cancel?: () => void; expire?: () => void } = {}
const listeners = new Set<() => void>()
export const getQrUploadState = () => state
export function subscribeQrUpload(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function setQrUploadState(next: QrUploadState, nextActions: typeof actions = {}) {
  state = next; actions = nextActions
  for (const listener of listeners) listener()
}
export function resetQrUpload() {
  actions.cancel?.()
  setQrUploadState(idle)
}
export function expireQrUpload() {
  if (state.phase === 'uploading') actions.expire?.()
  else if (state.phase === 'idle') setQrUploadState({ phase: 'failed', canRetry: false, reason: 'preparation' })
}
export function retryQrUpload(): Promise<string> {
  return actions.retry ? actions.retry() : Promise.reject(new Error('No QR retry available'))
}
