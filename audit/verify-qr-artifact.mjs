// Regenerate/apply the production-only patch against an isolated baseline copy.
// Never changes the captured repository or calls a provider.
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const baseline = resolve('../diagnosis-2026-10-30/capturism-main'), root = resolve('candidate');
async function files(dir) {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name); if (item.isDirectory()) found.push(...await files(path)); else found.push(path);
  }
  return found;
}
const paths = (await files(root)).filter(p => /\.(c?js|tsx?)$/.test(p) || p === join(root, '.gitignore')).map(p => p.slice(root.length + 1)).sort();
// Python difflib preserves the existing patch's readable unified format.
const script = `import difflib,json,pathlib,sys\nbaseline,root,paths=json.loads(sys.stdin.read())\nfor name in paths:\n a=pathlib.Path(baseline)/name;b=pathlib.Path(root)/name\n old=a.read_text().splitlines(True) if a.exists() else []\n new=b.read_text().splitlines(True)\n sys.stdout.writelines(difflib.unified_diff(old,new,fromfile='a/'+name if a.exists() else '/dev/null',tofile='b/'+name))\n`;
const generated = spawnSync('python3', ['-c', script], { input: JSON.stringify([baseline, root, paths]), encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const patch = generated.stdout; await writeFile(join(root, 'local-fix.patch'), patch);
const temp = await mkdtemp(join(tmpdir(), 'capturism-exact-qr-patch-'));
try {
  for (const path of paths) {
    const target = join(temp, path); await mkdir(dirname(target), { recursive: true });
    try { await copyFile(join(baseline, path), target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  const applied = spawnSync('git', ['apply', '--unsafe-paths', '-'], { cwd: temp, input: patch, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  for (const path of paths) {
    assert.deepEqual(await readFile(join(temp, path)), await readFile(join(root, path)), path);
    if (/\.c?js$/.test(path)) {
      const syntax = spawnSync(process.execPath, ['--check', join(temp, path)], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
  console.log(JSON.stringify({ baseline: '1f2df6401997455b456eab9b32d258b997dc4b9d', patchSHA256: createHash('sha256').update(patch).digest('hex'), filesMatchedExactly: paths.length, javascriptSyntax: 'passed', isolatedApply: 'passed', paths }, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
