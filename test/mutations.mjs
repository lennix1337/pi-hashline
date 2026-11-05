import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['stale-hash', 'src/hashline.ts', 'if (now !== a.hash) stale.push(', 'if (false) stale.push(', 'stale anchor is refused', 'hashline'],
  ['overlap', 'src/hashline.ts', 'if (clash) throw', 'if (false) throw', 'overlapping edits are refused', 'hashline'],
  ['out-of-range', 'src/hashline.ts', 'if (a.line < 1 || a.line > lines.length)', 'if (false)', 'stale anchor is refused', 'hashline'],
  ['keep-crlf', 'src/index.ts', "crlf ? applied.content.replace(/\\n/g, '\\r\\n') : applied.content", 'applied.content', 'keeps CRLF and BOM', 'extension'],
  ['plain-codemode', 'src/index.ts', 'structuredContent: stripTags(result.structuredContent)', 'structuredContent: result.structuredContent', 'gives Code Mode the plain text', 'extension'],
  ['mixed-refusal', 'src/index.ts', "if (legacy.length) throw", "if (false) throw", 'oldText edits still work', 'extension'],
];
let killed = 0;
let failed = false;
for (const [name, file, before, after, pattern, test] of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-hashline-mutant-'));
  try {
    cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(root, 'test'), join(dir, 'test'), { recursive: true });
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const path = join(dir, file);
    const source = readFileSync(path, 'utf8');
    assert.equal(source.split(before).length, 2, `unique mutation ${name}`);
    writeFileSync(path, source.replace(before, after));
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', `--test-name-pattern=${pattern}`, `test/${test}.test.ts`], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined, `${name}: process must run, not time out`);
    if (result.status === 0) {
      console.log(`${name}: survived`);
      failed = true;
      continue;
    }
    assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion, not crash`);
    killed++;
    console.log(`${name}: killed by assertion`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`${killed}/${cases.length} guard mutants killed; disposable copies only`);
if (failed) process.exitCode = 1;
