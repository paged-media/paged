# ADR PM-0016 — The extensions' records continue at 1100–1199

- **Status:** Accepted 2026-10-30.
- **Scope:** the ADR numbering of this repository (`docs/adr/README.md`) and of
  `platform/extensions` (`platform/extensions/docs/adr/README.md`).

## Context

Every component numbers its decision records in a range of its own, and a number names the same
record wherever it is cited. The extensions' range, 300–349, is full: every number from 300 to 349
names a record. The next record, the ML doors (`ml.<capability>@1`), had been drafted as 345, a
number another extensions record already holds. The numbers after 349 belong to the built-in
modules (350–749), and PM-0012 records what citing one number for two records costs.

## Decision

- **New extensions records use 1100–1199.** The first is 1100, the ML doors.
- **Records 300–349 keep their numbers.** No record is renumbered, because their numbers are
  already cited across the repository and in the published SDK's comments.
- No extensions record takes a number in another component's range.
- The range table gains the row.

## Consequences

`platform/extensions/docs/adr/README.md` points new records at 1100–1199. An extensions record is
cited as "extensions ADR 1100" as before; the range alone says which component it belongs to.
