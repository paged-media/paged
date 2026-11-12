# ADR 1097 — One loss report

- **Status:** Accepted 2026-11-11.
- **Amended:** 2026-11-12 (paged.slide, `paged-ps`).
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
- The IDML export's `lost` lines ride the wire (`IdmlExported.lost: string[]`, protocol v58) and the
  host shows them as they are; moving them onto `LossEntry` changes that reply, so it needs a protocol
  rider of its own. Their one producer today is the opacity mask.
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
   | look     | `pptx.effect.unsupported` (dropped); `pptx.paint.resolved`, `pptx.effect.resolved`, `pptx.paint.native` (dropped when the sentence says "not carried" / "not drawn", else approximated); `pptx.table.styleUnknown` (approximated) |
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
