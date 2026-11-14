# ADR 1314 — The first page is composed first; the composition says when it is provisional

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v84. `paged-canvas` (`compose.rs`: the reduced document and the closure of
  spreads; `model.rs`: `CanvasModel::load_progressive`, `compose_next`, `ensure_composed`,
  `is_provisional`, `page_composed`, `DocumentHandle.provisional` / `composedPages`;
  `channel.rs`: `LoadDocument.firstPages`, `ComposeNext`, `CompositionProgress`),
  `paged-canvas-wasm` (the dispatch, `loadDocumentDirect(…, firstPages)`, `pageComposed`, the GPU
  presenter leaves a page not composed undrawn, a snapshot composes its page first), the editor's
  worker (`worker.ts`: the composition's steps; `render.ts`: a page not composed is outlined,
  `priorityPages`), client (`loadDocument(…, { firstPages })`, `whenComposed`, `isProvisional`)
  and shell (the loader's stages, `LoadingState.provisional` / `composedPageIds`, the loading
  status). The engine's half of the interaction specification's UXI-PRF-001, PRF-003 and PRF-005
  and of the strategy's §9.1 (the first useful page), UX audit F-53; editor ADR 1232 recorded the
  gap.

## Context

A document opened in the editor was built whole before anything was answered:
`CanvasModel::load` parsed the package and ran `pipeline::build_document` over every page, and
only then did the worker reply, the editor learn the page count and the canvas draw a page. The
first page of a large template waited for the composition of all the others (editor ADR 1232
measured the 54 MB and 105 MB templates). Editor ADR 1208 gave the load its stages — recognized,
geometry, first paint, refining — but the engine had no stage between "nothing" and "everything".

The interaction specification asks for the first useful page as early as possible, the pages in
view before the others, stale work dropped when the camera moves (PRF-001, PRF-005), loading
stages without an invented percentage (PRF-003), and never a provisional page presented as final
(strategy §9.1).

## Decision

**A progressive load composes the pages asked for first.** `LoadDocument` (and the binary
`loadDocumentDirect`) take `firstPages`, page indices. The model parses the package as before,
then builds a *reduced* document: the spreads holding those pages as they are, every other
spread cut down to its pages (no items, no master page behind them), no story growing
(`crate::compose`). Its pages are the document's own — the page list, every page's size, place,
label and section number are the whole document's — and the pages of the spreads left out are
empty and marked not composed. The spreads composed are a closure: a spread holding an earlier
frame of a story that reaches a composed spread is composed too, so a threaded story arrives on
the page with the text its earlier frames left over. The reply's `DocumentHandle` is
`provisional`, with `composedPages`.

**The rest is composed in steps, the pages in view first.** `ComposeNext { priority }` composes
the first page of `priority` (indices, the pages in view nearest the viewport's centre first)
that is not composed yet, with its closure, in a provisional build of its own whose pages replace
the empty ones. With no such page left, the step is the whole document's build: it replaces every
page, the model is final, and the reply (`CompositionProgress { pageIds, composed, pageCount,
done, pageStructureChanged, pageSizesPt?, pageOriginsPt? }`) is `done`; a growing story's pages
arrive with it. The editor's worker runs one step per task, reading the pages in view from its
last draw, so a camera move between two steps changes what the next one composes and nothing is
queued that the move could make stale; a step in flight is not interrupted (the worker is one
thread), and the last step is as long as a whole build.

**What a provisional page cannot know, it does not pretend to.** A count continued from another
story's list, a running header, a cross-reference's page number, a table of contents' pages, the
pages a growing story adds, the footnote and endnote numbers counted across the document: a
provisional page shows them as the reduced document has them. That is why it is provisional:
the handle and every step say so, the editor's loading status says "Composing pages · 3 of 12 ·
provisional" in real counts, the pages not composed are outlined and never drawn (the CPU tiles
and the GPU presenter skip them, as empty is not blank), and only the last step's build is final.
The thumbnails of pages 2 onward are taken after it.

**The final composition is the whole document's composition.** The last step is
`commit_and_rebuild(Everything)`, the build every edit runs; the provisional builds use the
paragraph layout cache (its keys hold everything a paragraph's lines depend on) and no
cross-build emit cache, so no provisional delta reaches the final build. The determinism test
(`tests/it/progressive_composition.rs`) loads twelve generated documents — threaded stories,
masters with page numbers, cross-story lists, variables and running headers, a table of
contents, growing stories, footnotes, pictures, cross-references — progressively from the first,
the last and the middle page, steps them to the end, and compares every page with a model loaded
whole (display-list digest, line geometry, size and place, the diagnostics) and with a cold
build of its scene (the ADR 027 digest gate).

**Anything that writes ends the provisional state.** An edit, an undo, a registry change: the
rebuild that follows is the whole document's (nothing provisional is adopted or reported as
unchanged), and the next `ComposeNext` answers `done` with every page and builds nothing. A
snapshot of a page not composed yet composes it first (`ensure_composed`). Exports build the
whole document as before.

**The last step can come before the handle is in use.** A small document's whole build is the
worker's very next task, so its `done` can reach the main thread before the code that asked for
the load has set the handle it was answered. The client keeps that step: `composedHandle(handle)`
is the handle as the composition left it (no longer provisional, with the final build's page
list), however early the step came, and the editor's shell sets the handle through it and turns
the handle it holds final with an update rather than a value.

## Consequences

- The first page of a large document is composed in the time of its own spreads, not the
  document's. Measured on the 54 MB template (editor `docs/reference/performance.md`): the first
  page on screen 3.7 s after the layout instead of 4.4 s with the decoded-picture store alone;
  the package's parse and the first GPU present of a page of photographs are what remains.
- The work to the final document is the provisional builds plus one whole build (with the
  paragraph layouts the provisional builds left in the cache).
- A non-editor host loads as before (`firstPages` absent): nothing changes for the CLI, the
  server or scripts.
- A document whose every page is on one spread composes it whole in the first step and is never
  provisional.
