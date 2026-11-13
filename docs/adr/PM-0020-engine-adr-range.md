# ADR PM-0020 — The engine's records continue at 1300–1399

- **Status:** Accepted 2026-11-13.
- **Scope:** the ADR numbering of this repository (`docs/adr/README.md`) and of `engine/core`
  (`engine/core/docs/adr/README.md`).

## Context

Every component numbers its decision records in a range of its own, and a number names the same
record wherever it is cited. The engine's second range, 1000–1099 (PM-0012), has reached its end:
record 1099 was written on 2026-11-12. Some numbers inside it were never used (1009, 1012, 1023,
1024, 1028, 1029, 1049 and 1062–1089); nothing reserves them. The ranges after it belong to other
components: 1100–1199 to the extensions (PM-0016), 1200–1299 to the editor (PM-0019).

The editor's interaction programme (editor ADR 1200, `apps/editor/docs/interaction-plan.md`,
track EN) brings engine records for its protocol changes.

## Decision

- **New engine records use 1300–1399.** The first is 1300.
- **The unused numbers inside 1000–1099 stay unused.** A new record takes the next number of the
  new range, so a record's number keeps its place in the sequence, and a record drafted on one
  branch cannot collide with another slotted into the same gap.
- **Records 100–199, 200–209 and 1000–1099 keep their numbers.**
- No engine record takes a number in another component's range.
- The range table gains the row.

## Consequences

`engine/core/docs/adr/README.md` points new records at 1300–1399. An engine record in the new
range is cited as "engine ADR 1300" (or "core ADR 1300"), as before; the range alone says which
component it belongs to.
