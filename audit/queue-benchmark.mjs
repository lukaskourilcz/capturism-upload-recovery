import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import queueModule from '../candidate/pool-queue.cjs';
const directory = await mkdtemp(join(tmpdir(), 'capturism-audit-bench-'));
try {
  const queue = queueModule.createPoolQueue({ directory, boothId: 'local' });
  const photoBase64 = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
  for (let n = 0; n < 20; n++) queue.enqueue({ sessionId: 'benchmark-' + n, code: '000000', seed: false, photoBase64 });
  const statusMs = [];
  for (let n = 0; n < 3; n++) { const start = performance.now(); queue.status(); statusMs.push(Math.round(performance.now() - start)); }
  console.log(JSON.stringify({ jobs: 20, photoMiB: 40, jsonMiBApprox: 53.3, statusMs, note: 'Synthetic local macOS fixture; Windows disk/CPU behavior is unverified. status() scans and hashes every queued portrait synchronously.' }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
