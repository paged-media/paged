# ADR 124 — Opacity masks are a native construct; loss is reported on IDML export

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `9f933f1`.
- **Scope:** `crates/paged-model` (`Spread::opacity_masks`), the mask operations in
  `crates/paged-mutate` and `crates/paged-wire`, and the export-loss report in `crates/paged-canvas`

## Context

An opacity mask makes one page item's artwork drive the transparency of another: the coverage is
continuous, so a black-to-white gradient fades the masked item out. The two wire operations that
create and release one arrived with protocol 58 (commit `19dace2`, 2026-08-04).

IDML cannot express this. The comment on the model field states it: InDesign's transparency model
has per-object opacity, blend modes and feathering, but nothing that modulates one object's alpha
by another object's artwork, and no element or attribute carries such a relation. Inventing an
element "would produce a package InDesign rejects, so we don't"
(`crates/paged-model/src/lib.rs:5821-5826`).

## Decision

An opacity mask is a construct of the engine's own model, with no IDML form. It is kept in full in
the native container and dropped, with a report, on IDML export.

- **Model.** `Spread::opacity_masks` is a side map keyed by the masked item's id. Each entry names
  the item that supplies the mask artwork, a type (`Luminosity`, the default, or `Alpha`) and an
  `invert` flag. The mask item leaves the spread's paint order and stays in its backing vector.
- **Operations.** `applyOpacityMask` and `releaseOpacityMask` on the wire, each with an exact
  inverse, and `paged.applyOpacityMask` / `paged.releaseOpacityMask` for scripts. Both items must
  be a rectangle, oval, line or polygon on the same spread.
- **Rendering.** The renderer brackets mask artwork and masked content with three display-list
  markers ([ADR 101](101-display-list-single-intermediate.md)). The CPU rasteriser, the Vello backend
  and the PDF exporter each resolve them to a soft mask; in PDF a native one, not a raster.
- **`.paged`.** The map is part of the serialised model. `export_paged` writes a fresh model part
  (`paged/core/model/document.pgm`) on every save, so the relation is stored verbatim.
- **`.idml`.** The relation is not written and, per the model comment, the mask artwork exports as
  an ordinary item. `idml_export_losses` returns one line per masked item, naming both items and
  pointing at `.paged`; the `IdmlExported` reply carries the list to the host as `lost`, and the
  command line prints each line to standard error.

## Evidence

- `crates/paged-model/src/lib.rs:5811-5850`, `:5857-5879` — the map with its decision comment; the types
- `crates/paged-mutate/src/apply/opacity_mask.rs:19-31`, `:50-66`,
  `crates/paged-wire/src/lib.rs:1066-1092`, `crates/paged-script/src/lib.rs:2178-2181`, `:2213` — the
  operations, the item kinds allowed, the script functions
- `crates/paged-renderer/src/pipeline/build_engine.rs:2104-2189` — the bracket around artwork and item
- `crates/paged-gpu/src/cpu.rs:1721-1767`, `crates/paged-gpu/src/vello_rs.rs:70-81`,
  `crates/paged-export-pdf/src/page.rs:781-853` — the three consumers of the bracket
- `crates/paged-canvas/src/export_losses.rs:673-694`, `crates/paged-canvas/src/model.rs:4527-4528`
  — the loss line and where it enters the list
- `crates/paged-canvas/src/channel.rs:1794-1806`, `crates/paged-canvas-wasm/src/dispatch.rs:1067-1072`,
  `crates/paged-cli/src/export.rs:101-109` — the `lost` field, filled on export, printed by the CLI
- `crates/paged-canvas/src/model.rs:4666-4679`,
  `crates/paged-canvas/tests/it/opacity_mask_and_text_path_wire.rs:201-258` — the model part written
  on save; a test that the mask survives `.paged` and is reported lost for IDML

## Alternatives considered

Carrying the relation in the item's `Properties/Label` key-value pairs, which InDesign preserves:
rejected in the model comment. It would survive a trip through InDesign, but InDesign would
meanwhile draw the mask artwork as an opaque object on top of the design, and a document that
looks wrong while it round-trips "is worse than an honest loss"
(`crates/paged-model/src/lib.rs:5842-5848`). An invented IDML element: rejected, see Context.

## Consequences

Of the two document formats, only `.paged` keeps a mask. The engine reports the loss; showing it
to the user is left to the host (`crates/paged-canvas/src/channel.rs:1801-1803`). On load, a model
part of another format version is rejected and the document is imported from the IDML parts
(`crates/paged-canvas/src/model.rs:1539-1557`). The mask line is
declared from the model, while the rest of the loss list is measured by exporting and re-importing
(`crates/paged-canvas/src/export_losses.rs:19-38`). The IDML adapter never reads the map:
`opacity_masks` does not occur in `plugin-publish: crates/`.

Text frames can neither be masked nor serve as a mask, because their glyphs are emitted outside
the bracket (`crates/paged-mutate/src/apply/opacity_mask.rs:52-60`). An item that carries a mask
or serves as one cannot be removed until the mask is released
(`crates/paged-mutate/src/apply/remove_node.rs:48-66`).

Two comments are stale. `crates/paged-canvas/src/channel.rs:418-420` says the Vello backend
renders masked content unmasked; it renders masks since commit `d7a8611`. Lines 424-426 and
1795-1797 of the same file call opacity masks the only kind of entry in `lost`; since commit
`28f453b` the list also holds the measured losses.

## Related

- [ADR 101](101-display-list-single-intermediate.md) — bracket markers in the flat command stream
- [ADR 118](118-paged-file-is-a-valid-idml-package.md) — the container and the model part that keep the relation
- [ADR 119](119-pdf-export-backend.md) — the PDF backend that writes the soft mask
- [ADR 007](007-carry-through-rendering-honesty.md) — the wider rule that a lossy outcome is reported, never silent
