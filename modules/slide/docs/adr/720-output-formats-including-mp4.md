# ADR 720 — Output formats, including MP4

- **Status:** Accepted 2026-10-28.
- **Scope:** `slide-output` (new crate: PDF and outline writers), `pptx-export`
  (`presentation.rs`, `outline.rs`, `ExportPlan.format`, `.sections`, `.customShows`),
  `pptx-import` (custom shows, section ids), `slide-resolve` / `slide-native` (the labels that
  carry sections and custom shows), `slide-js` (`exportOutline`, `PdfWriter`),
  `packages/slide-bundle` (`output/`, `sections.ts`, `custom-shows.ts`, `show/offline.ts`,
  `views/slide-sorter.tsx`, `panels/custom-shows-panel.tsx`). Wave 6 of the parity program
  (ADR 711). The editor half of the video export is editor ADR 308.

## Context

PowerPoint writes a deck as more than a `.pptx`: a template (`.potx`), a PDF of the slides, of
handouts or of notes pages, the outline for Word (`.rtf`), and a video. It also organises a deck
into sections and plays named subsets of it (custom shows). paged.slide opened `.potx` and
`.ppsx`, kept sections contiguous on export and nothing else of this.

The host's PDF export (File ▸ Export PDF, the engine's `paged-export-pdf`) writes the open
document's pages as they are. The plugin contract has no door to hand it other pages or an
imposition, and the documents door opens a document only by replacing the open one. A video
needs the show's frames and transitions at a fixed rate, not at the screen's.

## Decision

- **Save as template.** `ExportPlan.format` (`pptx`, `potx`, `ppsx`) sets the content type of the
  presentation part; nothing else of the package changes, so a deck saved as a deck is still its
  own bytes. File ▸ Save as template… and a `.potx` exporter write it. Opening a `.potx` makes a
  new, untitled presentation built on it and says so in the import's diagnostics (editor ADR 293's
  rule: a template opened as a document says so).
- **Sections** ride the label of the slide they start at (`section: {id, name}`), so they move,
  duplicate and undo with that slide; the slides after it belong to it until the next start.
  Import writes them from `p14:sectionLst`; export writes the list from the document (a slide
  before the first start opens PowerPoint's "Default Section"; a repeated id, from a duplicated
  first slide, starts nothing). Deleting a section's first slide hands the section to the next
  slide. The Slide Sorter heads each section's slides: add one at the selection, rename it in
  place, move it with its slides, remove it (its slides join the section before).
- **Custom shows** ride the document's label (`customShows: [{id, name, pages}]`, by page id),
  beside `deck`; each edit is one undoable write. Import reads `p:custShowLst`; export writes it
  (relationship ids of the written slides, in `CT_Presentation`'s order), drops a slide the
  document deleted from every show, and drops the list when no show is left. Slide Show ▸ Custom
  Shows… opens a panel to name a show, choose and order its slides and play it; the show plays
  its slides in its order, hidden slides still skipped.
- **The outline** is read in Rust from the document's `.paged` serialization: each page's title
  placeholder and the paragraphs of its body, object and subtitle placeholders with their list
  level (`Body Ln`). It is written as RTF (`\outlinelevel` 0 for titles, 1–9 for body levels,
  non-ASCII as `\uN?`), which Word's outline and PowerPoint read back, or as UTF-8 text indented
  by tabs.
- **PDF** is laid out and written in Rust (`slide-output`) over images of the slides that the
  host's renderer draws (`render.snapshot`, RGBA at 150 dpi by default): slides one to a page at
  the slide's size; handouts of 1, 2, 3, 4, 6 or 9 a page in rows (three a page with lines for
  notes); notes pages with the slide above its speaker notes, continued on pages of their own
  when long. Text is Helvetica, a PDF standard font, in WinAnsiEncoding; a character it lacks
  prints as `?` and the export says how many. The host's vector PDF export stays File ▸ Export
  PDF for the slides one to a page.
  - Not chosen: a temporary native document of handout pages exported by the host. A plugin can
    reach the host's PDF export only for the open document, and opening another replaces it.
    A host door for imposed PDF pages (page images placed by a module, rendered by the engine
    as vectors) is the step that would make handouts vector; it is a contract change for a
    later wave.
- **Video.** The show is drawn offline (`show/offline.ts`): the same frames (`render.layers`) and
  the same WGSL transitions (ADR 721) on an offscreen WebGPU canvas, at a moment the caller names.
  The runner steps it at 24, 30 or 60 fps at 720p, 1080p or 4K (the width follows the slide's
  shape): each slide not hidden for its recorded time or the default seconds, its transition
  before it. WebCodecs encodes (H.264 High at the level the size and rate need, else VP9), and a
  small ISO-BMFF writer in TypeScript muxes one track (`ftyp`, `moov` first, one `mdat`;
  `avc1`/`avcC` or `vp09`/`vpcC`; `co64` past 4 GiB). No muxer dependency: the format needs a
  few hundred lines, and the tests read every box back. Without WebGPU the transitions are
  cuts; without an encoder for either codec the export says so. Audio from media items goes
  through an OfflineAudioContext once slides carry media (wave 4); until then the video is
  silent. The seam for animations is `OfflineRenderer.slide`, which takes per-item layers when
  wave 5 adds them.
- **One service.** `output/output.ts` runs every export, one at a time, with its progress and a
  Cancel the Export view shows. File ▸ Export… is a module view (extensions ADR 345). Every
  palette command has a typed twin, and scripts get typed commands for each export, custom show
  and section operation.

## Consequences

- Every output works headless and in the CLI's host but the video, which needs a browser's
  WebCodecs.
- Handouts and notes pages are raster: crisp at 150 dpi, larger than a vector file, and their
  text is not the slides' text.
- Notes text outside Windows-1252 prints as `?` until the PDF writer embeds a face; the host
  gives a plugin no font bytes today.
- Sections and custom shows survive `.paged` saves and undo; a deck that never had either writes
  none.
