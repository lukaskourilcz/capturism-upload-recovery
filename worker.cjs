const http = require('http');
const path = require('path');
const queue = require(path.join(process.argv[2], 'video-queue.cjs'));
const relayUrl = process.argv[3];
if (new URL(relayUrl).hostname !== '127.0.0.1') throw new Error('Twin requires loopback relay');
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, relayUrl);
  if (req.method !== 'POST' || url.pathname !== '/api/video-queue') return send(res, 404, {});
  queue.enqueue(req, res, Object.fromEntries(url.searchParams), send);
});
server.listen(0, '127.0.0.1', () => {
  queue.startWorker({ relayUrl, boothId: 'local-twin', boothKey: 'local-only', onAlert: a => console.warn(JSON.stringify(a)) });
  process.send({ port: server.address().port });
});
