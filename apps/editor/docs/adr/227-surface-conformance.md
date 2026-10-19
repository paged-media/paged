# ADR 227 — Surface conformance: a surface counts as tested when a test asserts it under covers()

- **Status:** Accepted 2026-10-19.
- **Scope:** `scripts/surface-coverage.mjs`, `scripts/surface/`, `scripts/surface-acknowledged/`,
  `platform/shared/test-kit` (`covers()`), `platform/shared/test-resources` (`covers!`),
  `.github/workflows/editor-tests.yml` (job `surface`)

## Context

Until now, `scripts/surface-coverage.mjs` counted a panel, tool, keybinding or menu item as
covered when its id string appeared anywhere under `apps/canvas/tests/`. Its header said so
plainly: a weak proxy, chosen because a stricter rule would report false gaps everywhere.
That weak proxy was green at 491 of 491 ids. A spec that only lists the registry
(`plugin-surface/*.spec.ts`) mentions every id it lists and asserts the behaviour of none.

The gate also measured only part of the surface:

- **Commands**: only those behind a keybinding or a menu item.
- **Settings, the CLIs, the script functions**: not at all.
- **Plugin menu items and keybindings**: not at all, because they are runtime `contribute.*`
  calls rather than manifest fields.
- **Tests**: only Playwright specs. It could not see the unit, component, headless and Rust
  tests the conformance programme adds.

## Decision

1. **A test vouches for a surface id by calling `covers("<kind>:<id>")`** next to its
   assertions. The function is a typed no-op: `@paged-media/test-kit`, or a local no-op where
   the kit may not be imported. In Rust it is `covers!` or a `// covers:` line. The gate reads
   the calls statically, so the arguments are string literals. A call it cannot read is an
   error, not a zero.
2. **The layer is the file's**, derived from its path. A file has one tier (`unit`,
   `component`, `headless`, `e2e`, `rust`) and any tags (`golden`, `script`, `gesture`).
3. **Each kind requires clauses**, each satisfied by one asserting test in one of its layers:
   - command: unit, plus headless or e2e;
   - panel: component;
   - tool: a gesture-DSL unit test;
   - menu: e2e;
   - keybinding: any tier;
   - setting: unit;
   - cli: golden;
   - script: a script test;
   - importer / exporter: any tier.
4. **The surface is enumerated from its declarations**, statically, by a small evaluator. It
   follows tables, `.map` callbacks, loops, local helpers and imports. It covers the editor's
   own registrations, all nine bundles in the bundle table (slide included), the settings
   inventory and tool options, `cli.json` and the TS verb table, and the catalog plus the
   automation layer's declarations.
   - Ids derived per registered item are **families**, one id with a `*` (a show and a hide
     command per panel, an activation command per tool).
   - Fail-closed guards keep it honest: a floor per extractor, the bundle count pinned at
     nine, and every unresolved registration site either declared or failing.
5. **The ratchet runs both ways.** An uncovered (id, clause) must be acknowledged with a
   reason in a one-line-per-entry data file per origin, kind and clause. An acknowledged entry
   that is covered now fails the run; `--prune` removes it. Today's gaps were seeded on
   2026-10-19. Each reason says what no test asserts yet and where the id is only mentioned.
6. **"Mentioned" stays as a secondary column.** It still finds surface nothing has heard of,
   but it no longer passes anything. It remains a ratchet only for the plugin contribution
   types that have no `covers()` kind (edit contexts, object types, part types).
7. **The gate runs in its own CI job**, `surface`. It is static: no wasm, no browser, no
   secrets. The job uploads a JSON report (`schema: 1`) and writes markdown tables to the job
   summary.

## Evidence

- `scripts/surface-coverage.mjs`: `REQUIREMENTS`, the ratchet, `--prune`, the report
- `scripts/surface/enumerate.mjs`: the extractors, `FAMILY_OF_PATTERN`, `DYNAMIC_SITES`, the
  sentinels
- `scripts/surface/static-eval.mjs`: the evaluator
- `scripts/surface/covers-reader.mjs`: the forms and the layer rules
- `scripts/surface-coverage.test.mjs`: each reader pinned against a fixture it must read in full
- `platform/shared/test-kit/src/covers.ts`, `platform/shared/test-resources/src/lib.rs` (`covers!`)

## Alternatives considered

- **Keep "mentioned" and add depth through `@feat` levels.** Rejected. `@feat` maps a test to
  a capability row, and a row is satisfied by any one of several surfaces. It cannot say that
  the Scissors tool in the rail does anything.
- **Enumerate the surface at run time from the live registries.** This would be a browser or
  harness snapshot. Rejected as the gate's source: the Playwright lane needs a fixtures
  checkout that CI cannot always make, and a snapshot is only as fresh as its last run. The
  static enumeration runs everywhere in a minute. A runtime cross-check against it can be
  added in the bundle-contract lane.
- **One ACKNOWLEDGED map in the script.** Rejected. Six parallel efforts removing entries
  from one map collide on every merge; one line per entry, in files split by origin, kind and
  clause, merge cleanly.
- **Dynamic `covers(id)` for table-driven tests.** Rejected. A static reader cannot read it,
  and a gate that trusts what it cannot read is the fail-open it exists to prevent.

## Consequences

Most of the surface has to be re-earned. On 2026-10-19 the seeded list held 1,319 (id, clause)
gaps across 1,130 ids. The conformance programme removes entries as it covers them, and the
report records the numbers before and after.

A new command, panel, menu item, keybinding, setting, CLI command or script function arrives
either with a test that covers it or with an acknowledged entry and a reason. A renamed id
fails until its tests and entries follow the rename.

## Related

- [ADR 216](216-test-tiers.md): the tiers; amended 2026-10-19 by this record.
- [ADR 208](208-tools-are-data-plus-gesture-handler.md): the gesture DSL behind the tool clause.
- [ADR 226](226-contribution-types-have-one-definition.md): the contribution types a bundle
  declares.
- [`docs/reference/surface-conformance.md`](../reference/surface-conformance.md): the overview
  and the layer docs.
