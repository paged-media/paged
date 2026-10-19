# ADR 607 — The OOXML foundation is one shared crate, and every package read has a memory budget

- **Status:** Accepted 2026-10-19.
- **Scope:** `platform/shared/ooxml` (the crate `paged-ooxml`), and the package readers of
  modules/doc, modules/slide and modules/sheet. Supersedes slide ADR 701.

## Context

Three modules read OOXML packages, and each had its own copy of the same layer:

- doc had `paged-ooxml`: the OPC container, the `_rels` graph, content types and the typed
  DOM over `ooxmlsdk` (ADR 601).
- slide carried a byte-identical copy in `vendor/paged-ooxml`, with a stamp file and a drift
  check (`scripts/sync-ooxml.sh --check`, slide ADR 701). The copy existed because the two
  were separate repositories; since the monorepo it was only cost.
- sheet had its own container, `.rels` parser, content-type table, byte-splice editor and XML
  helpers in `sheet-xlsx`, and the only reader with a memory budget. Fuzzing had found
  2.6 KB inputs whose headers asked for 3.4 GB; sheet stopped trusting declared sizes and
  held every read to 1 GiB.

doc and slide did neither. `OpcPackage::read` pre-allocated each entry at the size its
header claimed and inflated without a limit, so a 208-byte file could ask for a 4 GiB
allocation and a 1.1 MB file could inflate to 1.07 GiB. In the editor that ends the module's
wasm instance.

The DrawingML colour arithmetic was also written twice: sheet's SpreadsheetML `tint` and
slide's colour transforms each had an `rgb_to_hsl` and an `hsl_to_rgb`.

## Decision

One crate, `paged-ooxml`, in `platform/shared/ooxml` (internal to the built-ins, PM-0002). It
is a Cargo workspace of its own, as `platform/shared/test-resources` is, and doc, slide and
sheet take it as a path dependency (PM-0005).

- **One package read, with sheet's budget.** `read_zip(bytes, budget)` reads every entry:
  - a package whose entries declare more than the budget is refused before anything is
    inflated;
  - the size an entry claims is a pre-allocation hint only, capped at 8 MiB and at what the
    compressed bytes could hold;
  - each entry is read through the part of the budget still unspent, so a bomb whose headers
    understate it stops there.

  `OpcPackage::read` (doc, slide) and sheet's `OpcContainer::read` both go through it, at
  `MAX_UNCOMPRESSED_BYTES` (1 GiB). A refused package is `OoxmlError::Budget`, which sheet
  reports as its `XlsxError::Budget`, as before.
- **One sniff for the legacy containers** (CFB/OLE, RTF, WinWord 2.0). Each reader names its
  own format: doc and slide return `LegacyBinaryDoc` / `RichTextFormat`, sheet `LegacyBinaryXls`.
- **One relationship parser, two modes.** `Relationships::parse` is doc's and slide's tolerant
  scan; `Relationships::try_parse` is sheet's strict one, which fails on malformed XML and
  drops a row without `Id`, `Type` or `Target`. Both keep the behaviour they had.
- **One content-type table, one byte splicer, one set of XML helpers** (`xml`): attribute
  readers (`attr` unescapes and normalises, `attr_raw` keeps the bytes as written), entity
  resolution, the text and attribute escapes, `local_name`. The helpers report quick-xml's own
  error types (`XmlError`), so sheet's errors keep their variants and messages.
- **DrawingML colour** (`colour`): HSL conversion, SpreadsheetML's `tint` (`excel_tint`, which
  moves HSL luminance), and DrawingML's `a:tint` / `a:shade` (`dml_tint`, `dml_shade`, which
  work in linear light). The two tints stay separate functions; they are different operations.
- **The typed DOM is a feature** (`dom`). Only doc enables it. slide and sheet never compile
  `ooxmlsdk`, so slide's graph loses `ooxmlsdk` and the zip 8 it pulled in.
- **The consumer picks zip's deflate backend.** The crate depends on zip without one and
  forwards `deflate` (doc, slide) or `deflate-flate2` (sheet), because the backend changes the
  bytes a save writes.
- **Each writer keeps its own zip options.** doc and slide write through `OpcPackage::write`,
  sheet through its own writer (level 6, mode 0644). Their container bytes are asserted by
  tests, and merging the two would change one of them.
- Pins: `ooxmlsdk` 0.12 and `quick-xml` 0.41, as `docs/migration/rust-majors.md` records.

## Evidence

- `platform/shared/ooxml/src/opc.rs` — `read_zip`, `MAX_UNCOMPRESSED_BYTES`, `sniff_legacy`,
  `OpcPackage::read_with_budget`
- `modules/doc/docx-conformance/tests/zip_budget.rs`, `modules/slide/slide-js/tests/zip_budget.rs`
  — a 1,100-entry bomb (1.07 GiB declared) and a streamed entry that claims 4 GiB, fed to
  every entry point of each importer: refused or read, with no allocation over 64 MiB. Against
  the old reader the same tests fail (the 208-byte file made a 4 GiB allocation; the bomb
  inflated in full).
- `modules/sheet/sheet-xlsx/src/opc.rs` — `OpcContainer::read_with_budget` over `read_zip`
- `platform/shared/ooxml/src/rels.rs` — `parse` and `try_parse` over one scanner
- `platform/shared/ooxml/src/colour.rs`; `modules/sheet/sheet-xlsx/src/parts/theme.rs`
  (`apply_tint`) and `modules/slide/slide-resolve/src/color.rs` (the transform chain)
- `platform/shared/ooxml/src/testing.rs` (feature `testing`, dev-dependencies only) — the
  bombs and the peak-allocation counter the three modules' tests share

## Consequences

- A fix to the container lands once and reaches all three modules; there is no copy to sync,
  and the drift check is gone.
- Every OOXML package the editor opens is held to the same budget. A real package larger
  than 1 GiB uncompressed cannot be opened; a wasm32 host could not hold it anyway.
- A change to the crate rebuilds and retests doc, slide and sheet: their Moon projects list
  its sources, and their CI lanes run on its path.
- The crate is internal. A community extension cannot depend on it; publishing it would be a
  separate decision.
