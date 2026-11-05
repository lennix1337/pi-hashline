import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  type ExtensionAPI, type ReadOperations, createEditToolDefinition, detectSupportedImageMimeTypeFromFile, createReadToolDefinition, generateDiffString, generateUnifiedPatch, withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { HashlineError, applyAnchorEdits, describeRegions, stripTags, tagText } from './hashline.ts';

const BOM = '\uFEFF';

const editItem = Type.Object({
  start: Type.Optional(Type.String({ description: 'Anchor LINE:HASH (from the latest read) of the first line to replace.' })),
  end: Type.Optional(Type.String({ description: 'Anchor of the last line to replace, inclusive. Omit to replace only the start line.' })),
  after: Type.Optional(Type.String({ description: 'Insert newText after this anchor line instead of replacing. "0" inserts at the top of the file.' })),
  newText: Type.String({ description: 'The new lines, without LINE:HASH prefixes. "" with start/end deletes those lines.' }),
  oldText: Type.Optional(Type.String({ description: 'Fallback only, when you have no anchors for this file: exact unique text to replace with newText.' })),
});

const editSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
  edits: Type.Array(editItem, { description: 'One or more edits. All anchors refer to the file as you last read it, so edits in one call never shift each other. Do not overlap them.' }),
});

const resolvePath = (path: string, cwd: string) => { const p = path.startsWith('@') ? path.slice(1) : path; return isAbsolute(p) ? p : resolve(cwd, p); };

export default function extension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  // Read through the built-in tool with a file source that tags each line, so offsets, truncation and
  // images behave exactly as before. Code Mode scripts get the untagged text.
  const operations: ReadOperations = {
    access: path => access(path, constants.R_OK),
    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
    readFile: async path => {
      const raw = await readFile(path);
      return (await detectSupportedImageMimeTypeFromFile(path)) ? raw : Buffer.from(tagText(raw.toString('utf-8')), 'utf-8');
    },
  };
  const read = createReadToolDefinition(cwd, { operations });
  pi.registerTool({
    ...read,
    description: `${read.description} Each text line comes as LINE:HASH|text (e.g. "12:a3|const x = 1;"); the prefix is not part of the file. Edit names lines by that LINE:HASH anchor.`,
    promptSnippet: 'Read file contents; each line is prefixed with its LINE:HASH anchor',
    promptGuidelines: ['Use read to examine files instead of cat or sed. The LINE:HASH| prefix of each line is an anchor for edit, not file content.'],
    async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const result = await (read as any).execute(id, params, signal, onUpdate, ctx);
      if (typeof result.structuredContent !== 'string') return result;
      return { ...result, structuredContent: stripTags(result.structuredContent) };
    },
  } as any);

  const builtinEdit = createEditToolDefinition(cwd);
  pi.registerTool({
    ...builtinEdit,
    description: 'Edit a file by line anchors: name the lines to change with the LINE:HASH anchors from your latest read and give only the new text; never retype the old lines. A stale anchor is refused with the current lines, so nothing is edited by mistake.',
    promptSnippet: 'Edit files by LINE:HASH anchors from read (replace, delete or insert lines), several edits per call',
    promptGuidelines: [
      'Use edit for targeted changes and batch all changes to one file in one call. Replace lines with {start, end?, newText}; delete with newText ""; insert with {after, newText} ("0" = top of file).',
      'Copy anchors exactly as read shows them (LINE:HASH). All anchors in one call refer to the file as last read. After an edit, use the anchors its result shows for the next edit; read again if unsure.',
    ],
    parameters: editSchema,
    prepareArguments: (input: any) => {
      if (input && typeof input.edits === 'string') { try { input.edits = JSON.parse(input.edits); } catch { /* left for validation */ } }
      if (input && input.edits && !Array.isArray(input.edits) && typeof input.edits === 'object') input.edits = [input.edits];
      // Constrained sampling sends absent optional fields as null.
      if (input && Array.isArray(input.edits)) input.edits = input.edits.map((e: any) => e && typeof e === 'object' ? Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null)) : e);
      return input;
    },
    async execute(id: string, input: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const edits = Array.isArray(input?.edits) ? input.edits : [];
      if (!edits.length) throw new Error('edits must contain at least one edit.');
      const legacy = edits.filter((e: any) => typeof e?.oldText === 'string');
      if (legacy.length === edits.length) return (builtinEdit as any).execute(id, { path: input.path, edits: edits.map((e: any) => ({ oldText: e.oldText, newText: e.newText })) }, signal, onUpdate, ctx);
      if (legacy.length) throw new Error('Mix of oldText and anchor edits in one call: use anchors (start/end/after) for all of them.');
      const path = resolvePath(String(input.path), ctx?.cwd || cwd);
      return withFileMutationQueue(path, async () => {
        if (signal?.aborted) throw new Error('Operation aborted');
        let raw: string;
        try { raw = (await readFile(path)).toString('utf-8'); } catch (e: any) { throw new Error(`Could not edit file: ${input.path}. ${e?.code ? `Error code: ${e.code}` : String(e)}. Create new files with write.`); }
        const bom = raw.startsWith(BOM) ? BOM : '';
        const body = bom ? raw.slice(1) : raw;
        const crlf = body.includes('\r\n');
        const lf = crlf ? body.replace(/\r\n/g, '\n') : body;
        let applied;
        try { applied = applyAnchorEdits(lf, edits); } catch (e) { if (e instanceof HashlineError) throw new Error(e.message); throw e; }
        if (signal?.aborted) throw new Error('Operation aborted');
        await writeFile(path, bom + (crlf ? applied.content.replace(/\n/g, '\r\n') : applied.content), 'utf-8');
        const diff = generateDiffString(lf, applied.content);
        const patch = generateUnifiedPatch(String(input.path), lf, applied.content);
        const summary = applied.regions.map(r => r.kind === 'insert' ? `inserted ${r.count} line(s) at ${r.from}` : r.count ? `lines ${r.from}-${r.from + r.count - 1} replace ${r.removed} old line(s)` : `deleted ${r.removed} line(s) at ${r.from}`).join('; ');
        return {
          content: [{ type: 'text', text: `Edited ${input.path}: ${summary}. Current anchors around the changes (lines below them have shifted):\n${describeRegions(applied.content, applied.regions)}` }],
          details: { diff: diff.diff, patch, firstChangedLine: diff.firstChangedLine },
        };
      });
    },
  } as any);
}
