# pi-hashline

Overrides Pi's `read` (each line tagged `LINE:HASH|`) and `edit` (edits by anchor). Read README.md for the contract.

Rules for changes:
- An anchor whose hash does not match refuses the whole call; never apply part of an edit or guess a moved line.
- Code Mode (`structuredContent`) gets the untagged text; only the model sees the prefixes.
- Line endings and BOM of the file are kept.
- Every guard has a mutant in `test/mutations.mjs` that a test kills.
- Adoption in the live stack follows the edit bench in lennix1337/dotfiles (`payload/tools/bench/waste`, `--set edit`).
