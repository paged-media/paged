# ADR 341 — The clipboard carries SVG

- **Status:** Accepted 2026-10-28.
- **Scope:** `packages/plugin-api/src/{clipboard,host,manifest}.ts`,
  `packages/plugin-sdk/src/{host-impl,harness}.ts`, DESIGN.md §14. Editor side: editor ADR 289
  (`apps/canvas/src/plugin-clipboard.ts`). Work package WP4.9 of the image/draw master plan; the
  `clipboard.svg@1` door of its §4.

## Context

The clipboard door (K-6 / S-14, DESIGN.md §14) carries `{ text?, tabular? }`. Its `"vector"`
tier was named for a vector plugin that "copies a textual/SVG representation", yet the only
place an SVG could travel was `text`, and the host wrote `text` as `text/plain`: an SVG there is
code to every other application, not a drawing. The platform's vector interchange is
`image/svg+xml` — what Illustrator, Figma and Inkscape put on and read off the clipboard, and
what Chromium's async clipboard takes and exposes (editor ADR 289 records what each browser
reaches).

## Decision

- **`ClipboardPayload.svg?: string`** — an SVG document as UTF-8 text. On write the host puts it
  on the system clipboard as `image/svg+xml` where the platform takes that type (and leaves it
  out where it does not); on read it is the clipboard's SVG: plain text that IS an SVG document
  first (the source as written — Chromium sanitises its `image/svg+xml` and drops `<style>`),
  then the `image/svg+xml` flavour.
- **Tiers:** `"vector"` grants `text` and `svg`; `"full"` grants `text`, `tabular` and `svg`;
  `"none"`/absent denies, as before. No manifest change.
- **`ClipboardBackend.svg?: boolean`** — the backend carries the half. Without it the door
  strips `svg` from a write and from a read.
- **`supports("clipboard.svg@1")`** — true when a backend is wired and carries `svg` (the editor's
  and the headless harness's `inMemoryClipboard` do).
- plugin-sdk and plugin-api `0.74.3-canary.34`.

## Consequences

- Additive: an optional payload field, an optional backend flag, a feature flag; every existing
  bundle and backend behaves as before (a backend without `svg` never sees the half).
- A bundle that copies vectors writes `{ text, svg }` and probes `clipboard.svg@1`; one that
  pastes vectors reads `svg` and imports it through `document.importSvg@1` (engine ADR 1031).
- PDF is not a payload half: no browser lets a page write PDF other applications read as PDF.
