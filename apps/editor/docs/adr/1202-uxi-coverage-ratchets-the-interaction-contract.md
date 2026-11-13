# ADR 1202 — An inventory mirrors the interaction contract, and a coverage report ratchets its acceptance tests

- **Status:** Accepted 2026-11-13.
- **Scope:** `scripts/interaction-inventory.json` and its schema and guard
  (`interaction-inventory.schema.json`, `interaction-inventory.mjs`), `scripts/uxi-coverage.mjs`,
  `scripts/uxi-acknowledged.json`, the shared readers in `scripts/surface/covers-reader.mjs`,
  `.github/workflows/editor-tests.yml` (job `surface`), `moon.yml`
  (`editor:interaction-contract`). Plan tasks W0.4 and W0.5
  ([`interaction-plan.md`](../interaction-plan.md)); builds on ADR 227 (surface conformance),
  ADR 228 (quarantine) and ADR 1200 (the contract, its exception ledger and its gates). The first
  record of this repository's range 1200–1299 after the adoption
  ([PM-0019](../../../../docs/adr/PM-0019-editor-adr-range.md)).

## Context

ADR 1200 adopted the interaction specification as the editor's target: 290 requirements
`UXI-<DOMAIN>-###`, 76 acceptance tests `UXI-T01`…`T76`, gates G0–G4, one exception ledger and no
gate passed on a screenshot alone. The spec asks for two companions (§26): a machine-readable
inventory of the editor's interactions, and a CI report of which scenarios have tests. Without
them the programme has no measure. A scenario would count as done because a plan said so, and
an exception would live in a comment.

The surface gate (ADR 227) already reads every test file statically and attributes each to its
layer by path. Its ids are surface ids, though, and the spec says plainly (§1.4, §23.3) that
`covers()` must not take contract ids.

## Decision

- **One inventory, synced from the spec.** `interaction-inventory.json` holds the spec's
  requirements, its tests (group, steps, assertion), the owner and phase names of §3.2, the
  groups, fixtures, gates and layers. A `--sync` writes these from the spec and never by hand;
  the guard fails when they differ. Curated beside them: each test's gates, fixture, expected
  layers and the requirements it proves; the interactions; the exceptions; `enforcedGates`.
- **The interactions are recorded as they are.** Each gesture, tool, context and key the editor
  answers has an owner of §3.2, the event class and scope it claims, the adapter that will route
  it (§24.2), the file that answers it today, its states, its permission and cancel behaviour,
  its real surface ids and its status. The seed records today's 60 as `legacy`, each with the
  owner it maps to.
- **The guard checks** the schema, the sync, that every id resolves (requirements, tests,
  owners, phases, gates, fixtures, layers, interactions, enumerated surface ids, source files,
  plan tasks), that no exception has expired, and `UXI-MIG-002`: two owners of one event class
  in one scope fail unless an unexpired exception that names `UXI-MIG-002` lists one of them.
  Floors and a mentioned-equals-defined check on the spec keep a parser that stops matching
  from passing.
- **The exception ledger is the inventory's `exceptions`** (ADR 1200, `UXI-MIG-004`): contract
  ids, scope, the interactions and tests it excuses, why, an issue (a GitHub issue, or the plan
  task that retires it until one is filed), an owner (a team or role), a severity, an expiry and
  a reproduction. Two start it: the nine Escape listeners that share one key (EXC-001, until
  KF1) and Escape in the palette on real Chrome (EXC-002, issue #32).
- **Owner names are data.** The inventory's list and the schema's enum are the spec's union;
  the shell's `interaction/owners.ts` (IC1) mirrors them, and the guard checks it once it exists.
- **Tests claim scenarios in their titles.** A title starting `UXI-T07 — …` (or the spec's
  `UXI-T07: …`), `@uxi:` tags for more scenarios or for requirements, and in Rust a `uxi_t60_…`
  fn or a `/// UXI-T60` doc line. `covers()` keeps naming real surface ids only. Skipped,
  expected-failure, ignored and quarantined tests claim nothing.
- **The report reuses the surface gate's readers.** `covers-reader.mjs` exports its `git grep`
  candidate search, its skip rule and its layer rules; `uxi-coverage.mjs` maps them to the
  spec's layers (`engine` for Rust and headless tests, `journey-cpu` and `journey-gpu` for the
  journeys, `e2e` as evidence of the CPU browser layer).
- **A ratchet both ways.** A scenario no test claims is acknowledged in
  `uxi-acknowledged.json` with its plan task and a reason; an acknowledged scenario a test
  claims fails the run until its entry goes, and a claimed one that loses its test fails unless
  it is acknowledged again. On 2026-11-13 the baseline claims 11 scenarios today's code
  already passes; the other 65 are acknowledged.
- **Gates are raised in the inventory.** `--gate` fails when a test of a gate in
  `enforcedGates` is neither claimed nor excused by an unexpired exception. It starts empty, so
  CI reports and does not enforce. A raised gate is not lowered (ADR 1200). With G4 enforced,
  every exception needs a GitHub issue (§23.4).
- **CI.** The `surface` job runs the two scripts' tests, the guard and the report with
  `--summary --gate`, independent of the surface gate; the JSON report joins the
  `surface-conformance` artifact. An edit to the spec triggers the job.

## Consequences

- A task that makes a scenario pass names it in a test title and removes its entry from
  `uxi-acknowledged.json` in the same commit (`bun scripts/uxi-coverage.mjs --prune`).
- A change to the spec's ids, tests or vocabularies lands with `--sync` and the curation of
  what it adds; until then the job fails.
- A new interaction, or a migrated one, changes its entry: owner, adapter, status. Moving one
  to `migrated` while a legacy listener still answers the same event class in the same scope
  fails `UXI-MIG-002`.
- The report says which layers a scenario's claims are in and which expected layers lack
  evidence. Visual, manual accessibility and chaos evidence cannot be read from a path and is
  listed as missing there; the layers are reported, not gated.
- The JSON report written locally (`--json`) is not committed; CI uploads its own.
