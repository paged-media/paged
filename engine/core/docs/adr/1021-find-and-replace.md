# ADR 1021 — Find and replace

- **Status:** Accepted 2026-10-24.
- **Scope:** protocol v76 (`findReplace` and `RequestFindText` / `FoundText` ride v76, which
  is unreleased: governance rule 4). `paged-wire` (`FindSpec`, `FindMode`, `FindHit`,
  `Mutation::FindReplace`); `paged-canvas` (`find.rs`, `CanvasModel::find_text`,
  `lower_find_replace`, the `RequestFindText` message); `paged-canvas-wasm` (`dispatch.rs`);
  `paged-script` (`paged.find`, `paged.findReplace`); `paged-introspect` (two host-function
  rows). Part of engine wave E1 of the paged.doc Word-parity program; the editor's dialog and
  results list are editor ADR 303.

## Context

A Word user expects Find & Replace: match case, whole word, wildcards, the special characters
`^p` `^t` `^l` `^m`, find by style, Replace All as one undo step, and a results list. The
engine had no find at all; an editor-side search over the text it could read would have
missed paragraph boundaries, seen offsets in the wrong unit and made Replace All one undo step
per hit.

## Decision

**What is searched.** Each story is searched as its text with ONE separator per paragraph
boundary — the caret (`ContentSelection` / `insertText`) space, so a hit's `[start, end)` is
exactly what `deleteRange` / `insertText` take. The separator is `\n`, or `\u{000C}` where the
next paragraph starts on a new page (`StartParagraph` NextPage / NextOddPage / NextEvenPage —
how a Word manual page break arrives), so `^p` and `^m` can tell them apart. Hits are reported
in story order (document story order across stories), each with its story, caret range,
character range (the `applyStyle` / story-range space), paragraph index, the matched text, up
to 30 characters of context either side within the paragraph, and the regex groups.

**Patterns.** `FindSpec { find, storyId?, mode, matchCase, wholeWord, paragraphStyle?,
characterStyle?, limit? }`. Three modes:

- `literal` — the text as written;
- `wildcards` — Word's: `?` `*` `@` `<` `>` `[…]` `[!…]` `{n;m}` `(…)` `\x`, translated to a
  regex (`*` and `?` never cross a paragraph);
- `regex` — an ECMAScript regular expression.

Word's special characters work in every mode: `^p` paragraph, `^t` tab, `^l` line break
(U+2028), `^m` page break, `^?` any character, `^#` any digit, `^$` any letter, `^^` a caret.
Case-insensitive is the default (Word's). Whole word is checked on the hit's neighbours
(Unicode letters, digits, `_`), not with `\b`, which is ASCII in ECMAScript. The style filters
keep a hit whose paragraphs carry the paragraph style and whose runs all carry the character
style.

**The engine is `regress`**, the ECMAScript regex engine Boa already links into the worker
(same version, same features): search adds no engine and no code to the wasm, and `regex`
mode means the same thing in `paged.find` as in a script's own `RegExp`.

**Replace.** `findReplace { spec, replace, replaceAll, paragraphStyle?, characterStyle? }`
lowers, in the canvas model, to ONE batch: per hit, last first (so no edit moves an offset
still to come), `deleteRange` of the hit, `insertText` of the replacement, and `applyStyle`
over the replacement when a style is named. The batch takes the mixed lane, so it is one
undo step whatever it holds (Replace All is one Cmd+Z), and it runs through the text kernels,
so fields, anchors, notes and tracked deletions behave exactly as typed edits do. In the
replacement `^p` `^t` `^l` `^&` (the found text) `^^` work, and `$1`… (regex) / `\1`…
(wildcards) insert the hit's groups; `^m` is refused (a page break is a paragraph attribute,
not text). Without `replaceAll` the first hit is replaced. Nothing matching is a refusal, not
an empty undo step.

**Reads.** `RequestFindText { spec }` → `FoundText { hits, error? }` for the results list;
`paged.find(text, options)` returns the same JSON in scripts, and `paged.findReplace(text,
replace, options)` replaces. A bad pattern is an `error` with no hits.

## Evidence

- `crates/paged-canvas/src/find.rs` tests: specials and wildcards translate; replacement
  specials and groups.
- `crates/paged-canvas/tests/it/word_editing.rs`: hits in caret and character offsets, case,
  `^p` across a paragraph break, regex groups, whole word, wildcards, the paragraph-style
  filter, a bad pattern refused; Replace All styled and undone in ONE step back to the same
  canonical hash; replace-one with `^p`; nothing matching refused; and a proptest that any
  find / replacement pair undoes exactly (ADR 197).

## Consequences

- The editor's Find & Replace dialog and the Navigation pane's Results tab are a view over
  `RequestFindText` and one `findReplace` (editor ADR 303).
- Residuals: table cells and footnote / note text are not searched (cells are their own
  streams; a later pass can add them with the cell qualifier the text ops already take);
  "find by format" filters on applied styles only, not on direct formatting; `^m` cannot be
  put in by a replace; the Rust CLI has no find verb (scripts and the editor do).
