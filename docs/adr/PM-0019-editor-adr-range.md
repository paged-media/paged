# ADR PM-0019 — The editor's records continue at 1200–1299

- **Status:** Accepted 2026-11-13.
- **Scope:** the ADR numbering of this repository (`docs/adr/README.md`) and of `apps/editor`
  (`apps/editor/docs/adr/README.md`).

## Context

Every component numbers its decision records in a range of its own, and a number names the same
record wherever it is cited. The editor's range, 200–299, is full: its last record there, 299,
was written on 2026-10-24. Its records then continued in the extensions' range, 300–349: 303 on
2026-10-25, then 300, 301 and 304–315, the last on 2026-11-11 (302 is not used). The extensions
hold every number from 300 to 349 themselves, so `ADR 300`, `ADR 301` and each number from 303
to 315 now name two records, an editor record and an extensions record. It is the collision
PM-0012 recorded for the engine's 200–209, fifteen numbers wide. The editor's own documentation
cites extensions records 301, 304, 308, 310 and 312 (`apps/editor/docs/README.md`) and has
records of its own under the same numbers.

The editor is about to record a programme of decisions: the adoption of the interaction
specification and its open decisions (editor ADRs 1200 and 1201), then one record per task as it
lands (`apps/editor/docs/interaction-plan.md`).

## Decision

- **New editor records use 1200–1299.** The first is 1200.
- **Records 200–299 and 300–315 keep their numbers.** No record is renumbered, because their
  numbers are already cited across the repository, in source comments and in the published
  documentation. The directory tells the two records of one number apart
  (`apps/editor/docs/adr/` against `platform/extensions/docs/adr/`); where the number alone is
  ambiguous, a record is cited with its component: "editor ADR 304", "extensions ADR 304".
- **No editor record takes another number in 300–349**, nor one in any other component's range.
- The range table gains the row, and records the overflow beside it.

## Consequences

`apps/editor/docs/adr/README.md` points new records at 1200–1299. For 300, 301 and 303–315 a
citation without its component is ambiguous, as it is for 200–209 (PM-0012), and a tool that
resolves an ADR number to a file has to take the directory into account for them. The
extensions' new records stay in 1100–1199 (PM-0016) and are not affected.
