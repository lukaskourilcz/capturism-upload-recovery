import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Read-only source inventory, not an end-to-end kiosk test. Exit 2 identifies
// a QR-rendering product with no upload call in its own printing component.
const path = resolve(process.argv[2] || 'candidate/capturism-app/src/components/screens/Printing.tsx');
const source = await readFile(path, 'utf8');
const declarations = [...source.matchAll(/^(?:export default )?function (\w+)\s*\(/gm)];
const names = ['PhotoPrinting', 'CalendarPrinting', 'PostcardPrinting', 'PhotoIdPrinting', 'LostConnectionPrinting'];
const products = names.map(name => {
  const index = declarations.findIndex(match => match[1] === name);
  if (index < 0) throw new Error(`Missing component: ${name}`);
  const start = declarations[index].index;
  const end = declarations[index + 1]?.index ?? source.length;
  const body = source.slice(start, end);
  // These are source-level call counts. No call graph inference or comment
  // stripping: a reviewer must verify the named callers and shared hooks.
  return {
    component: name,
    line: source.slice(0, start).split('\n').length,
    rendersQr: /<DownloadQR\b|<PrintingRightPanel\b|<LostConnectionRightPanel\b/.test(body),
    uploadCalls: [...body.matchAll(/\buploadSessionToCloud\s*\(\s*\{/g)].length,
    tokenSetterCalls: [...body.matchAll(/\bsetCloudToken\s*\(\s*token\s*\)/g)].length,
    awaitsCompositionBeforeUpload: body.indexOf('await measureStage(\'render.video\'') >= 0
      && body.indexOf('await measureStage(\'render.video\'') < body.indexOf('await uploadSessionToCloud('),
  };
});
const gaps = products.filter(product => product.rendersQr && product.uploadCalls === 0);
console.log(JSON.stringify({
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  method: 'read-only source inventory; shared hooks and other token writers require manual review',
  products,
  findings: gaps.map(product => ({ component: product.component, status: 'open', issue: 'QR display without a product-local upload call' })),
}, null, 2));
if (gaps.length) process.exitCode = 2;
