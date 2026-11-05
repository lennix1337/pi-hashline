import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAnchorEdits, describeRegions, lineHash, parseAnchor, stripTags, tagText } from '../src/hashline.ts';

const FILE = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 1;', '}'].join('\n');
const at = (n: number, text = FILE) => `${n}:${lineHash(text.split('\n')[n - 1])}`;

test('tagText numbers every line from 1 with a two-character hash, and stripTags gives the text back', () => {
  const tagged = tagText(FILE);
  const first = tagged.split('\n')[0];
  assert.match(first, /^1:[0-9a-z]{2}\|function a\(\) \{$/);
  assert.equal(tagged.split('\n').length, 7);
  assert.equal(stripTags(tagged), FILE);
  assert.equal(stripTags(`${tagged}\n\n[Showing lines 1-7 of 9. Use offset=8 to continue.]`), `${FILE}\n\n[Showing lines 1-7 of 9. Use offset=8 to continue.]`);
});

test('the hash ignores a CR line ending and a BOM, so a CRLF or BOM file anchors like its LF text', () => {
  assert.equal(lineHash('  return 1;\r'), lineHash('  return 1;'));
  assert.equal(tagText('\uFEFFx\r\ny').split('\n')[0], `1:${lineHash('x')}|x\r`);
});

test('identical lines are told apart by number: replacing line 6 leaves line 2 alone', () => {
  const r = applyAnchorEdits(FILE, [{ start: at(6), newText: '  return 2;' }]);
  assert.equal(r.content.split('\n')[1], '  return 1;');
  assert.equal(r.content.split('\n')[5], '  return 2;');
});

test('edits in one call all refer to the original numbering and are applied bottom-up', () => {
  const r = applyAnchorEdits(FILE, [
    { after: at(1), newText: '  // first\n  // second' },
    { start: at(5), end: at(7), newText: 'const b = () => 1;' },
    { after: '0', newText: '"use strict";' },
  ]);
  assert.deepEqual(r.content.split('\n'), ['"use strict";', 'function a() {', '  // first', '  // second', '  return 1;', '}', '', 'const b = () => 1;']);
  assert.deepEqual(r.regions.map(x => [x.kind, x.from, x.count, x.removed]), [['insert', 1, 1, 0], ['insert', 3, 2, 0], ['replace', 8, 1, 3]]);
});

test('newText "" deletes the lines, and one trailing newline in newText adds no blank line', () => {
  assert.deepEqual(applyAnchorEdits(FILE, [{ start: at(4), end: at(7), newText: '' }]).content.split('\n'), ['function a() {', '  return 1;', '}']);
  assert.equal(applyAnchorEdits(FILE, [{ start: at(2), newText: '  return 3;\n' }]).content.split('\n').length, 7);
});

test('a stale anchor is refused with the current lines, and nothing is applied', () => {
  assert.throws(() => applyAnchorEdits(FILE, [{ start: at(1), newText: 'x' }, { start: '2:zz', newText: 'y' }]),
    (e: Error) => /No edit applied: 1 anchor/.test(e.message) && e.message.includes(`2:${lineHash('  return 1;')}|  return 1;`));
  assert.throws(() => applyAnchorEdits(FILE, [{ start: '99:aa', newText: 'y' }]), /the file has 7 lines/);
});

test('overlapping edits are refused instead of guessed', () => {
  assert.throws(() => applyAnchorEdits(FILE, [{ start: at(1), end: at(3), newText: 'x' }, { start: at(3), newText: 'y' }]), /touch the same lines/);
  assert.throws(() => applyAnchorEdits(FILE, [{ start: at(1), end: at(3), newText: 'x' }, { after: at(2), newText: 'y' }]), /touch the same lines/);
  assert.throws(() => applyAnchorEdits(FILE, [{ after: at(2), newText: 'x' }, { after: at(2), newText: 'y' }]), /touch the same lines/);
});

test('anchors are accepted with the copied line text after the bar, and junk is refused', () => {
  assert.deepEqual(parseAnchor(' 12:A3|const x = 1;', 'start'), { line: 12, hash: 'a3' });
  assert.throws(() => parseAnchor('const x = 1;', 'start'), /is not an anchor/);
  assert.throws(() => applyAnchorEdits(FILE, [{ newText: 'x' }]), /needs start/);
  assert.throws(() => applyAnchorEdits(FILE, [{ start: at(3), end: at(1), newText: 'x' }]), /comes before/);
});

test('describeRegions shows the new anchors of each change with one line of context', () => {
  const r = applyAnchorEdits(FILE, [{ start: at(6), newText: '  return 2;' }]);
  const shown = describeRegions(r.content, r.regions);
  assert.equal(shown, [5, 6, 7].map(n => `${n}:${lineHash(r.content.split('\n')[n - 1])}|${r.content.split('\n')[n - 1]}`).join('\n'));
});
