# ADR 198 — A link that resolves to nothing is missing, however it was placed

- **Status:** Accepted 2026-10-20.
- **Scope:** `report_image_resolution` (`crates/paged-renderer/src/pipeline/images.rs`), and
  through it `CanvasModel::links` (`LinkSummary.status`).

## Context

A picture placed through the authoring doors (`Operation::PlaceImage`, the script's
`paged.placeImage`) sets only the frame's link. By design it does not mark the frame as
holding a parsed `<Image>` (`has_image_element`). The build recorded a missing image only for
a frame that held one, so a placed link that never resolved read "ok" in the Links panel and
in `paged.links()` while the frame drew nothing (finding SCR-14, root R18: a failure answered
as a success). InDesign's Links panel marks any link whose file it cannot find as missing.

## Decision

A frame that names a link is an image frame for the missing-image report, whether or not it
nests a parsed `<Image>`. A link that resolves to nothing fires `ImageLinkMissing`, so its
status reads "missing", as an imported link to a missing file does.

What is drawn does not change: the grey missing-image placeholder stays reserved for a frame
that nests an `<Image>` (the IDML case), so a placed-but-missing link draws the frame's own
fill as before.

## Consequences

- SCR-14 closes (`pipeline::tests::placed_link_without_image_element_reports_missing`, and
  `apps/editor/apps/canvas/tests/headless/script-findings.test.ts`).
- The diagnostics of a document whose frames carry a link and no `<Image>` gain one
  `ImageLinkMissing` per unresolvable link.
