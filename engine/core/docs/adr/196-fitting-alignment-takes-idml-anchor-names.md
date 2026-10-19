# ADR 196 — Fitting alignment takes IDML's anchor point names

- **Status:** Accepted 2026-10-19.
- **Scope:** `crates/paged-model/src/fitting.rs` (`fitting_anchor_name`,
  `reference_point_fraction`), the `FrameFittingReferencePoint` setter in
  `crates/paged-mutate/src/apply/set_property.rs`, the catalog row in
  `crates/paged-introspect/src/catalog.rs`.

## Context

`<FrameFittingOption FittingAlignment="…">` takes IDML's `AnchorPoint` enumeration, and
InDesign writes `TopLeftAnchor` … `BottomRightAnchor`. The fitting code read the
`AnchorPoint`-less `…Point` names of `AutoSizingReferencePoint` instead, so every value
InDesign writes fell through to the centre: a picture the engine fits (Place with a fit,
`paged place`, the export of a computed fit) was aligned to the centre whatever the frame
said. The catalog listed the `…Point` names, the Frame Fitting panel wrote them, and the
panel's left and right middle cells (`CenterLeftPoint`, `CenterRightPoint`) matched no arm
at all. The anchored object's point had the same spelling bug (PN-212, `b5b440df5`).

## Decision

1. **The canonical names are IDML's.** `fitting_anchor_name` maps a fitting alignment in
   either spelling, `…Anchor` or the older `…Point` (both centre-edge orders), to the
   `AnchorPoint` name; `reference_point_fraction` reads through it. An unknown value is the
   centre, as before.
2. **The setter stores the anchor name.** A write of `CenterPoint` is stored as
   `CenterAnchor`, so the IDML the engine writes says what InDesign reads. A value that names
   no point is kept as given (the row is an open enum).
3. **The catalog lists the anchors** and reads an unset alignment as `CenterAnchor`, which is
   what the renderer does with it.

## Consequences

- A non-centre fitting alignment pins the content where it says. Rendering of imported
  documents does not change: InDesign writes the placed image's own transform, which the
  renderer uses before any computed fit. Measured on the four corpus packs whose spreads
  carry a non-centre `FittingAlignment` and have an InDesign reference (88 pages): 0 pages
  changed, mean ΔE unchanged; the generated fidelity fixtures carry no `FittingAlignment`.
- A clearing write leaves no empty `<FrameFittingOption>` behind (ADR 197).
