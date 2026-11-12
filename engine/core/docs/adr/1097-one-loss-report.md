# ADR 1097 — One loss report

- **Status:** Accepted 2026-11-11.
- **Amended:** 2026-11-12 (paged.slide, `paged-ps`); 2026-11-12 (the IDML export, the DrawingML
  mapper).
- **Scope:** the leaf crate `paged-loss`; `paged-model` (`report` re-exports it); the adapters
  `paged-svg`, `draw-dxf`, `pdf-import` (place as vectors), `paged-psd-fx`, `docx-lower`,
  `paged-pdf-annots`, `paged-export-pdf`, `web-render`; the extension contract
  (`LossEntry`, `LossSeverity`, `LossReport` in `@paged-media/plugin-api`) and the SDK's
  `lossDiagnostics`.

## Context

Every importer, exporter and mapper reports what it could not carry. Before this record there were
ten shapes for that one answer: `paged-svg`'s `SvgNote`, a copy of it in `draw-dxf` (and a third, in
TypeScript, in the draw bundle), `pdf-import`'s `Loss { code, count }`, `paged-psd-fx`'s
`StyleLoss { effect, what }`, `docx-lower`'s `Diagnostic { severity, message, tier }` with its
TypeScript twin, `paged-export-pdf`'s findings, `web-render`'s counters, and the shared
`LossEntry` of `paged_model::report`, which only `paged-pdf-annots` and the PDF bundle used.
`paged-model` is a large crate, so a format crate that sits below it (the DOCX lowering, the DXF
reader) could not take the shared shape.

## Decision

1. **The leaf crate `paged-loss` owns the shape.** It depends on `serde` only (and, behind its
   `wire` feature, on `tsify-next` for the wire's TypeScript).
   - `LossEntry { code, count, severity, pages, message }`. `code` is the producer's own
     vocabulary, kept as data: an SVG construct (`filter`), a DXF entity (`entity.TEXT`), a PDF
     mapper code (`shading.sampled`), a Photoshop effect (`Drop Shadow`), an annotation type
     (`Link`). The empty `pages` and `message` stay off the wire.
   - `LossSeverity`: `info` (worth knowing, nothing visible changed), `approximated` (carried
     with a visible difference), `dropped` (left out; the default).
   - `LossReport { losses }` and the trait `LossLog`, the one counting rule: one entry per code
     and message, in the order each first happened. A report that carries more than its losses
     (an SVG import's item count) holds a `Vec<LossEntry>` and counts through `LossLog`.
   - `paged_model::report` re-exports it, so the model's callers did not move.
2. **Each adapter maps onto it; its differences stay in its codes.**
   - `paged-svg`: `SvgNote` and `SvgNoteSeverity` are aliases of `LossEntry` and `LossSeverity`;
     `SvgReport { items, losses }` (was `notes`). This is on the wire (protocol v78 rider), so the
     contract's `LossEntry` and `LossSeverity` are now generated from `paged-loss` (`wire.d.ts`)
     instead of written by hand; `SvgNote` / `SvgNoteSeverity` stay as aliases there.
   - `draw-dxf`: `Report { items, losses }`, the same rows as an SVG report.
   - `pdf-import`: `Loss` is `LossEntry` (counted, worded by the bundle).
   - `paged-psd-fx`: `StyleLoss` is `LossEntry`, the effect its code and what is lost its message.
   - `docx-lower`: `Diagnostic` is `LossEntry`. Word gives no code, so the code is the fidelity
     tier (`docx.tier0` … `docx.tier4`); a construct that is not shown is `dropped`, one drawn
     differently `approximated`, a note `info`.
   - `paged-export-pdf`: `ExportDiagnostic::loss` and `loss_report` (its findings keep their
     codes); `web-render`: `LowerReport::losses` (`paint.nonSolid`, `shadow`).
3. **One translation onto the host's diagnostics channel**: the SDK's `lossDiagnostics` (and
   `lossDiagnosticSeverity`, `lossRank`). `info` stays info; `approximated` and `dropped` are
   warnings. paged.doc's outline panel and its diagnostics use it.
4. **The ratchet holds it.** The single-owner rule `loss-report` fails on a new severity enum with
   an `Approximated` variant, a TypeScript `"approximated" | "dropped"` union, or a `…Loss`
   struct outside the owner.

## Not mapped, with reasons

- `paged-data-store`'s `Diagnostic { kind, message, offset }` is a failed SQL statement with the
  byte offset the query panel points at, not a conversion loss.
- (Deferred here, done in the amendment "The IDML export and the DrawingML mapper" below: the IDML
  export's `lost` lines, a wire field of their own.)
- The web bundle's `WebDiagnostic` is a linter's finding with a line in the source, not something a
  conversion could not carry.
- image-js `LosslessShape` classifies a layer for save-back; it reports nothing lost.

## Amendment 2026-11-12: paged.slide and paged-ps

paged.slide's import and export diagnostics and `paged-ps`'s `Report.unsupported` are loss entries now.

1. **paged.slide.** `pptx_core::loss` re-exports the shape. Every producer names its own code,
   `pptx.<area>.<what>`, and a severity; the sentence stays the message and names the part or slide.
   `LossLog` does the counting that `summarise` (`line (×n)`) did. The import's
   `Presentation::diagnostics`, the resolved deck's, the native writer's `Built`/`Written`, the
   embedded faces', the live charts' and the export's `Exported { diagnostics, not_exported }` are all
   `Vec<LossEntry>`.

   | Area     | Codes (severity)                                                                                    |
   | -------- | --------------------------------------------------------------------------------------------------- |
   | parts    | `pptx.part.{tableStyles,master,theme,slide,chart,diagram,layout}`, `pptx.rel.{master,slide}` (dropped) |
   | shapes   | `pptx.shape.unknown`, `pptx.shape.notDrawn`, `pptx.frame.unknown`, `pptx.frame.notDrawn`, `pptx.smartart.noDrawing` (dropped) |
   | look     | `pptx.effect.unsupported` (dropped); `pptx.paint.resolved`, `pptx.effect.resolved`, `pptx.paint.native` (since the amendment below: the mapper's own `dml.*` codes) (dropped when the sentence says "not carried" / "not drawn", else approximated); `pptx.table.styleUnknown` (approximated) |
   | pictures | `pptx.picture.{noImage,missing,format,empty}`, `pptx.media.{noMedium,missing}`, `pptx.link.target` (dropped) |
   | charts   | `pptx.chart.sheetLayout`, `pptx.chart.notLive` (approximated), `pptx.chart.missing` (dropped)        |
   | comments | `pptx.comments.{authors,unreadable}` (dropped)                                                       |
   | fonts    | `pptx.font.embedded` (approximated: drawn in a substitute)                                          |
   | export   | `pptx.export.{document,editorSlide,foreignSlide,contentEdits,slide,notes,timing,mediaTiming,chart,chartData,theme,unreadablePart,masterDelete,layoutDelete,masterShapes,placeholderStyle,shape,smartartText,properties,link,pictureFrame,media,tableGrid,copy,group}` (dropped); `pptx.export.{text,mediaPlay,deadLinks}` and `pptx.export.media` for a medium written as a picture (approximated); `pptx.export.picture` (as `look`) |

2. **Older reports read.** A document keeps its import report as a container part
   (`import/report.json`); one written before the codes holds sentences. `pptx_core::loss::read_losses`
   (serde) and the bundle's `readLosses` read either form: a sentence becomes a `pptx.legacy` entry,
   dropped, its `(×n)` suffix the count. The bundle puts the losses on the diagnostics channel through
   `lossDiagnostics`; its typed `importPptx` / `exportPptx` results stay one line each, worded the same
   way. slide-js is the bundle's own wasm, so nothing of this is on the engine's wire.
3. **`paged-ps`.** `Report.unsupported` is `Vec<LossEntry>`: `eps.<area>.<what>` (a shading or image
   type, a filter, a Type 0 or Type 3 font, a pattern stroke or mask drawn grey, CIE colour drawn
   approximately), counted once per code and message.
4. **Ratchet.** The `loss-report` rule also fails on a new `losses` / `lost` / `unsupported` /
   `not_exported` field of `Vec<String>`; its baseline holds the DrawingML mapper's sentences in doc,
   sheet and web, which go with `dml-native`'s `take_losses`.

## Consequences

- One shape crosses every boundary; a consumer that reads one report reads all of them.
- `SvgReport.notes` is now `losses`, and `LossEntry.message` is optional in TypeScript (the
  wire's own rule). The editor and its worker ship as one build, and the contract's canary moved.
- A DXF or PSD loss whose message differs for the same code is now its own row (before, the
  first message stood for all of them).

## Amendment 2026-11-12: the IDML export and the DrawingML mapper

The IDML export's `lost` lines and the DrawingML mapper's sentences are loss entries now; the
`loss-report` ratchet's baseline is empty.

1. **`LossEntry.items`.** An entry may name the items it stood on, in the producer's own reference (a
   page item's or story's id, a section, a swatch): `items`, optional, merged like `pages` when
   `LossLog` counts two entries into one; `LossEntry::on(id)` adds one. Additive in Rust and on the
   wire (`items?: string[]`).
2. **The IDML export (protocol v78 rider).** `CanvasModel::idml_export_losses` and the reply's
   `IdmlExported.lost` are `LossEntry[]` (were `string[]`). Every producer names an
   `idml.<area>.<what>` code, a severity and the item; the sentence is the message, unchanged (the
   opacity-mask sentence the harness matches on included). A pre-rider worker's sentences still read:
   each becomes an `idml.legacy` entry, dropped. Severity follows the rule of decision 2: `dropped`
   when InDesign gets nothing of it, `approximated` when it is written differently or kept only in a
   label InDesign does not draw, `info` when what InDesign shows is the same.

   | Producer | Codes (severity) |
   | --- | --- |
   | declared from the model (`export_losses`) | `idml.mask.opacity`, `idml.vectorEffect.unwritten`, `idml.imageAdjustment.anchored` (dropped); `idml.fillRule.evenOdd`, `idml.lineEnd.office`, `idml.effect.unsupported`, `idml.effect.order`, `idml.vectorEffect.baked`, `idml.imageAdjustment.label`, `idml.media.poster`, `idml.blendMode.photoshop` (approximated); `idml.liveShape.pie` (info) |
   | appearances (`paged_model::appearance::interchange`) | `idml.appearance.baked` (approximated) |
   | paint (`paint_v2_export`, `mesh_fill_export`, `pattern_export`) | `idml.gradient.opacityStops`, `idml.gradient.strokeOpacityStops`, `idml.meshFill.lost`, `idml.pattern.lost`, `idml.pattern.unused` (dropped); `idml.gradient.conic`, `idml.gradient.stopColor`, `idml.gradient.strokeMode`, `idml.meshFill.label`, `idml.pattern.label` (approximated) |
   | comments (`comment_export`) | `idml.comment.unanchored`, `idml.comment.textGone` (dropped); `idml.comment.replies`, `idml.comment.resolved` (approximated) |
   | symbols, theme (`paged-mutate`) | `idml.symbol.missing`, `idml.symbol.empty`, `idml.theme.sourceTooLarge`, `idml.theme.unlinkedSwatch` (dropped); `idml.symbol.expanded` (info, approximated with a tint or 9-slice); `idml.theme.flattened` (info) |
   | the measured diff (`export_losses::diff`) | `idml.section.missing`, `idml.spread.missing`, `idml.guide.missing`, `idml.hyperlink.{missing,destinationMissing,sourceMissing}`, `idml.condition.missing`, `idml.conditionSet.missing`, `idml.story.{unplaced,missing}`, `idml.table.missing`, `idml.pageItem.missing`, `idml.image.bytes`, `idml.image.link`, `idml.group.missing` (dropped); `idml.page.canvasPlacement`, `idml.section.stale`, `idml.guide.stale`, `idml.hyperlink.stale`, `idml.condition.stale`, `idml.story.text`, `idml.table.shape`, `idml.table.cellText`, `idml.image.bytesLinked` (approximated) |
   | the measurement itself | `idml.export.failed`, `idml.export.unreadable` (dropped) |

   Consumers: paged.publish's `exportIdml` command puts each entry on its diagnostics with the entry's
   own code (was one `idml.lost` code for all), a warning or, for `info`, info (`lossDiagnostics`);
   the SDK harness's `exportDocument` returns `lost?: LossEntry[]`; the `paged` CLI's `export`, `save`
   and `package` JSON carry the entries and its text report prints their sentences; the Rust CLI
   prints the sentences and writes the entries into `package`'s report.
3. **The DrawingML mapper.** `dml-native`'s `Mapper` and `Lowering` keep `LossEntry`s (`lose(code,
   severity, message)`, counted through `LossLog`; a repeat is counted where it was dropped before),
   `dml.<area>.<what>`, the sentence unchanged as the message. With them doc's lowered picture look
   (`docx-lower`, whose tally per sentence reads as before), sheet's chart geometry, picture and shape
   looks (`sheet-chart`, `sheet-js`; sheet's own `xlsx.chart.patternLine`, `xlsx.shape.lineEnd`,
   `xlsx.shape.text`) and web-render's effect groups (the key is the code: `mixBlendMode.*`,
   `backgroundBlendMode`, `clipPath.url`, `clipPath.unsupported`, `mask.unpainted`, unworded) are
   entries, in Rust and in their TypeScript lowering types. paged.slide's deck diagnostics carry the
   mapper's `dml.*` codes as they are, instead of wrapping its sentences as `pptx.paint.native`.

   | Area | Codes (severity) |
   | --- | --- |
   | paint | `dml.pattern.mix`, `dml.pattern.tiles`, `dml.overlay.pattern`, `dml.fillRule.evenOdd`, `dml.gradient.tile`, `dml.gradient.path`, `dml.resolve` (approximated); `dml.fill.picture`, `dml.overlay.gradient`, `dml.overlay.picture` (dropped) |
   | lines | `dml.line.triple`, `dml.line.gradient`, `dml.line.translucent` (approximated) |
   | effects | `dml.shadow.preset`, `dml.blur.grow` (approximated); `dml.shadow.distorted`, `dml.shadow.presetBeside`, `dml.reflection.distorted`, `dml.3d.camera`, `dml.3d.bevelBottom`, `dml.3d.contour`, `dml.effect.unread` (dropped) |
   | pictures | `dml.picture.blurWide` (approximated); `dml.picture.clrReplAlpha`, `dml.picture.blur`, `dml.picture.tint`, `dml.picture.effect`, `dml.picture.adjustment` (dropped) |

   The save direction (`dml_native::picture::effects_of`, an engine filter stack written back as
   DrawingML) still answers sentences; paged.slide's export wraps them as `pptx.export.picture`.
4. **Ratchet.** The `loss-report` baseline is empty: no `losses` / `lost` / `unsupported` /
   `not_exported` field of `Vec<String>` is left.

