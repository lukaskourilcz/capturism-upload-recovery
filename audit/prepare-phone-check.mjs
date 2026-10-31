// Reuse the already-installed kiosk dev tools in a separate local phone checkout.
// No package installation, .env reads, captured-source edits or provider calls.
import { cp, copyFile, mkdir, writeFile, symlink, access } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
const target = resolve('.runtime/download-check');
await mkdir(target, { recursive: true });
await cp(resolve('../diagnosis-2026-10-30/capturism-main/capturism-download'), target, {
  recursive: true,
  filter: path => !['node_modules', 'dist', '.git'].includes(basename(path)) && !basename(path).startsWith('.env'),
});
await cp(resolve('candidate/capturism-download'), target, { recursive: true });
await copyFile('test/phone-download-recovery.test.tsx', target + '/src/components/DownloadPage.recovery.test.tsx');
await copyFile('audit/phone-stall.review.test.tsx', target + '/src/components/DownloadPage.stall.review.test.tsx');
await copyFile('audit/phone-video-discovery.review.test.tsx', target + '/src/components/DownloadPage.discovery.review.test.tsx');
await copyFile('.runtime/typecheck/eslint.config.js', target + '/eslint.config.js');
try { await access(target + '/node_modules'); } catch { await symlink(resolve('.runtime/typecheck/node_modules'), target + '/node_modules', 'dir'); }
await writeFile(target + '/vitest.config.ts', `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ define: { 'import.meta.env.VITE_RELAY_URL': JSON.stringify('http://127.0.0.1:4317') }, test: { environment: 'jsdom', include: ['src/**/*.test.tsx'] } })\n`);
console.log('Prepared local phone checkout with the candidate source and recovery tests.');
