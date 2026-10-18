# PM-0002 — Built-in modules share internal code; extensions see only the public contract

- **Status:** Accepted 2026-10-18.
- **Scope:** `modules/*`, `platform/shared/*`, `platform/extensions` (`plugin-api`, `plugin-sdk`),
  `apps/editor`.

## Context

The editor ships nine first-party modules: publish, image, draw, sheet, data, doc, slide, web
and pdf. They always ship together with the editor and are always built from the same
revision. In separate repositories each copied what it needed, so the same code exists several
times:
- the OOXML package layer, four times;
- Excel-style number, date and locale formatting;
- DrawingML charts and colours;
- base64, SHA-256 and unit conversions;
- the wasm boot guard;
- the test fakes.

Some copies have already drifted. Sheets' OPC reader enforces a zip-bomb budget, and the doc
and slide copies don't.

Third-party extensions are coming too. They build against the published contract only:
`@paged-media/plugin-api` (types) and `@paged-media/plugin-sdk` (runtime helpers and the test
harness). What one built-in shares with another must not become something an extension can
depend on, or every internal refactor turns into a contract change.

## Decision

- **Two audiences, two kinds of code:**
  - **Built-ins** (`modules/*`) and the editor (`apps/editor`) may use the public contract and
    internal shared code under `platform/shared/*`: Rust crates such as `ooxml`, `fmt` and
    `dml-chart`, and TS packages such as `wasm-boot`, `panel-kit` and `test-kit`.
  - **Extensions**, and everything published for them (`platform/extensions/*`), may use only
    the public contract. They never import `platform/shared/*` or a module's internals.
- **Shared code is extracted only among built-ins**, and only where a measured duplicate
  exists. Each extraction keeps the most protective behaviour of the copies it replaces: the
  zip-bomb budget becomes the default for every OOXML reader.
- **The boundary is enforced, not documented:** import rules in the linter (one root config)
  reject `platform/shared/*` and module-internal imports from community-facing packages, and
  every module's imports are checked in CI.
- **What community authors need goes into the public SDK on purpose:** the fake editor, map
  backings and the conformance host become part of the plugin-sdk harness. It's not a path
  into the internal test kit.

## Consequences

- A fix in shared code reaches every built-in in one change.
- The public contract changes only when `plugin-api` or `plugin-sdk` changes. Its version
  guard checks that.
- Merging the formula engines, the image codecs with the engine's decoders, and the doc and
  slide binaries is left for later. They are measured first.
