# ADR 336 — Document style reads for bundles

- **Status:** Accepted 2026-10-23.
- **Scope:** `packages/plugin-api/src/host.ts` (`DocumentSurface.styleProperties`,
  `DocumentSurface.swatchDisplay`, `SwatchDisplay`), `packages/plugin-sdk/src/host-impl.ts`.

## Context

A bundle that draws content itself — the sheet's frame surface (ADR 334) paints its grid on a
main-thread canvas — must show the document's own styles: paragraph, character, cell and table
styles and swatches, including CMYK, spot and Lab colours. The contract already lists styles
(`document.collection`), but a list entry carries no resolved properties, and a swatch's display
colour depends on the document's colour management, which only the engine knows. Without these
reads a bundle can only guess, and its surface drifts from the page it lands on.

## Decision

Two read doors on `host.document`, both typed wrappers over queries the host's own style and
swatch panels already use:

- **`styleProperties(collection, styleId)`** returns a style's properties as the engine resolves
  them — its own entries plus what it inherits through `BasedOn` — or `null` for an unknown
  style. Probe `document.styleProperties@1`.
- **`swatchDisplay(swatchIds)`** returns, per known swatch, its display colour (`#rrggbb` after
  the document's colour management), its colour model, CMYK percentages where it has them, and
  the out-of-gamut verdict. Unknown ids are left out. A bundle re-reads after a `swatches`
  change (`document.onDidChange`). Probe `document.swatchDisplay@1`.

Both need document read access like every other read door, and neither throws: a channel
failure reads as `null` or as a missing entry.

## Consequences

- A bundle can draw text and fills exactly as the page shows them, and keep a swatch reference
  (an id) rather than a copied colour.
- Writing styles stays with the existing write paths (mutations; binding providers, §18).
- plugin-sdk and plugin-api move to the next canary together (the contract's one number).
