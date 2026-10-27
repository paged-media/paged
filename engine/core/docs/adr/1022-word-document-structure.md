# ADR 1022 — Word document structure: section masters, Word fields, and creating tables of contents, cross-references and index markers

- **Status:** Accepted 2026-10-25.
- **Scope:** protocol v76 (the new mutations, operations and fields ride v76, which is
  unreleased: governance rule 4; every addition is optional on the wire and skipped in the
  model when unset). Amends [ADR 026](026-auto-growing-region-chains.md) (a grow rule now names
  masters). Extends [165](165-update-table-of-contents.md) (a table of contents inside a story),
  [168](168-generate-index.md) (an index marker op), [169](169-update-cross-references.md)
  (inserting a cross-reference) and [173](173-bookmarks-edited.md) (Word's bookmarks, which are
  text destinations, not ADR 173's PDF bookmarks). Part of engine wave E2 of the paged.doc
  Word-parity program; the plugin's headers, footers and field mapping are paged.doc work
  (thoughts ADR 033).
  - `paged-model`: `FlowGrowRule.master` / `first_master` / `even_master` / `section_start`
    (`SectionStart`); `CharacterRun.field` (`WordField`, `WordFieldKind`, module
    `word_field` with the instruction parser and Word's date pictures);
    `DocumentPreference.show_field_codes`; `Paragraph.toc`; `CharacterRun::reads_layout`.
  - `paged-scene`: `grow.rs` applies the section rules (`apply_section_rules`,
    `generated_blank_page_id`, `chain_page_ids`, `page_numbers`).
  - `paged-mutate`: `FieldKind::Word`; operations `InsertTextAnchor`, `DeleteTextAnchor`,
    `SetStoryDestinations`, `InsertIndexMarker`, `RestoreIndexMarkers`, `SetTocStyle`
    (`apply/word_structure.rs`); the property path `DocumentShowFieldCodes`; story
    destinations take part in id minting.
  - `paged-renderer`: `pipeline/word_fields.rs` (live results at emit, F9 over a build); the
    post-layout pass learns `PAGEREF` and `STYLEREF`.
  - `paged-canvas`: `word_structure.rs` (the lowerings, destinations kept across text edits),
    `PageSummary.applied_master`, `StoryGrowRule` with the masters.
  - `paged-wire`: `updateFields`, `insertTextAnchor`, `deleteTextAnchor`,
    `insertCrossReference`, `insertTableOfContents`, `insertIndexMarker`; `setFlowGrowRule`
    gains `master`, `firstMaster`, `evenMaster`, `sectionStart` (`SectionStartSpec`);
    `CrossReferenceTarget`, `CrossReferenceKind`, `TocLevelSpec`.
  - `paged-script`: `paged.updateFields`, `insertTextAnchor`, `deleteTextAnchor`,
    `insertCrossReference`, `insertTableOfContents`, `insertIndexMarker`; options on
    `paged.setFlowGrowRule`.
  - `idml-export`: `word_fields.rs` (fields written as InDesign's variables or as text).

## Context

A Word document is sections of pages that grow with their text (ADR 026), each with up to
three headers and footers (first page, odd, even) and an odd- or even-page start; its text
carries fields (`PAGE`, `NUMPAGES`, `SECTIONPAGES`, `DATE`, `REF`, `PAGEREF`, `SEQ`,
`STYLEREF`, and the rest) whose results Word updates on F9 or at layout; and Word users insert
tables of contents, cross-references and index entries from menus. The engine had growing
chains whose generated pages copied the last page's master, so a section could not alternate
its headers; fields arrived as frozen text; and no operation created a table of contents, a
cross-reference, a bookmark in the text or an index marker (ADRs 165, 168, 169 and 173 list
them under "Not yet").

## Decision

### Section masters (amends ADR 026)

**A grow rule names the masters of its chain's pages.** `FlowGrowRule` gains `master` (every
page; the odd pages' when an even master is set), `first_master` (Word's "different first
page") and `even_master` (Word's "different odd & even"), spelled as `Page@AppliedMaster`.
`Document::with_generated_pages` applies them to EVERY page of the chain in the grown copy,
authored pages included, because a section's first page changes parity when an earlier section
grows: the first page takes the first master when there is one, a page whose number is even
takes the even master when there is one, and every other page the master. A rule that names
no master keeps ADR 026's behaviour (a generated page copies the master of the page it
follows), so an IDML document, whose stories carry no rule, is unchanged. "Link to previous"
is the plugin naming the previous section's master.

**Parity is the page number.** Odd and even come from the page's number by the section rules
(`SectionWalk`), not from its position, as Word decides it: a section restarting at 1 starts
on an odd page.

**An odd- or even-page start inserts a blank page.** `section_start` (`newPage`, `oddPage`,
`evenPage`, Word's `w:sectPr/w:type`) is checked against the number of the chain's first
page; when it does not accept it, a blank page (the size, margins and master of the page
before it, nothing on it) is put in a spread of its own in front of it, with the stable id
`<story>_blank_page`. The blank page shows the section before it: it takes that section's
master as that section's next page would (Word prints the previous section's header and
footer there). Sections are visited in the order of their first pages, so a blank page moves
the numbers of the sections after it before their starts are checked. The document's first
page never gets one.

**Where a header is edited.** Master items already render on every page, generated ones
included, and a master frame's story is an ordinary story: text edits address it directly,
and `onMaster` wraps page-item edits. `PageSummary.appliedMaster` now reports the master a page
shows as the build applied it, so a host that hits a header on page 7 knows which master's
frame (and story) to edit; the editor's in-place sub-context (editor ADR 301) is built on it.
The plugin creates the section masters with `createMaster` and the existing frame and text
mutations (or writes them into its skeleton, thoughts ADR 033), and sets the rule.

### Word fields

**A field is a run.** `CharacterRun.field` holds the instruction (`code`, Word's
`w:instrText`, trimmed), the kind the engine reads out of it, and the `\*` number format; the
run's text is the field's result, as a variable run carries its `ResultText`.
`WordField::parse` reads Word's grammar (a name, bare or quoted arguments, switches with and
without values). The kinds:

| Kind | Code | Result | When it changes |
|---|---|---|---|
| `date` | `DATE` / `TIME` `\@ "picture"` | the host's clock in Word's picture (`d` `dd` `ddd` `dddd` `M`…`MMMM` `yy` `yyyy` `h` `H` `m` `s` `am/pm`, `'literal'`; default `M/d/yyyy`, `h:mm am/pm`) | F9 with `now` |
| `numPages` | `NUMPAGES` | the document's page COUNT | at layout |
| `sectionPages` | `SECTIONPAGES` | the page count of the field's section | at layout |
| `page` | `PAGE` | the page's label (its number in the `\*` format when given) | at layout |
| `ref` | `REF bm` | the bookmark's text: its paragraph from the bookmark on | F9 |
| `pageRef` | `PAGEREF bm` (`\p`) | the label of the bookmark's page; with `\p`, "above" / "below" on the field's own page, else "on page N" | at layout |
| `seq` | `SEQ id` (`\r n`, `\c`) | the item's number in its sequence, in document order | F9 |
| `styleRef` | `STYLEREF "style"` (`\l`) | the first (last) paragraph in the style on the page, else the last one before: a running head | at layout |
| `opaque` | anything else | the text it came with | never |

"At layout" kinds are resolved by the emitter like a text variable: `PAGE`, `NUMPAGES` and
`SECTIONPAGES` in every pass, `PAGEREF` and `STYLEREF` in the post-layout pass, which they now
trigger (bookmark pages ride the cross-reference page map; `STYLEREF` styles join the running
header index). `PAGEREF` is live as InDesign's cross-reference page number is (ADR 169), where
Word waits for F9: a stale page number is never printed. A missing bookmark prints Word's
"Error! Bookmark not defined." (`PAGEREF`) or "Error! Reference source not found." (`REF`).
A story with a live field is treated as one that reads variables (no keep seeds, page context
in its cache keys).

**F9 is `updateFields { storyId?, offset?, now? }`.** It recomputes every field (one story's,
or the one field starting at a story char offset) over the current layout and writes the
results into the runs: one `ReplaceStoryParagraphs` per story it changes, one undo step.
`SEQ` is counted over the whole document whatever is updated. `DATE` and `TIME` take `now`
from the host (the engine reads no clock) and keep their result without it. A field in a
story the layout does not place (a master's) keeps the result its live kinds already print.
Nothing to change is a refusal, as find-and-replace's is.

**Show field codes** (Alt+F9) is `DocumentPreference.show_field_codes`, the property path
`documentShowFieldCodes` on the document: every field prints `{ code }`. It is a view flag
the `.paged` model part carries, like `showHiddenText` (ADR 1018).

**Inserting a field.** `insertField` takes `{ word: { code, result? } }`. Without a result the
canvas computes the one an update would give (the field inserted on a copy and updated there),
so a new `NUMPAGES` shows the count at once; a date without a clock shows its code until F9.

**IDML.** InDesign has no fields. A field with an InDesign counterpart is written as an
instance of a text variable the writer defines: `PAGE` as the page number marker
(`<?ACE 18?>`), `NUMPAGES` and `SECTIONPAGES` as `LastPageNumberType` in document and section
scope (InDesign prints the last page's LABEL, which equals Word's count only when numbering
starts at 1 and never restarts; thoughts ADR 033), `STYLEREF` as `MatchParagraphStyleType`
(`FirstOnPage`, `LastOnPage` with `\l`), `DATE` / `TIME` as `OutputDateType` with the picture
in InDesign's tokens (`ddd` → `EEE`, `am/pm` → `a`). Every other field is written as its
result. The variables are named `Word <code>` (`dTextVariablenWord NUMPAGES`). The `.paged`
model part keeps the fields themselves.

### Bookmarks, cross-references, tables of contents, index markers

**A Word bookmark is a text destination** (ADR 169's `StoryDestination`), not ADR 173's
bookmark, which is a PDF outline entry. `insertTextAnchor { storyId, offset | contentOffset,
name }` makes one (the canvas mints `HyperlinkTextDestination/u…`; names are unique);
`deleteTextAnchor` removes it. Text edits now keep a story's destinations where they stand:
the text kernel moves each through the edit as a tagged range is moved (ADR 1002), and a
destination at a paragraph's start stays at a paragraph's start (a split before it carries it
on). Story destinations take part in id minting.

**`insertCrossReference { storyId, offset | contentOffset, target, referTo, hyperlink? }`**
inserts the field Word inserts: `REF bm \h` (text), `PAGEREF bm \h` (page number) or
`PAGEREF bm \p \h` (above / below), with its result. The target is a bookmark (by name or id)
or a paragraph (a heading); a paragraph gets Word's hidden bookmark `_Ref<n>` at its start,
reused by later references to it. One undo step takes the field and the bookmark back.

**`insertTableOfContents { storyId, offset | contentOffset, levels, title?, tocStyleName?,
pageNumbers?, leader?, tabPosition? }`** puts a Word table of contents INSIDE the story's text,
as Word does (InDesign's is a story of its own, ADR 165). When the document lacks them it
creates the TOC style (`TOCStyle/<name>`, default "Table of Contents", one entry per level,
separator `^t`, page number after the entry), the entry styles `TOC 1`… (based on the
document's normal style, 12 pt more indent per level, a right tab with the leader, default
".", at the frame's measure inside its insets unless `tabPosition` says) and `TOC Heading` for
a title. The entries are ADR 165's (`resolve_toc_on`, `toc_paragraphs`), each paragraph tagged
`Paragraph.toc` with the style, and stand before the caret's paragraph (after it when the
caret is inside it). Their page numbers are those of the layout the insertion makes: the
entries are written over the current layout, the result built on a copy, and the entries
written again over that build when its pages differ. `updateTableOfContents` on a story whose
text holds such a table rewrites the run of paragraphs naming the style in place, the same
way; destinations after it move with the paragraphs (`SetStoryDestinations`). One undo step
each.

**`insertIndexMarker { storyId, offset | contentOffset, topic, sortOrder? }`** adds an index
marker for a topic path (one to four levels) to the paragraph holding the offset, creating the
topics the document lacks, nested under their parents (ids `Topic/<path>`); its inverse
restores the paragraph's markers and the document's topics exactly. `generateIndex` lists it.

## Evidence

- `paged-model` `word_field` tests: the kinds Word writes parse (switches, quoted arguments,
  number formats, `MERGEFORMAT` ignored); Word's date pictures format.
- `paged-canvas/tests/it/word_structure.rs`: a section alternates first / even / odd masters
  and keeps the other section's; without a first master the first page takes its parity; one
  master for every page; an odd-page start puts a blank page 4 in front of section 2 (it shows
  section 1's even master, nothing is set on it, section 2 opens on page 5) and an even-page
  start needs none; the rule reads back with its masters; inserted fields show their result
  (`PAGE` 1, `NUMPAGES` 5, a date's code without a clock) and F9 writes the date in one undo
  step, refusing when nothing changes and a bad clock; `SEQ` counts in document order after F9;
  a cross-reference to a heading makes `_Ref1`, prints page 4 and the heading's text, reuses the
  bookmark, undoes in one step, and reads page 2 after 100 paragraphs are deleted and F9; a
  bookmark follows a paragraph break typed before it and comes back on undo; a table of
  contents is inserted with its title, `TOC 1` and its dotted right tab, page numbers of the
  layout it makes, and is updated in place after a deletion (and the three steps undo to the
  model as it was); index markers reach `generateIndex` (`Apples  2`, `Fruit` / `Pears  3`);
  fields export to IDML as `LastPageNumberType` (both scopes), `MatchParagraphStyleType`, the
  page number marker and text, and survive a `.paged` round trip; show field codes is a
  document flag that undoes.
- `paged-canvas/src/word_structure.rs` tests: offsets find their paragraph in both units;
  destinations follow insertions and paragraph splits. `channel.rs`: the six mutations and a
  Word `insertField` round-trip the mutate envelope.
- `paged-renderer/tests/it/word_fields.rs`: on Word's two-section document stale fields print
  `Pages:5`, `Sec:5`, `Here:1`, `Ref:4` and a running head on page 5, `SEQ` its result; show
  field codes prints the codes; a missing bookmark prints Word's error.
- `paged-script` host-function rows for the six functions.

## Found on the way

**A growing story kept its old pages after a delete.** A rebuild after text edits of one story
adopts the previous build's pages nothing was laid out on afresh (ADR 027 plan step 7). A
page that held the edited story's old lines and now holds none was adopted with those lines,
so the grow loop saw its frame in use and never dropped it: deleting 100 paragraphs of a Word
section left its three pages. A previous page holding lines of a story the build laid out
afresh is now never adopted (`build_engine.rs`, the adoption pass).

## Consequences

- paged.doc can place headers and footers per section (masters plus the rule), lower Word's
  fields onto engine fields (`insertField { word }` or a run's `field` in its skeleton), keep a
  TOC, cross-references and index entries live, and save them back from the `.paged` model.
- The editor's F9 / Shift+F9 / Alt+F9, Insert Cross-reference, Insert Table of Contents, Mark
  Entry and Insert Bookmark are one mutation each.
- Residuals: `CREATEDATE` / `SAVEDATE` / `PRINTDATE` and every other field are opaque; Word
  bookmarks are points (`REF` reads to the paragraph's end, not to a bookmark's end); a
  continuous section break (two sections on one page) is not modelled; a TOC style made here,
  a `Paragraph.toc` tag, new text destinations and index topics are not written into IDML (the
  `.paged` model keeps them); field names in dates are English; `NUMPAGES` / `SECTIONPAGES` in
  IDML are InDesign's last page label; destinations are kept across text-kernel edits, not
  across a `ReplaceStoryParagraphs` another op writes; the blank page inserted for a section
  start takes the master the previous section would give the page, not a "blank" header.
