# ADR 1092 — `paged.barcode`: the barcode encoder is reachable from the engine, without a binding

- **Status:** Accepted 2026-11-08; built (leftover of W9).
- **Scope:** `paged-data-barcode` (its unused `paged-data-core` dependency removed), `paged-script`
  (`paged.barcode`), `paged-introspect` (catalog row, `catalog.json`), plugin-api's vendored catalog.
  Part of the capability layering of PM-0014 and PM-0017.

## Context

The encoders (EAN-13, UPC-A, Code-128, QR) lived in `paged-data-barcode`, already an engine crate since
PM-0014, but only paged.data's wasm called them, behind `lower_barcode(binding, box)`: a barcode needed a
binding, a data table and the data module. A document or a deck, whose modules have no data wasm of their own,
could not draw one from a typed string.

## Decision

The crate stays a pure, dependency-free leaf (`serde`, `thiserror`; the `paged-data-core` dependency it listed
was never used and is gone). The canvas wasm reaches it through the script surface it already has:
`paged.barcode(symbology, data, quietZone?)` answers `{geometry}` (the unit-box rectangles, the module grid and
the human-readable text) or `{error}` (an unknown symbology or data the symbology refuses). It is a pure read:
it neither touches the document nor needs one. A host draws the rectangles itself, so the host decides the
page, the size and the grouping; the engine owns only what is hard, the encoding.

A script function rather than a wire request: no protocol bump, and every surface that runs scripts (the
editor's host, the CLI, plugins through the REPL door) gets it. The cost is one catalog row, which moves the
contract canary.

## Consequences

- The data module is unchanged: its bound barcode keeps `lower_barcode`, which lowers a record's value into a
  frame's box and stamps the binding envelope.
- Size: the encoders are about 2000 lines of table-driven integer code and no new dependency; core / ci's
  wasm-size gate and the canvas wasm's own budget are the check. Not measured locally.
- The editor's `paged.insert.barcode` (editor ADR 314) is the first caller.
