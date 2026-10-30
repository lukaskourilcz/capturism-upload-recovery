'use strict';
const loopback = value => ['127.0.0.1','::1','::ffff:127.0.0.1','localhost','[::1]'].includes(value);
function isLocalRequest(req) {
  if (!loopback(req.socket.remoteAddress)) return false;
  // Reverse-proxied/tunnel traffic also arrives over loopback. Do not trust
  // that hop alone, or use forwarded headers as proof of local identity.
  for (const name of Object.keys(req.headers)) if (/^(forwarded|via|x-forwarded-.*|cf-.*)$/i.test(name)) return false;
  try {
    const target = new URL(`http://${req.headers.host}`);
    if (!loopback(target.hostname)) return false;
    if (req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || !loopback(origin.hostname)) return false;
    }
  } catch { return false; }
  return true;
}
module.exports = { isLocalRequest };
