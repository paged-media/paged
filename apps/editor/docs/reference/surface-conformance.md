# Surface conformance

Every surface a user, a script or a tool can reach is asserted by a test,
in the layers its kind requires, or it is acknowledged with a written
reason. Surface means every command, panel, tool, menu item, keybinding,
setting, CLI command and script function, plugin contributions included.
One gate measures this: `apps/editor/scripts/surface-coverage.mjs`
([ADR 227](../adr/227-surface-conformance.md)). It is a ratchet in both
directions:

- a surface that loses its asserting test fails it;
- a gap that has since been closed fails it until its entry is removed.

```sh
bun run test:surface-coverage                    # from apps/editor: the gate's tests, then the gate
bun scripts/surface-coverage.mjs --prune         # drop acknowledged entries that are covered now
bun scripts/surface-coverage.mjs --list command  # every id of a kind, with its state per clause
bun scripts/surface-coverage.mjs --json-out r.json --md-out r.md   # the report
```

`--prune` and `--list` skip the secondary "mentioned" column, so they read only the files
`git grep` finds a covers form in: use them on a slow disk.

The bugs the programme's tests found are expected failures, indexed in
[conformance-findings-2026-10.md](../../../../docs/development/conformance-findings-2026-10.md):
one table, the shared root causes and suggested fix waves. Where the programme stands is the
last section of this page, [State](#state-2026-10-19).

CI runs the gate in the `surface` job of `.github/workflows/editor-tests.yml`. It needs no wasm,
no browser and no secrets. The job uploads the report as the artifact `surface-conformance` and
writes the tables to the job summary. Moon runs it as `editor:surface-conformance`.

## The rule: `covers()`

A test that **asserts** the behaviour of a surface id calls `covers(...)` inside the test body,
next to those assertions, with string literals:

```ts
import { covers } from "@paged-media/test-kit";

it("undo restores the deleted frame", async () => {
  covers("command:paged.editor.undo", "keybinding:cmd+z→paged.editor.undo");
  // ... the assertions
});
```

A test that only mentions an id, opens a panel without checking what it shows, or loops over
a registry without asserting each entry does not call `covers()` for it.

**Table-driven tests.** The gate reads every literal call in a test file, not only calls
inside a `test()` body, and gives each the layer of the file it sits in. A table-driven
suite (one test per row of a catalog) may therefore call a GENERATED helper in a test file
next to it, holding one literal call per row:

```ts
switch (op) { case "insertText": covers("script:paged.insertText"); return; ... }
```

Two conditions apply:

- The helper is generated from the same table the tests iterate, in the same commit.
- Every row it names is one a test runs and asserts.

Placement matters, because the helper's path decides its layer: a Boa-door table belongs
under a path with the word `script`, so that it counts for the `script` clause.

### The forms the gate reads

The forms are defined in [`platform/shared/test-kit/README.md`](../../../../platform/shared/test-kit/README.md),
section "covers()". In short:

- **TypeScript and JavaScript**: `covers(...)` imported from `@paged-media/test-kit`. Where
  the package may not depend on the kit (`platform/extensions/*` and other community-facing
  packages), a local no-op does the same: `const covers = (..._ids: string[]): void => {};`.
- **Rust**: `paged_test_resources::covers!("…")`, a local `macro_rules! covers`, or a
  `// covers: kind:id, kind:id` line directly above the assertion.

The gate enforces these rules:

- **String literals only.** A variable, a spread or a `${…}` interpolation is a gate error:
  a call the gate cannot read must not pass as covering nothing. A table-driven test writes
  its ids out.
- **Known kind and id.** Every id needs a known kind and must name a surface the gate
  enumerated. An unknown id (a typo, a renamed command) is an error, not a quiet zero. If the
  surface is real and the gate does not know it, the enumeration is missing an extractor.
- **Test files only.** The call must sit in a test file: `*.test.*`, `*.spec.*`, `*.film.ts`,
  or a file under `test/`, `tests/` or `__tests__/`. For Rust, a file under `tests/` or one
  with a `#[cfg(test)]` module.

### Surface ids

| Kind                   | Id                                                                                                                             | Enumerated from                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`              | `command:paged.editor.undo`, `command:media.paged.slide.newSlide`                                                              | the editor's command literals (`id` + `title` + `handler`); each bundle's manifest `commands` and typed `objectModel.commands`                                                              |
| `panel`                | `panel:paged.layers`                                                                                                           | `BUILT_IN_PANELS`; manifest `panels` (schema panels included)                                                                                                                               |
| `tool`                 | `tool:paged.tool.rectangle`                                                                                                    | `BUILT_IN_TOOLS` (not `status: "planned"`); manifest `tools`                                                                                                                                |
| `menu`                 | `menu:File/Export PDF…` (the path, the menu registry's key); `menu:<command id>` is an alias while exactly one item invokes it | the editor's `{ path, command }` literals; each bundle's `contribute.menu(…)` calls                                                                                                         |
| `keybinding`           | `keybinding:cmd+z→paged.editor.undo` (`->` is read as `→`)                                                                     | the editor's `{ key, command }` literals; each bundle's `contribute.keybinding(…)` calls                                                                                                    |
| `setting`              | `setting:paged.tool.polygon.sides` (a tool option is `<toolId>.<key>`)                                                         | `apps/editor/scripts/settings-inventory.json`, the editor's settings; every `{ toolId, fields }` tool-option declaration                                                                    |
| `cli`                  | `cli:paged export`, `cli:paged read layers`, `cli:paged-node get`, `cli:paged-plugin validate`, `cli:paged-run`                | `engine/core/crates/paged-cli/cli.json` (the Rust `paged`, groups and the root included); the `VERBS` table of `platform/extensions/packages/cli`; the `paged-plugin` dispatch; `paged-run` |
| `script`               | `script:paged.pages`, `script:editor.select`, `script:demo.step`                                                               | `engine/core/crates/paged-introspect/catalog.json` `hostFunctions`; the Boa bootstrap (`paged.frame`); the automation layer's `DemoGlobals` (`paged.run`, `editor.*`, `demo.*`)             |
| `importer`, `exporter` | `importer:media.paged.slide.importer.pptx`                                                                                     | manifest `importers` / `exporters`                                                                                                                                                          |

The bundles are the nine in `apps/editor/apps/canvas/src/plugin-bundle-table.ts`, slide
included. The gate pins that count, so a bundle cannot drop out of the measurement unnoticed.

**Families.** Some ids are derived from each registered item: a show and a hide command per
panel, an activation command and a shortcut per tool, a Window or Plugins menu item per panel.
The gate counts each such set as one family id with a `*`, and lists its members beside it:

- `command:paged.panel.show.*`
- `command:paged.panel.hide.*`
- `command:paged.tool.activate.*`
- `keybinding:*→paged.tool.activate.*`
- `menu:Window/*`
- `menu:Plugins/*`

A family is covered by a test that tags the family id literally and iterates **every** live
member from the registry, asserting each one. A member id (`command:paged.panel.show.paged.layers`)
is accepted, but it does not satisfy the family.

**Static, and fail-closed.** The ids are read from the code that declares them, by a small
static evaluator (`scripts/surface/static-eval.mjs`). It follows tables, `.map` callbacks,
`for … of` loops, local helpers and imports. Three guards stop it from quietly reading less:

- Every extractor has a floor (`SENTINELS` in `scripts/surface/enumerate.mjs`).
- A registration site it cannot resolve fails the run, unless it is a family or a
  `DYNAMIC_SITES` entry with a reason.
- The bundle count is pinned at nine.

A runtime test checks the static reader. `tests/contracts/surface-enumeration.test.ts` (repository
root), in the contracts lane, activates every bundle against the headless engine, records what it
registers through `contribute.menu`, `contribute.keybinding` and `contribute.tool`, and asserts
that the gate's lists for that bundle are equal to it.

## The layers

The gate reads the layer from the test file's path, never from the call. Each file has one
**tier** and any number of **tags**:

| Layer       | Kind | Files                                                                                                                                                                                                                                                |
| ----------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`      | tier | every TypeScript test file not matched below                                                                                                                                                                                                         |
| `component` | tier | `*.dom.test.ts(x)` (happy-dom), see [testing-panels.md](testing-panels.md)                                                                                                                                                                           |
| `headless`  | tier | a `headless/` directory or `*.headless.test.ts`, the headless editor ([surface-parity.md](../../../../docs/development/surface-parity.md))                                                                                                           |
| `e2e`       | tier | Playwright: `apps/editor/apps/canvas/tests/**` outside `headless/`, or an `e2e/` directory, see [testing-shell.md](testing-shell.md)                                                                                                                 |
| `rust`      | tier | a Rust test                                                                                                                                                                                                                                          |
| `golden`    | tag  | a path segment containing `golden`: output compared with a committed expectation ([testing-cli-and-scripting.md](../../../../docs/development/testing-cli-and-scripting.md))                                                                         |
| `script`    | tag  | a path segment with the word `script`, `scripts` or `scripting` (`paged-script/tests/…`, `script-console.spec.ts`)                                                                                                                                   |
| `gesture`   | tag  | a file that drives the gesture DSL (`gestures(…)`, `browserGestures(…)`, `unitBackend(…)`, or `createGestureDsl(…)` over another backend), itself or through a local helper it imports (a `test/support.ts` harness), see [gestures.md](gestures.md) |

Plugin contributions are tested in the module that owns them
([testing-plugins.md](../../../../platform/extensions/docs/testing-plugins.md)).

### What each kind requires

Each kind has one or more **clauses**. A clause is satisfied by one asserting test whose file
meets it.

| Kind               | Clause        | Satisfied by                                                  |
| ------------------ | ------------- | ------------------------------------------------------------- |
| command            | `unit`        | unit, component or rust                                       |
| command            | `integration` | headless or e2e                                               |
| panel              | `component`   | component                                                     |
| tool               | `gesture`     | a unit or component file that drives the gesture DSL          |
| menu               | `e2e`         | e2e: the item opened, its enablement checked, its command run |
| keybinding         | `any`         | unit, component, headless or e2e                              |
| setting            | `unit`        | unit or component                                             |
| cli                | `golden`      | a golden test, any tier                                       |
| script             | `script`      | a script test, any tier                                       |
| importer, exporter | `any`         | any tier                                                      |

## Acknowledged gaps

An (id, clause) that no test satisfies yet must be listed, with its reason, in
`apps/editor/scripts/surface-acknowledged/<origin>.<kind>.<clause>.json`:

```json
{
  "menu:Sheet/Sort range…": "No Playwright test opens it yet: the sort dialog needs a workbook fixture, which lands with …"
}
```

The parts of the entry:

- **origin** is `host` for the editor, the CLIs and the script surface, and `plugin` for a
  bundle's contribution.
- **One line per entry**, so parallel work merges cleanly.
- **The reason** says why no test is possible or sensible today and what would make one
  possible, in at least 40 characters. The gate started (2026-10-19) with a seeded entry for
  every gap, each with a template reason; at the close-out every gap that could be tested was,
  and the four left have written reasons. The gate refuses the seeded template
  (`reasonProblem` in `scripts/surface-coverage.mjs`, tested in `surface-coverage.test.mjs`),
  so an entry has to say something specific.

**When you cover an id**, run `--prune`. CI fails while a covered entry is still listed.

**When you add surface**, it either arrives with a test that covers it, or with an entry and
a hand-written reason.

**On a merge conflict** in these files, take origin's version and run `--prune` again.

## Reading the report

The markdown report, which is also the job summary and `--md-out`, has three tables:

1. **Per kind and layer.** The number of ids with at least one asserting test in each layer
   (a file counts in its tier and its tags), and the **mentioned** column. Mentioned is the
   old signal: the id's text appears in some test file. It is kept because it still finds
   surface that nothing has ever heard of. It no longer passes anything.
2. **Per kind and clause.** Covered / required, acknowledged, missing. Missing is always 0
   on a green run.
3. **Families**, with their member counts and how many members a covers() call names.

The JSON report (`--json-out`) has the same numbers, plus one row per id: its origin, owner,
source, layers, the asserting tests (`file:line`) and each clause's state.

## Adding a surface

1. **Register it** the usual way: a command literal, a `BUILT_IN_PANELS` entry, a manifest
   entry and `contribute.*` call, a `cli.json` regeneration, a catalog entry.
2. **Run the gate.** The new id appears as a gap.
3. **Write the tests** the kind requires and tag them with `covers("<kind>:<id>")`.
4. **If the gate cannot resolve your registration** (an id computed at run time), make it
   static, or declare a family in `FAMILY_OF_PATTERN`, or add a `DYNAMIC_SITES` entry that
   says why.
5. **A new kind of surface** (a new contribution type, a new binary) needs an extractor in
   `scripts/surface/enumerate.mjs` with a sentinel, and a case in
   `scripts/surface-coverage.test.mjs`.

## The gate and `@feat`

`@feat:<id>` tags in test titles map tests to rows of the feature registry. The registry is
the external one that the cockpit test-map reads, pulling the `playwright-results` artifact. It
answers "is this capability tested somewhere". A capability is satisfied by any one of the
surfaces that expose it.

`covers()` answers the other question: "is this concrete surface asserted". That question is
asked per id and per layer.

A test may carry both, and most behaviour tests should: `@feat` for the registry row,
`covers()` for the surface ids the test asserts. Neither replaces the other:

- The `@feat` guard (`scripts/feat-vocabulary-guard.mjs`) checks the tags against the
  registry's vocabulary.
- The `coverage_level` axis (`@level:`) records depth.
- This gate records breadth, per layer.

The JSON report is uploaded with a stable schema (`schema: 1`), so the registry can pull it
the way it pulls `playwright-results`.

## Interaction contract coverage

The interaction specification
([`specs/ideas/paged_interaction_specification.md`](../specs/ideas/paged_interaction_specification.md),
adopted by [ADR 1200](../adr/1200-the-interaction-contract-is-adopted.md)) names requirements
`UXI-<DOMAIN>-###` and 76 acceptance tests, `UXI-T01`…`UXI-T76`, in six groups (§23.1), with
gates G0–G4 (§23.4). They are contract ids, not surface ids, so `covers()` never takes them. Two
scripts beside this gate measure them ([ADR 1202](../adr/1202-uxi-coverage-ratchets-the-interaction-contract.md)):

```sh
bun run test:interaction-contract               # from apps/editor: both scripts' tests, the guard, the report with --gate
bun scripts/interaction-inventory.mjs           # the inventory guard (also --check)
bun scripts/interaction-inventory.mjs --sync    # rewrite the spec-derived sections from the spec
bun scripts/uxi-coverage.mjs                    # the ratchet and the report
bun scripts/uxi-coverage.mjs --prune            # drop acknowledged entries that a test claims now
bun scripts/uxi-coverage.mjs --json [path]      # the report as JSON (default docs/reference/uxi-coverage.json, not committed)
```

CI runs both in the `surface` job, after this gate and independent of it: the scripts' own
tests, `interaction-inventory.mjs --check` and `uxi-coverage.mjs --quiet --summary --gate`. The
report goes to the job summary and into the `surface-conformance` artifact as
`uxi-coverage.json`. An edit to the spec runs the job too. Moon runs both as
`editor:interaction-contract`.

### The inventory

`scripts/interaction-inventory.json`, with its schema `interaction-inventory.schema.json`, is the
machine-readable companion the spec asks for (§26). The spec is its source: `--sync` writes what
the spec decides, and the guard fails when the inventory says something else.

| Section                       | What it holds                                                                                                                                                                  | Written by |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `owners`, `phases`            | the spec's `InteractionOwner` and `InteractionPhase` (§3.2)                                                                                                                    | `--sync`   |
| `groups`, `fixtures`, `gates` | the test groups A–F and fixtures A–H (§23.1), the gates G0–G4 (§23.4)                                                                                                          | `--sync`   |
| `layers`                      | the evidence layers of §23.2, with the ids tests use: `unit`, `component`, `engine`, `journey-cpu`, `journey-gpu`, `visual`, `a11y-manual`, `chaos`                            | `--sync`   |
| `requirements`                | every `UXI-<DOMAIN>-###`, with its domain, its section and its first sentence                                                                                                  | `--sync`   |
| `tests`                       | `UXI-T01`…`T76`: group, steps and assertion from the spec; the gates it belongs to, its fixture, the layers its evidence belongs in and the requirements it proves are curated | both       |
| `interactions`                | each gesture, tool, context and key the editor answers: owner, event class and scope, adapter, the file that answers it today, states, permission, cancel, surface ids, status | by hand    |
| `exceptions`                  | the one exception ledger (`UXI-MIG-004`, ADR 1200)                                                                                                                             | by hand    |
| `enforcedGates`               | the gates `--gate` enforces; a raised gate is not lowered                                                                                                                      | by hand    |

The guard fails when:

- the inventory is not valid against its schema (a small validator in the script, which refuses
  a schema keyword it does not implement);
- a spec-derived section differs from the spec, or the spec mentions an id it does not define in
  a form the parser reads (a table row, a line `` `UXI-…` — ``, a heading);
- an id does not resolve: a requirement, a test, an owner, a phase, a gate, a fixture, a layer,
  an interaction, a surface id (checked against `scripts/surface/enumerate.mjs`, family members
  included), a source file, or a plan task in `docs/interaction-plan.md`;
- an exception is past its expiry;
- two interactions with different owners claim one event class in one scope (`UXI-MIG-002`),
  unless an unexpired exception that names `UXI-MIG-002` lists one of them;
- a section is under its floor (`FLOORS`: 290 requirements, 76 tests, 60 interactions on
  2026-11-13), so a parser that stops matching cannot sync the inventory down to nothing.

**Owner names are data.** `owners` is the spec's list; `packages/shell/src/interaction/owners.ts`
mirrors it, and once that file exists the guard fails when it does not name every owner.

**The seed (2026-11-13).** 60 interactions, all `legacy`: the Selection and Direct Selection
click, marquee, move, handles and path edit; Type's click and drag; double-click entry and the
edit context's content and click-out presses; Hand, Zoom, the wheel, the middle button and the
pinch; Space, Cmd and Cmd+Space spring-loading; the 23 other tools of the gesture spine; guide
drag, threading, pending placement and the file drop; the context menu by pointer and by key;
Tab's chrome toggle; the palette's Escape; text input; and Escape, resolved once per press by the
Escape arbiter (ADR 1207: the text, the entered group, the edit context, the transient modes and
the selection are its tiers). One exception: EXC-001 (the viewport's drag cancel, the gesture
handlers and path editing still listen on their own, until IC4). EXC-002 (issue #32, the
palette's Escape on real Chrome) closed with KF1/KF5. EXC-001 closed with IC4: the three answer
in the arbiter's tiers (the gesture tier while a pointer is held, the transient tier for a busy
handler and path editing), and the inventory scopes them apart (`editor/pointer-held`,
`editor/tool-busy`, `editor/path-edit`); the ledger is empty.

### Claiming a scenario

A test claims an acceptance test in its title. The report reads titles statically, like the
`covers()` calls:

```ts
test("UXI-T07 — Escape aborts a move: no history step, overlays cleared @feat:… @level:edge", async ({
  page,
}) => {
  covers("tool:paged.tool.select"); // real surface ids only, as before
  // … assert the model and the undo depth, not only pixels (ADR 1200)
});
```

- **The leading id** of a `test`, `it` or `describe` title (`UXI-T07 — …`, or the spec's
  `UXI-T07: …`). A `describe` claims for the tests it holds.
- **`@uxi:` tags** anywhere in the title claim more: `@uxi:UXI-T08` another scenario,
  `@uxi:UXI-GST-006` a requirement directly.
- **Rust**: a fn named `uxi_t60_…`, or a `/// UXI-T60 — …` doc line above the fn.

A skipped test (`.skip`, `.fixme`, `.todo`), an expected failure (`.fail`), a Rust `#[ignore]`
and a quarantined test (`@quarantine`, or an entry in `apps/canvas/tests/quarantine.json`;
ADR 228) are listed in the report but claim nothing. A claimed id the inventory does not know,
or a claim it cannot read (`UXI-T7 — …`), fails the run.

The layer comes from the file's path, with this gate's rules:

| Claim layer                  | Files                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `unit`                       | a `*.test.*` file that is not a DOM test                                                                              |
| `component`                  | `*.dom.test.ts(x)`                                                                                                    |
| `engine`                     | a Rust test, or a headless-editor test                                                                                |
| `e2e`                        | Playwright under `apps/canvas/tests/` outside the journeys                                                            |
| `journey-cpu`, `journey-gpu` | `apps/canvas/tests/journey/`: both, since `journeys-gpu` runs every journey; GPU only for the four `journeys` ignores |

A test in `e2e` counts as evidence of the `journey-cpu` layer (a browser on the CPU path).
`visual`, `a11y-manual` and `chaos` cannot be read from a path; the report lists them as
expected layers without evidence. The layers are reported, not gated.

### The ratchet and the gates

An acceptance test no test claims is listed in `scripts/uxi-acknowledged.json` with the plan
task that will claim it and why none does yet:

```json
{
  "UXI-T07": {
    "task": "IC2",
    "reason": "No test claims it yet: terminal events … do not end one coordinator session yet (IC2) …"
  }
}
```

The task must be one of [`interaction-plan.md`](../interaction-plan.md); the reason at least 40
characters. The ratchet runs both ways: a test that starts claiming an acknowledged id fails the
run until its entry goes (`--prune`), and a claimed id that loses its test fails unless it is
acknowledged again. On 2026-11-13 the baseline (`apps/canvas/tests/e2e/uxi-baseline.spec.ts`,
W0.7) claims 11 scenarios that today's code already passes and 65 are acknowledged; each task
removes entries as its tests land.

`--gate` fails when a test of a gate in `enforcedGates` is neither claimed nor listed by an
unexpired exception. `enforcedGates` is empty until the first gate is raised (G0 partially with
IC1–IC5, then G1, G2, G0 in full, G3 and G4; the plan's verification table). With G4 enforced,
every exception must link a GitHub issue. Requirement coverage (proved through a claimed test,
or claimed directly) is reported per domain, not gated.

## State (2026-10-19)

The programme is closed. Its six layers have their tests, the gate is a ratchet in CI, and
the bugs the tests found are indexed in
[conformance-findings-2026-10.md](../../../../docs/development/conformance-findings-2026-10.md)
(201 findings: 4 blockers, 30 major, 142 minor, 25 polish).

**1,148 of 1,150 surface ids are asserted.** Per kind and layer (an id counts in every layer
it has an asserting test in; the clauses are in [What each kind requires](#what-each-kind-requires)):

| Kind       |   Ids | Unit | Component | Headless | e2e | Rust | Golden | Script | Gesture | Clauses met                |
| ---------- | ----: | ---: | --------: | -------: | --: | ---: | -----: | -----: | ------: | -------------------------- |
| command    |   318 |  298 |        36 |      277 |  41 |    0 |      0 |     41 |      78 | unit 317, integration 317  |
| panel      |   120 |    0 |       120 |        0 |   4 |    0 |      0 |      1 |       6 | component 120              |
| tool       |    68 |   64 |         4 |        0 |   0 |    0 |      0 |      0 |      68 | gesture 68                 |
| menu       |   241 |    0 |         0 |        0 | 240 |    0 |      0 |      0 |      89 | e2e 240                    |
| keybinding |    57 |   51 |         0 |        0 |  47 |    0 |      0 |      0 |      47 | any 57                     |
| setting    |    53 |   42 |        11 |        0 |   0 |    0 |      0 |      0 |      34 | unit 52                    |
| cli        |    74 |   22 |         0 |        7 |   0 |   52 |     74 |      7 |       0 | golden 74                  |
| script     |   201 |    0 |         0 |      178 |   0 |  182 |      0 |    201 |       0 | script 201                 |
| importer   |    10 |    6 |         0 |        6 |   0 |    0 |      0 |      0 |       1 | any 10                     |
| exporter   |     8 |    3 |         0 |        6 |   0 |    0 |      0 |      0 |       3 | any 8                      |
| **all**    | 1,150 |      |           |          |     |      |        |        |         | 1,148 ids asserted in full |

The six families (`command:paged.panel.show.*` and the others) are asserted member by member.

**Four (id, clause) pairs are acknowledged**, each with a written reason in
`scripts/surface-acknowledged/`:

- `command:paged.sample.hello` (integration) and `menu:Tools/Sample bundle hello` (e2e): the
  editor never loads the shell's sample worker bundle, so no editor session has them. The
  command, its key binding and the menu registration are asserted through the shell's loader
  in a unit test.
- `command:paged.ai.ask` (unit) and `setting:paged.library` (unit): both live in
  `apps/canvas/src/main.tsx`, which boots the editor when imported. A unit test needs the
  code moved into an importable module. `paged.ai.ask` is asserted in the browser.

**What CI runs.** Everything below runs on every push to main, needs no secret and no private
corpus, and is required:

- `editor / tests`, job `checks`: the tool handlers (`test:tools`), the shell registries,
  stores, settings and loader (`test:shell`, `test:shell-dom`), the command handlers
  (`test:canvas-unit`), the DOM lane (`test:dom`: every panel, the mounted shell, the four
  handler-less tools on a mounted canvas), and the headless editor (`test:headless`: commands
  on the real engine, the automation layer, cross-surface parity, engine memory).
- `tests / contracts + system` (the repository's root `tests/`): the bundle contracts, the
  BundleHost contract, and the nine built-ins in the headless editor.
- `editor / tests`, job `surface`: the gate's own tests and the gate.
- The modules' workflows (`<module> / bun test`, `<module> / rust`): each bundle's commands,
  tools, panels, importers and exporters against its real wasm.
- `core / ci`: the engine's Rust tests, the `paged` command line's golden transcripts and the
  Boa host functions among them; the extensions workflow: plugin-sdk (the `paged-plugin`
  specs among them), the `paged-node` goldens and the test kit.

**What has only run locally.** The editor's Playwright lane (`editor / tests`, job
`playwright`) is red in CI and has been since the monorepo moved: it checks out the private
corpus before it runs, which needs the `STATE_DISPATCH_TOKEN` repository secret, and the
secret is not set. So the browser tier has run only on a developer machine: the menu enablement
matrix and menu dispatch (`shell-menu-matrix.spec.ts`), the keybindings
(`shell-keybindings.spec.ts`), the browser-side commands and the derived families
(`shell-commands.spec.ts`), the browser findings (`shell-findings.spec.ts`), the panels'
browser flows (`panels-browser.spec.ts`, the Layers commands' integration clause among them),
the schema demos, the plugin menus (`tests/plugin-surface/menus-*.spec.ts`), the gesture
browser, matrix and fuzz specs, and `worker-boot.spec.ts`. The gate counts their `covers()`
calls, because it reads the files; CI does not execute them. Every e2e-only clause (240 menu
items, and the e2e half of the command and keybinding clauses) therefore rests on local runs
until the secret is set or the lane stops needing the corpus. Two parity columns are local
too: the `paged` CLI and MCP doors need the `paged` binary, which the editor job does not
build (they report `unavailable` there). The WebGPU path runs only in the local
`journeys-gpu` project and the macOS showcase nightly.
