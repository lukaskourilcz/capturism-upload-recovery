// Waiting for an upload and giving a customer time to scan are different
// deadlines. Explicit restart still ends the session immediately.
export const QR_PENDING_WAIT_MS = 10 * 60_000
export const QR_SCAN_WINDOW_MS = 5 * 60_000

export function qrInactivityDelay({
  needsQr, hasToken, scanWindowMs = QR_SCAN_WINDOW_MS,
}: { needsQr: boolean; hasToken: boolean; scanWindowMs?: number }): number {
  return needsQr && !hasToken ? QR_PENDING_WAIT_MS : scanWindowMs
}
