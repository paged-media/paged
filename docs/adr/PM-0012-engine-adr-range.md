# ADR PM-0012 — The engine's records continue at 1000–1099

- **Status:** Accepted 2026-10-22.
- **Scope:** the ADR numbering of this repository (`docs/adr/README.md`) and of `engine/core`
  (`engine/core/docs/adr/README.md`).

## Context

Every component numbers its decision records in a range of its own, and a number names the same
record wherever it is cited. The engine's range, 100–199, is full: its records continued at
200–209, which is the editor's range, so `ADR 205` now names two records, an engine record and
an editor one. The server's records (950–953) sit in a range this file never listed.

The engine is about to record several decisions at once: template policies, session roles,
permission checks and typed refusals (the editor's composable-editor plan, workstream C).

## Decision

- **New engine records use 1000–1099.** The first free number is 1000.
- **Records 200–209 of the engine keep their numbers.** Where the number alone is ambiguous,
  they are cited with their component: "core ADR 205", "editor ADR 205". No record is
  renumbered, because their numbers are already cited across the repository.
- **The server's records use 950–999**, as they already do.
- The range table gains both rows.

## Consequences

`engine/core/docs/adr/README.md` points new records at 1000–1099. A tool that resolves an ADR
number to a file has to take the component into account for 200–209, as a reader already must.
