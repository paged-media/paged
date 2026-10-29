# ADR 289 — The vector clipboard: copy writes SVG, paste reads SVG

- **Status:** Accepted 2026-10-28.
- **Scope:** `apps/canvas/src/clipboard-commands.ts` (Copy, Paste, Paste in place),
  `apps/canvas/src/plugin-clipboard.ts` (the bundles' `host.clipboard` backend),
  `apps/canvas/tests/headless/harness.ts`; engine ADR 1031 (`paged-svg`, `ExportSvg` /
  `RequestSvgImport`, protocol v77); extensions ADR 341 (`ClipboardPayload.svg`,
  `clipboard.svg@1`). Amends ADR 231. Work package WP4.9 of the image/draw master plan; closes
  D-63.

## Context

ADR 231 gave page items Cut, Copy and Paste with the engine's snippet as the internal format and
`text/plain` / `text/html` on the system clipboard. Nothing vector crossed the clipboard: a copy
pasted into Illustrator, Figma or Inkscape brought nothing, and a copy made there pasted here as a
text frame full of SVG code — when Illustrator's clipboard reached the editor at all.

What Illustrator puts on the macOS pasteboard, asked of Illustrator 30.1 by the oracle
(`modules/draw/scripts/illustrator/run-clipboard-probe.sh`, recorded in
`apps/canvas/test/fixtures/clipboard/clipboard-copy.pasteboard.json`), for two filled paths:
`com.adobe.illustrator.aicb` (EPS), `public.svg-image`, `com.adobe.pdf`,
`com.adobe.illustrator.svg` / `.svgm`, `public.utf8-plain-text` (the same SVG source),
`public.png` and its private PGF.

What a browser can reach of that (`apps/canvas/scripts/clipboard-flavours.mjs`, Chromium 156 as
Playwright ships it, macOS 26, 2026-10-28):

| | Chromium (headed) | Chromium (headless) |
|---|---|---|
| `navigator.clipboard.read()` | `text/plain` (the SVG source), `image/svg+xml` (re-serialised and **sanitised**: `<style>` dropped, so every class-styled shape is black), `image/png` | an in-process clipboard, not the system's |
| a paste event's `clipboardData` | `text/plain`, `image/svg+xml` listed but `getData` empty, the PNG as a file | — |
| PDF (`com.adobe.pdf`) | never exposed | — |
| `ClipboardItem.supports` | `text/plain`, `text/html`, `image/png`, `image/svg+xml`; not `application/pdf` (only the `web application/pdf` custom format, which other applications do not read as PDF) | the same |
| a write of `image/svg+xml` | lands as `public.svg-image` | — |

Safari and Firefox write and read `text/plain`, `text/html` and `image/png` only.

## Decision

1. **Copy writes SVG.** Beside the snippet (internal) and the marked `text/html`, Copy asks the
   engine for the selection as one SVG document (`exportSvg` with the selected ids, on the first
   selected item's page; `paged-svg`, text as outlines, the view box fitted to what the items
   draw) and writes it as `image/svg+xml` where `ClipboardItem.supports` admits the type. A
   browser that names the type and still refuses the write gets `text/plain` and `text/html`
   alone. With no frame text to carry, the `text/plain` form is the SVG code, as Illustrator
   writes it, so a text paste elsewhere lands the drawing.
2. **No PDF.** No browser lets a page put PDF on the clipboard in a form another application
   reads as PDF; the plan's "and PDF" is recorded as not possible from a web page. (A desktop
   shell could add it later through its own clipboard.)
3. **Paste reads SVG.** The order: our own marked copy (ADR 231, unchanged); then plain text that
   IS an SVG document (an XML declaration, comments and a doctype may precede `<svg`, and it ends
   with `</svg>`) — Illustrator's own source, preferred because the browser's `image/svg+xml` is
   sanitised; then the `image/svg+xml` flavour; then text, as before. An SVG imports through the
   engine (`svgImportPlan`, `paged-svg`) as native page items in **one undo step**: Paste centres
   the drawing on the view (a first plan measures it), Paste in place puts the SVG's user space on
   the page's (origin 0,0, one user unit a point — Illustrator's convention). The import's group
   is selected; what it approximated or left out reaches the Problems list as warnings.
4. **The bundles' door carries SVG too** (extensions ADR 341): the editor's `ClipboardBackend`
   declares `svg`, writes `image/svg+xml` and reads the SVG back by the same order, and an SVG
   text is never parsed as a TSV grid.
5. **Illustrator interop is evidence, not assumption.** The oracle's recording is committed
   (the geometry Illustrator drew, the pasteboard's types and sizes, the SVG); the headless test
   pastes that SVG and compares each path with Illustrator's bounds and colour. The PDF and AICB
   flavours are recorded by type and size only: Illustrator embeds the account's user name in its
   private data.

## Consequences

- Copy costs one more engine round trip (the SVG export); a failure leaves the copy without SVG.
- The export of some items alone now leaves out the page's master items: the renderer's master
  pass drew items the filtered build had hidden (and every master item marked
  `Visible="false"`). Fixed in the engine (`paged-renderer` build, master pass), pinned by
  `svg_io::a_selection_exports_without_its_pages_master_items`.
- A paste of Illustrator's copy is the SVG Illustrator wrote: its live effects, symbols and
  appearance arrive as whatever its SVG export made of them. Opening an `.ai`/PDF as editable
  vectors is WP4.12's (engine and publish PDF import), and a pasted PDF would need a clipboard a
  browser does not offer.
- Paste in place of a foreign SVG has no page position to keep: Illustrator's SVG starts at its
  selection's corner, so it lands at the page's top-left.
