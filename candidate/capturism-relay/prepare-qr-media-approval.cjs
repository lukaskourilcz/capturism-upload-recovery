'use strict';
// Offline operator tool only. No cloud connection and no approval HTTP endpoint.
const fs = require('node:fs');
const path = require('node:path');
const { approvalKey, buildLegacyApproval } = require('./qr-media-scope.cjs');
if (require.main === module) {
  try {
    if (process.argv[2] !== '--reviewed' || process.argv.length !== 4) throw new Error('Usage: node prepare-qr-media-approval.cjs --reviewed <private-reviewed-input.json>');
    const { token, session } = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const manifest = buildLegacyApproval(token, session);
    const dir = path.resolve('qr-media-approvals'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const output = path.join(dir, manifest.tokenHash + '.json');
    fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ output, objectKey: approvalKey(token), uploaded: false }) + '\n');
  } catch { process.stderr.write('Approval not prepared. Check reviewed input, media scope and output existence.\n'); process.exitCode = 1; }
}
