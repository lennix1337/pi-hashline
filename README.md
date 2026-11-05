# pi-hashline

Line-anchored edits for [Pi](https://github.com/earendil-works/pi). It overrides two built-in tools:

- **read** returns each text line as `LINE:HASH|text`, for example `12:a3|const x = 1;`. The hash is two base-36
  characters of the line's content. Offsets, truncation notices and images work as in the built-in read. Code Mode
  scripts (`tools.read`) get the plain text, without prefixes.
- **edit** names the lines to change by those anchors and carries only the new text:

```json
{ "path": "src/a.ts", "edits": [
  { "start": "12:a3", "end": "15:k0", "newText": "const x = 2;" },
  { "after": "40:9z", "newText": "// inserted after line 40" },
  { "start": "50:q1", "newText": "" }
] }
```

`end` is inclusive and defaults to `start`; `newText: ""` deletes the lines; `after: "0"` inserts at the top. Every
anchor in one call refers to the file as it was last read, so edits in one call never shift each other. An anchor
whose hash no longer matches the line (the file changed since the read) refuses the whole call and shows the current
anchors around that line. The result of an edit lists the new anchors around each change, so a second edit does not
need another read. CRLF line endings and a BOM are kept.

An edit whose items all carry `oldText` runs through the built-in exact-text edit, for files read some other way.

The idea comes from oh-my-pi's hashline mode (can1357/oh-my-pi), which reported fewer output tokens and fewer failed
edits than exact-text replacement. This package is a small independent implementation for stock Pi.

## Use

```bash
pi -e C:/projetos/pi-hashline            # one session
```

or add the folder to `packages` in `~/.pi/agent/settings.json`.

## Measurement

`payload/tools/bench/waste` in lennix1337/dotfiles has 12 edit tasks (`--set edit`, 4 held out) graded by the final
files. Compare the live stack with and without this package:

```bash
node run.mjs run --label edit-base --model <subscription model> --set edit --rounds 3
node run.mjs run --label edit-hashline --model <same model> --set edit --rounds 3 --extension C:/projetos/pi-hashline
node compare.mjs <base dir> <hashline dir> --edit
```

## Develop

```bash
npm install
npm run verify      # typecheck + tests
npm run mutations   # each guard has a test that fails without it
```
