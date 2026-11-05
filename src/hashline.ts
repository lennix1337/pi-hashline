// Hashline: every line a read returns carries a short anchor `LINE:HASH|`, and an edit names the lines it
// changes by those anchors instead of retyping their old text. The hash makes a stale anchor (the file
// changed since the read) a refusal that shows the current lines, never a silent edit of the wrong line.

const TAG = /^(\d+):([0-9a-z]{2})\|/;
const ANCHOR = /^\s*(\d+)\s*:\s*([0-9a-z]{2})\s*(?:\|.*)?$/is;
const BOM = '\uFEFF';

// FNV-1a over the line without its line ending, folded to two base-36 characters (1296 values).
export function lineHash(line: string): string {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 1296).toString(36).padStart(2, '0');
}

export const tagLine = (line: string, number: number) => `${number}:${lineHash(line)}|${line}`;

// Tags raw file text line by line, numbering from 1; a BOM is not part of the first line's hash.
export function tagText(text: string): string {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  return body.split('\n').map((line, i) => tagLine(line, i + 1)).join('\n');
}

// Removes one anchor prefix per line, giving back the file text (notices such as "[Showing lines ...]" stay).
export function stripTags(text: string): string {
  return text.split('\n').map(line => line.replace(TAG, '')).join('\n');
}

export interface Anchor { line: number; hash: string }

export function parseAnchor(value: string, field: string): Anchor {
  const m = ANCHOR.exec(value);
  if (!m) throw new HashlineError(`${field} "${value.slice(0, 40)}" is not an anchor: use LINE:HASH exactly as read shows it, e.g. "12:a3".`);
  return { line: Number(m[1]), hash: m[2].toLowerCase() };
}

export class HashlineError extends Error {}

export interface AnchorEdit { start?: string; end?: string; after?: string; newText: string }

interface Op { kind: 'replace' | 'insert'; from: number; to: number; lines: string[]; index: number }

export interface Region { from: number; count: number; removed: number; kind: Op['kind'] }

export interface Applied { content: string; regions: Region[] }

const newLines = (text: string) => {
  const t = text.replace(/\r\n/g, '\n');
  if (t === '') return [];
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
};

function context(lines: string[], line: number, radius = 2): string {
  const from = Math.max(1, line - radius), to = Math.min(lines.length, line + radius);
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(tagLine(lines[n - 1], n));
  return out.join('\n');
}

// Applies anchor edits to LF text. Every anchor refers to the text as it was read (before this call), so
// several edits in one call never shift each other. Refuses stale or out-of-range anchors and overlaps.
export function applyAnchorEdits(text: string, edits: readonly AnchorEdit[]): Applied {
  const lines = text.split('\n');
  const stale: string[] = [];
  const check = (value: string, field: string, index: number): number => {
    const a = parseAnchor(value, `edits[${index}].${field}`);
    if (a.line < 1 || a.line > lines.length) { stale.push(`edits[${index}].${field} ${a.line}: the file has ${lines.length} lines.`); return a.line; }
    const now = lineHash(lines[a.line - 1]);
    if (now !== a.hash) stale.push(`edits[${index}].${field} ${a.line}:${a.hash} is stale; line ${a.line} is now:\n${context(lines, a.line)}`);
    return a.line;
  };
  const ops: Op[] = edits.map((e, index) => {
    if (typeof e.newText !== 'string') throw new HashlineError(`edits[${index}].newText is required (use "" to delete lines).`);
    if (e.after !== undefined) {
      if (e.start !== undefined || e.end !== undefined) throw new HashlineError(`edits[${index}]: use either after (insert) or start/end (replace), not both.`);
      const top = /^\s*0\s*:?\s*$/.test(e.after);
      const at = top ? 0 : check(e.after, 'after', index);
      return { kind: 'insert', from: at, to: at, lines: newLines(e.newText), index };
    }
    if (e.start === undefined) throw new HashlineError(`edits[${index}] needs start (replace lines) or after (insert lines).`);
    const from = check(e.start, 'start', index);
    const to = e.end === undefined ? from : check(e.end, 'end', index);
    if (to < from) throw new HashlineError(`edits[${index}]: end line ${to} comes before start line ${from}.`);
    return { kind: 'replace', from, to, lines: newLines(e.newText), index };
  });
  if (stale.length) throw new HashlineError(`No edit applied: ${stale.length} anchor(s) do not match the file. Use the current anchors below (or read again):\n${stale.join('\n')}`);
  const sorted = [...ops].sort((a, b) => a.from - b.from || (a.kind === 'insert' ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1], c = sorted[i];
    const clash = p.kind === 'replace' ? c.from <= p.to : c.kind === 'replace' ? c.from <= p.to : c.from === p.from;
    if (clash) throw new HashlineError(`No edit applied: edits[${p.index}] and edits[${c.index}] touch the same lines (${p.from}-${p.to} and ${c.from}-${c.to}); merge them into one edit.`);
  }
  const out = [...lines];
  for (const op of [...sorted].reverse()) {
    if (op.kind === 'insert') out.splice(op.from, 0, ...op.lines);
    else out.splice(op.from - 1, op.to - op.from + 1, ...op.lines);
  }
  // Regions in the new numbering, so the result can show the anchors the next edit needs.
  const regions: Region[] = [];
  let shift = 0;
  for (const op of sorted) {
    const removed = op.kind === 'replace' ? op.to - op.from + 1 : 0;
    const from = (op.kind === 'insert' ? op.from + 1 : op.from) + shift;
    regions.push({ from, count: op.lines.length, removed, kind: op.kind });
    shift += op.lines.length - removed;
  }
  return { content: out.join('\n'), regions };
}

// The anchors of each changed region in the edited text, with one line of context, capped per region.
export function describeRegions(text: string, regions: readonly Region[], cap = 30): string {
  const lines = text.split('\n');
  const parts: string[] = [];
  for (const r of regions) {
    const from = Math.max(1, r.from - 1), to = Math.min(lines.length, r.from + Math.max(r.count, 1) - 1 + 1);
    const shown: string[] = [];
    for (let n = from; n <= to && shown.length < cap; n++) shown.push(tagLine(lines[n - 1], n));
    if (to - from + 1 > cap) shown.push(`[${to - from + 1 - cap} more changed lines; read to see them]`);
    parts.push(shown.join('\n'));
  }
  return parts.join('\n...\n');
}
