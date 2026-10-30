import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({
  entryPoints: ['src/app.ts'], outfile: 'public/app.js', bundle: true,
  platform: 'browser', format: 'esm', sourcemap: false,
  plugins: [{ name: 'twin-boundaries', setup(b) {
    b.onResolve({ filter: /^(\.\/boothRelay|\.\.\/store\/sessionStore)$/ }, () => ({ path: resolve('src/adapters.ts') }));
  } }],
});
