import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Simulator, json } from './simulator.mjs';
export async function createTwin({ port = 4317, root = fileURLToPath(new URL('./.runtime/', import.meta.url)), worker = true } = {}) {
  let simulator;
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) return json(res, 403, { error: 'Use the loopback URL printed by the server' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Cross-origin requests disabled' });
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    const url = new URL(req.url, `http://${host}`);
    try {
      const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
      const file = url.pathname.startsWith('/d/') ? 'index.html' : files[url.pathname];
      if (file) {
        res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript');
        return res.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
      }
      if (await simulator.handle(req, res, url) === false) json(res, 404, { error: 'Unknown local endpoint' });
    } catch (err) { json(res, 500, { error: err.message }); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  simulator = new Simulator({ root, baseUrl, worker });
  return { server, simulator, baseUrl, close: async () => { await simulator.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const twin = await createTwin();
  console.log(`Capturism upload twin: ${twin.baseUrl}\nLocal services only. Stop with Ctrl+C.`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await twin.close(); process.exit(0); });
}
