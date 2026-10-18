# plugin-publish

Home of the foreign-format publishing bundles for [Paged](https://paged.media)
and the **`crates/pdf-import`** mapper (a reading-ordered PDF Document IR →
Paged `Document` → native `.paged` bytes).

The **IDML adapter** this repository was created for (ADR-022, Option A) is
now part of the engine workspace:

- **`engine/core/crates/idml-import`** — parses an IDML ZIP package into a
  Paged `Document` (the `import_idml*` orchestrator + the schema parsers).
- **`engine/core/crates/idml-export`** — re-serialises a `Document` back to a
  valid IDML package (carry-through save-back: verbatim untouched entries +
  streaming attribute patches).
- **`engine/core/crates/idml-coverage`** — the static inventory of what both
  read and write (`engine/core/docs/reference/idml-coverage.json`).

`pdf-import` depends on the Paged model crates (`paged-model`, `paged-scene`,
`paged-store`) and on `idml-import` by path into `engine/core/crates/`, so it
always builds against the engine at the same commit. The git revision pins
that used to tie this repository and the engine together (ADR 650) are gone.

## Documentation

Everything about how these plugins are designed and built is in [`docs/`](./docs/README.md):

- [`docs/concept.md`](./docs/concept.md): what this repository is for and what it will never do.
- [`docs/architecture.md`](./docs/architecture.md): the two bundles (IDML and PDF), their data paths, and how this repo and the engine depend on each other.
- [`docs/status.md`](./docs/status.md): what ships today and what does not.
- [`docs/adr/`](./docs/adr/README.md): the architecture decisions, one per file, including [ADR 022](./docs/adr/022-idml-relocates-to-plugin-publish.md).

`docs/status.md` is the current record of what ships.
