# ADR 1097 — One loss report

- **Status:** Accepted 2026-11-11.
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
- paged.slide's import and export diagnostics stay strings for now: about forty producers in
  `pptx-import`, `pptx-export` and `slide-resolve` write free sentences without a code, and an
  import report kept in a document holds them as strings, which an older report must still read.
  Moving them needs a code per producer and a reader that takes both.
- The IDML export's `lost` lines, `paged-ps`'s `Report.unsupported` and the web bundle's
  `WebDiagnostic` (a linter's finding with a line) are left as they are.

## Consequences

- One shape crosses every boundary; a consumer that reads one report reads all of them.
- `SvgReport.notes` is now `losses`, and `LossEntry.message` is optional in TypeScript (the
  wire's own rule). The editor and its worker ship as one build, and the contract's canary moved.
- A DXF or PSD loss whose message differs for the same code is now its own row (before, the
  first message stood for all of them).
