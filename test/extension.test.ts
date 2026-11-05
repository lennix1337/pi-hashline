import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.ts';

function harness() {
  const tools = new Map<string, any>();
  extension({ registerTool: (d: any) => tools.set(d.name, d) } as unknown as ExtensionAPI);
  const dir = mkdtempSync(join(tmpdir(), 'pi-hashline-'));
  const ctx = { cwd: dir };
  const run = (name: string, args: any) => tools.get(name).execute('t', tools.get(name).prepareArguments ? tools.get(name).prepareArguments(args) : args, undefined, undefined, ctx);
  const textOf = (r: any) => r.content.find((c: any) => c.type === 'text').text as string;
  return { tools, dir, run, textOf, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('it overrides read and edit only', () => {
  const h = harness();
  try { assert.deepEqual([...h.tools.keys()].sort(), ['edit', 'read']); } finally { h.cleanup(); }
});

test('read shows anchors to the model, keeps offsets absolute, and gives Code Mode the plain text', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    const r = await h.run('read', { path: 'a.txt', offset: 2, limit: 2 });
    assert.match(h.textOf(r), /^2:[0-9a-z]{2}\|two\n3:[0-9a-z]{2}\|three\n\n\[2 more lines in file\. Use offset=4 to continue\.\]$/);
    assert.equal(r.structuredContent, 'two\nthree\n\n[2 more lines in file. Use offset=4 to continue.]');
  } finally { h.cleanup(); }
});

test('read leaves images to the built-in image path', async () => {
  const h = harness();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    writeFileSync(join(h.dir, 'p.png'), png);
    const r = await h.run('read', { path: 'p.png' });
    assert.ok(r.content.some((c: any) => c.type === 'image'));
  } finally { h.cleanup(); }
});

test('edit by anchors from read keeps CRLF and BOM, and returns the next anchors', async () => {
  const h = harness();
  try {
    const file = join(h.dir, 'w.js');
    writeFileSync(file, '\uFEFFlet a = 1;\r\nlet b = 1;\r\nlet c = 1;\r\n');
    const anchors = h.textOf(await h.run('read', { path: 'w.js' })).split('\n').map(l => l.split('|')[0]);
    const r = await h.run('edit', { path: 'w.js', edits: [{ start: anchors[1], end: null, after: null, oldText: null, newText: 'let b = 2;\nlet bb = 2;' }] });
    assert.equal(readFileSync(file, 'utf8'), '\uFEFFlet a = 1;\r\nlet b = 2;\r\nlet bb = 2;\r\nlet c = 1;\r\n');
    assert.match(h.textOf(r), /lines 2-3 replace 1 old line/);
    assert.match(h.textOf(r), /\n3:[0-9a-z]{2}\|let bb = 2;\n4:[0-9a-z]{2}\|let c = 1;/);
    assert.ok(r.details.diff.includes('let bb = 2;'));
  } finally { h.cleanup(); }
});

test('a stale anchor leaves the file untouched; oldText edits still work through the built-in edit', async () => {
  const h = harness();
  try {
    const file = join(h.dir, 's.txt');
    writeFileSync(file, 'x\ny\n');
    await assert.rejects(h.run('edit', { path: 's.txt', edits: [{ start: '1:zz', newText: 'q' }] }), /No edit applied/);
    assert.equal(readFileSync(file, 'utf8'), 'x\ny\n');
    await h.run('edit', { path: 's.txt', edits: [{ oldText: 'y', newText: 'z' }] });
    assert.equal(readFileSync(file, 'utf8'), 'x\nz\n');
    await assert.rejects(h.run('edit', { path: 's.txt', edits: [{ oldText: 'x', newText: 'w' }, { start: '2:aa', newText: 'q' }] }), /Mix of oldText/);
    await assert.rejects(h.run('edit', { path: 'missing.txt', edits: [{ start: '1:aa', newText: 'q' }] }), /Could not edit file: missing\.txt/);
  } finally { h.cleanup(); }
});
