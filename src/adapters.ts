import { resetQrUpload } from '../candidate/capturism-app/src/lib/qrUploadState'
// Only these two dependencies of the original uploader are substituted.
// No production WebSocket, identity, credentials, or Zustand persistence.
let epoch = 0;
export const getSessionEpoch = () => epoch;
export const resetSession = () => { ++epoch; resetQrUpload(); return epoch; };
export const sendBoothError = async (event: unknown) => {
  await fetch('/lab/client-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
};
