# ADR 660 — A PDF reads back into the document it was set from

- **Status:** Accepted 2026-11-17.
- **Scope:** `crates/pdf-import` — the structure reader `reconstruct/` (`mod.rs`, `text.rs`,
  `styles.rs`, `fonts.rs`, `recipe.rs`), `pdf_reconstruct` in `lib.rs`, the
  `paged-pdf-import` binary, the glyph records the page reader keeps (`vectors/device.rs`,
  `vectors/ir.rs`: `GlyphPos`, `FontFace`, `font_key`), `vectors::Reader`, and the
  `TextMode::Skip` / picture-frame path of `lower.rs`. Amends [ADR 654](654-pdf-ir-and-mapper.md),
  [ADR 656](656-pdf-opens-as-native-document.md) and
  [ADR 658](658-a-pdf-page-places-as-native-vectors.md). Engine side: `paged inspect --json`
  names the overset stories (`oversetStoryIds`) and, with `--story-lines`, the text of every
  line the engine set (`storyLines`); the font registry registers a static face under its own
  style.

## Context

A PDF opened in Paged became pages of positioned lines ([ADR 656](656-pdf-opens-as-native-document.md)):
one text frame per line, no paragraph or character styles, colours as unnamed swatches, no
threads, no masters, single pages only, and nothing past page 12. That is a picture of a
document with selectable text, not a document. Editing a word does not reflow the paragraph,
changing a style changes nothing else, and a long publication cannot be opened at all.

A PDF exported from a layout program keeps more of its document than that. Each glyph sits
where the composer set it; each text frame's lines are painted together and in order; the
fonts, their widths and the fill colours are all in the file. That is enough to read most of
the structure back: lines, paragraphs and their alignment, the frames and how wide they were,
which frames a story ran through, which paragraphs share a style, which items every page
repeats.

## Decision

1. **One reader pass, in Rust.** The page reader of [ADR 658](658-a-pdf-page-places-as-native-vectors.md)
   (`hayro-interpret`) keeps every glyph of a text run: its origin, advance (the font's widths),
   em size, horizontal scale, the height of its ink, and the interpreter's key for its font.
   `vectors::Reader` opens a file once for all its pages and names every font the file defines
   by that key (a Type 1 font's program does not name itself to the interpreter; its dictionary
   does). PDFium remains the raster fallback; the editable open path no longer needs its text.
   A glyph the PDF maps to no text (a small capital or an alternate outside its `ToUnicode`) is
   read by the name its embedded program gives it, the Adobe Glyph List's way (`s.sc` is an S);
   a ligature's presentation form (ﬁ, ﬀ …) reads as its letters, for the composer forms
   ligatures from the face it sets.
2. **Glyphs → lines → frames → paragraphs** (`text.rs`). Glyphs join a line along a baseline
   in paint order. A word space is a gap past the line's own letter spacing (its median gap
   and a tenth of an em), so text set tight and text tracked open both keep their words. A
   line with a gap no line near it repeats is not a row of a table but items on one baseline (a
   label beside the next, a caption and its mark), each set where the page sets it. Lines join a frame while they run down the same column within a few lines;
   a frame splits where display type (14 pt and up) meets body text, and where its lines change
   measure (frames threaded one under the other). A frame's width is bounded by its own
   breaks: a soft break happens because the next word would not fit, so each bounds the width
   from above, the widest line from below, and the frame takes the middle — a face a little
   wider or narrower than the original still breaks where the page breaks. In Chinese and
   Japanese, which break between any two characters, the next line's first word is its first
   character. A break that bound
   does not explain is a forced line break; display type keeps every break as a forced one.
   Paragraphs end at extra space, a change of size or colour, a first-line indent, a short line
   in a justified frame, or a change of face where a sentence ends. A first line hung left of
   the rest is a negative first-line indent (a bullet or number in the margin); a line that
   opens with a bullet, or steps back out to the edge the hung lines were indented from, starts
   the next list item. Alignment comes from line
   edges; justification also from word spaces wider than the font's (tracking taken off).
   Hanging punctuation and display letters pulled into the margin read as optical margin
   alignment, not as indents. InDesign's All Caps is read from the ink: a lowercase letter
   drawn at cap height.
3. **Tables as tabbed rows.** Cells on one baseline are one row, also when the page paints them
   in passes (a shaded column of figures after the rest): short or numeric lines on a shared
   baseline join. Gaps are measured from the last inked glyph, so the space glyph a layout
   program sets before a tab's jump does not hide the tab. A block's columns are where its rows'
   cells line up — right edges for figures, left edges for text, the decimal point for figures
   whose negatives in parentheses run past the positives' last digit — and become the block's
   tab stops (a decimal one aligns on the full stop); each row is a paragraph of its own, with as many tabs as columns a cell skips (a total
   with an empty label cell starts with them). Rows of different blocks never join across a
   page edge. A row is set No Break: a substitute face a little wider than its columns' gaps
   runs it past the frame's edge rather than onto a second line.
4. **Hyphens resolved against the document.** A line-end hyphen inside a word is hyphenation
   (dropped, the paragraph set to hyphenate) unless the document spells that word with a
   hyphen mid-line or the word is already hyphenated elsewhere ("state-of-the-art"). InDesign
   writes a discretionary hyphen as U+2010 at a line's end, as U+00AD mid-word, and as a
   zero-advance space between letters; all three read as what they are.
5. **Stories and threads.** A frame whose last paragraph runs to its end unfinished, followed
   in reading order (to its right, below it, or on the next spread) by a frame that starts in
   the same face, size and colour, continues the story; the paragraph cut by the frame break is
   joined back into one. A frame the story runs on from ends just under its last line, so the
   next line goes on; the last frame keeps a line's room, and up to three where its column is
   free of other text down to the page's foot.
6. **Styles** (`styles.rs`). Paragraphs that share face, size, colour, leading, alignment,
   indents and All Caps share a paragraph style; a run that differs from its paragraph's style
   takes a character style. Names say what a style is (`Medium 11/12`, `Black 50/42 Caps White
   Centered`); a recipe renames them to what they are for. Space before is the gap between two
   paragraphs of one style; a style never followed by itself (a heading) leaves its air as
   space after. What does not fit the styles is local, and counted.
7. **The metric fit.** The document is set in substitute faces (a PDF's fonts are the
   publisher's licence, not ours). Each style's tracking is the PDF's measured letter spacing
   plus what makes the substitute's advances (read with `skrifa`, at the named instance a style
   asks of a variable face) add up to the original's, then held inside what every line allows:
   no line may run past its frame, and no soft break may close up. A heading that cannot share
   its style's tracking gets its own. Where the composer still breaks differently, the engine
   decides: `paged inspect --story-lines` gives the lines it set, a paragraph whose lines do
   not match the PDF's moves its tracking by what its last line is long or short, and the
   recipe keeps that as `paragraph_tracking`, so the next import reproduces it.
8. **Masters, spreads, sections.** Text that repeats at one place, in one face and colour, on
   a fifth of the spreads or more is a master item; spreads that carry the same set share a
   master (A, B, …); a folio becomes the page-number marker, and the folios' numbering starts
   the document's section. A repeated item's number is a folio only where it changes from page
   to page, and only the run of digits that changes becomes the marker: an issue number or a
   year beside it stays text. A PDF exported as spreads (pages twice the width of the first) reads
   as facing spreads; single pages can be paired by the recipe.
9. **Pictures in frames.** A clip around one image — a picture frame as its PDF writes it —
   lowers to one native image frame: the clip its bounds, the image placed by its own transform,
   so the crop survives and the picture moves inside its frame. Opaque photographs that the
   reader decoded to PNG (an ICC-based or CMYK JPEG) are stored as JPEG at quality 92.
10. **The recipe** (`recipe.rs`): what the page cannot say — the font map (PostScript name →
   family and style), style and swatch names, layout, page range, thread fixes, section starts.
   An empty recipe reads the PDF on its own.
11. **Reported, not hidden.** The report counts pages, frames, stories, thread links, styles
    (with a sample and page each), swatches, masters, local overrides, every font with the
    characters its substitute lacks, and every loss the page reader recorded; it maps each
    document page to the PDF page and offset it came from, for comparison.

## Evidence

- `tests/reconstruct_structure.rs` — InDesign's PDFs of the engine's generated samples
  (`engine/core/corpus/generated/*.pdf`) read back against the samples themselves: the words
  (recall 0.95–1.0 across chain-widths, composer, justified-breaks, forced-line-break,
  hard-hyphen, soft-hyphens, mixed-leading, paragraph-attrs, keeps, annual-base), the thread
  links of chain-widths, and the page count.
- `paged inspect --json` on a read document: overset stories by id.

## Alternatives considered

- **Keep reconstruction in TypeScript next to PDFium** ([ADR 654](654-pdf-ir-and-mapper.md)).
  PDFium's API gives characters, not the font programs' widths, the interpreter's font keys or
  the ink; and the editor's importer and a command-line run should read a PDF the same way.
- **Embed the PDF's fonts.** They are subsets licensed to the publisher, and a subset cannot set
  the text an edit adds.
- **Force every line break** to reproduce the page exactly. The text would no longer reflow:
  a picture of a document again. Only display type keeps its breaks.

## Consequences

The editor's PDF importer still opens through [ADR 656](656-pdf-opens-as-native-document.md)'s
path; moving it onto `pdf_reconstruct` (with the font book the host has) and lifting its page
limit is the follow-up. Frames read from geometry are frames of the page, not always the
designer's: two frames set flush in one column with the same measure read as one, a heading and
its body are two. Colours are read in sRGB (`hayro-interpret` does not expose a colour's source
space): CMYK and spot names are not recovered yet.
