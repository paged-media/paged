# Editor testing — the E2E operation suite

The **core test suite** of the editor: every operation, end-to-end,
proven to land in the IDML document rendered on the canvas. Lives in
`apps/canvas/tests/e2e/`. Complements the existing per-panel behaviour
specs (`apps/canvas/tests/*.spec.ts`) and the InDesign-reference
**fidelity** gate (`/tests/fidelity/editor-packs.spec.ts`, Playwright project `fidelity`).

The central question every test answers: **was the operation
successfully applied to the IDML document on the canvas?** — not just
"did the panel update its DOM".

```bash
cd apps/canvas                  # engine wasm arrives via npm (Decision B) —
                                # `pnpm install` at the repo root suffices
npx playwright test tests/e2e   # the whole E2E suite
npx playwright test tests/e2e/text-ops   # one domain suite
```

## The operation sandwich

`tests/e2e/harness/op-sandwich.ts` is the centerpiece. Every op is
wrapped in the same proof:

```
baseline snapshot + model dump
  → apply (UI-driven where a UI path exists, else client.mutate / gesture)
  → invalidation contract  (the reply lists the page dirty; a control
                            page stays byte-stable)
  → model assertions       (elementProperties / collections changed)
  → render diff            (pixels changed INSIDE the affected region,
                            ZERO collateral outside)
  → undo  → model deep-equals baseline AND pixels BYTE-IDENTICAL
  → redo  → effect returns
```

**Byte-identical undo is an engine guarantee** (the CPU renderer is
deterministic: `vello_cpu`, single-threaded, signature-keyed layout
cache — core's `paged-canvas` AC-E-7). A violation the suite finds is
an engine bug, not test flake.

Key `SandwichOpts`:

- `region` — page-space pt rect (from `elementPageRectPt`, NOT
  `frameBounds`: model space ≠ page space) the op should repaint.
- `containment` — assert ZERO changed pixels outside region+slack
  (collateral-damage check). Default on when a region is given.
- `controlPage` — a page that must NOT repaint (cross-page collateral).
- `noRenderChange` — for ops that legitimately don't repaint (an
  unreferenced swatch, a layer rename).
- `skipUndoPixelCheck: string` — waive ONLY the byte-identical-undo
  render assertion for a KNOWN engine bug. The reason is logged; model
  restore stays hard; a dedicated `test.fail` must own the strict
  check so it flips the day core fixes it. **Never** use it to hide an
  unexplained diff.

Support files: `pixel-diff.ts` (pngjs, region-scoped), `model-dump.ts`
(stable-JSON element / story / doc dumps), `fixtures.ts` (the fixture
table + scene-tree target resolver), `ui.ts` (panel-control drivers +
`mutate`/`script` fall-backs).

## The capability matrix

`tests/e2e/capability-matrix.spec.ts` + `harness/capabilities.ts`
probe EVERY wire `Mutation` op against a live document with minimal
valid args and classify it **empirically** — `supported` (applies,
model changes, undo restores) or `unsupported` (rejected; the note
carries the error kind). The probe asserts the live result matches the
checked-in table; **support changing in either direction fails CI**
with instructions to update the table AND the domain test.

Each probe creates its own scratch resource first (a swatch, style,
layer, spot ink, path) so the classification reflects the engine, not
whether the fixture held a deletable swatch. To re-seed after core
lands new ops:

```bash
E2E_CAPS=capture npx playwright test tests/e2e/capability-matrix
```

then copy `/tmp/paged-e2e-capabilities.json` into `harness/capabilities.ts`.

As of the seed run only `applyStyle`, `insertField`, `moveFrame`,
`linkFrames`, `unlinkFrames` are `notImplemented` stubs (moveFrame
rides the translate gesture); the other 55 wire ops are live.

## The domain suites

| File                  | Proves                                                       |
| --------------------- | ------------------------------------------------------------ |
| `text-ops`            | insertText / deleteRange change the story + repaint          |
| `frame-ops`           | insert frame/line/path, resizeFrame — create + reshape       |
| `page-ops`            | insert/delete/resize page (structural; reply vectors)        |
| `property-roundtrip`  | frame PropertyPaths via setElementProperty                   |
| `color-ops`           | editSwatch on a USED swatch repaints; resource CRUD          |
| `style-ops`           | setStyleProperty cascade; style CRUD                         |
| `layer-ops`           | layer insert / set-name / visible / locked / printable       |
| `path-pathfinder-ops` | pathfinderBoolean union; pathPointRemove                     |
| `transform-gestures`  | translate gesture render diff amid transforms                |
| `tools-ui`            | a REAL mouse drag of the Rectangle tool creates a frame      |
| `undo-stack`          | a 5-op stack → byte-identical undo/redo + replay determinism |
| `export-verification` | an edit changes the EXPORTED PDF (pdftoppm raster)           |
| `real-doc-smoke`      | the curated op pass on real docs (sample, line-sheet)        |
| `script-parity`       | `paged.*` produces the same model as the wire mutation       |
| `property-fuzz`       | seeded random property writes never error; undo byte-clean   |
| `performance`         | load / op / snapshot latency under generous budgets          |

`harness/doc-op-pass.ts` is the document-parameterized op pass shared
by real-doc-smoke and the extensive corpus mode. It classifies each
op `pass` / `skip` / `render-stale` / `error`, so a real document's
richness (text frames with no fill, already-styled elements) reads as
an insight, not a failure — only `error` (worker failure / panic) is a
hard fault.

## The extensive corpus mode (opt-in)

`tests/e2e/extensive-corpus.spec.ts` runs `docOpPass` over the whole
`corpus/envato/packs` corpus of 61 real InDesign documents — the
"deeper insights on real InDesign documents" pass. It registers ZERO
tests unless `E2E_PACKS` is set, so normal runs stay fast.

```bash
E2E_PACKS=all npx playwright test tests/e2e/extensive-corpus            # ~1.5–3 h
E2E_PACKS=brand-guidelines,catalog npx playwright test tests/e2e/extensive-corpus
E2E_MODE=gate E2E_PACKS=annual-report npx playwright test tests/e2e/extensive-corpus
```

Default mode is **advisory** — every pack × op outcome is collected
into `/tmp/paged-e2e-extensive/report.{json,md}` (a per-pack × per-op
status table) and no pack fails the run. `E2E_MODE=gate` flips per-pack
errors to hard assertions once a pack is known clean.

## Adding a test for a new op

1. Pick (or generate) a fixture that exercises it (`harness/fixtures.ts`).
2. Resolve the target via the loaded fixture (`firstRectangle`,
   `firstStory`, …).
3. Drive the op through the **real UI** if one exists (`ui.ts`
   helpers), else `mutate` / a gesture, documenting why.
4. Wrap it in `opSandwich` with the affected `region` and the model
   assertions.
5. If the op is wire-level, add/confirm its row in `harness/capabilities.ts`.
6. If it surfaces an engine bug, flag it with a `test.fail` /
   `test.fixme` that turns red the day core fixes it, and record it in
   [engine-findings.md](./engine-findings.md).

## Conventions

- Test ids: `AC-E2E-<DOMAIN>-<n>`.
- Snapshots at 420–460 px, CPU path only (deterministic); GPU stays
  the fidelity suite's job.
- `openCanvas` pipes browser console + pageerror into the test log, so
  a render panic surfaces in the report.
- Don't loosen a budget or a threshold to hide a regression — fix it,
  then tighten.

## Interaction contract harness

The interaction contract (`docs/specs/ideas/paged_interaction_specification.md`, §23) asks every
acceptance test to assert the document and its history, never a screenshot alone. The harness in
`apps/canvas/tests/e2e/harness/` gives each half one call:

| Helper                                                                   | File               | Answers                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelSnapshot(page)`                                                    | `model-dump.ts`    | The whole document as the gesture invariants compare it (the test kit's engine dump: scene tree, every element's properties, meta, pages, spreads, swatches, layers). Equal strings = equal documents.                          |
| `selectionSnapshot(page)`                                                | `model-dump.ts`    | The main thread's element selection (sorted), the active group, the text caret or range. Selection is not in the history (D-15): compare it apart.                                                                              |
| `undoDepth`, `historyDepth`, `expectHistoryUnchanged`, `expectUndoSteps` | `history.ts`       | The engine's undo timeline (`client.undoLog`), the log Cmd-Z acts on — not a count of replies.                                                                                                                                  |
| `dragStartOnObject`, `movePointerBy`, `releasePointer`, `clickOn`        | `interaction.ts`   | Real pointer input on an element (its centre through its transform) or a page point, through the live camera.                                                                                                                   |
| `expectNoGesturePreview`                                                 | `interaction.ts`   | No transient overlay is drawn. The marquee, the tool preview, the snap lines and the guide drag preview carry `data-gesture-preview` (`packages/shell/src/overlays/`).                                                          |
| `engineGestureOpen`, `assertCanBeginNewDrag`                             | `interaction.ts`   | INV-8: nothing is left open in the engine (a begin with no nodes is refused as `alreadyActive` only while one is), and a fresh drag moves an object as one undo step, which the helper undoes.                                  |
| `openUxiFixture(page, "A"…"E")`, `openUxiFixtureF`                       | `uxi-fixtures.ts`  | Fixtures A–F, built in code; ids and hit points exported (`UXI_A` …).                                                                                                                                                           |
| `openTwoEditors`, `focusEditor`                                          | `two-instances.ts` | Fixture G: two editors on one page (`demos/two-editors.html`).                                                                                                                                                                  |
| `openChaosCanvas`, `delayReply`, `reorderReplies`, `chaosIdle`           | `chaos.ts`         | Fixture H: a slow worker. Under `?debug=chaos` the page entry publishes `__chaos`, a reply gate (`CanvasClient.setReplyGate`) that settles the callers of a request kind late or in reverse order; an embedding never gets one. |

`harness/FIXTURES.md` lists what each fixture holds and its known gaps. The plugin-sdk's gesture kit
adds the invariants at every layer: `checkLiveness` (INV-8: an interrupted gesture ends without a
mutation) and `checkNoInterleave` (INV-7: no document write lands inside an open gesture), next to
`checkUndoRedo` and `checkCancel`.

A scenario test is named by its spec id, with a real feature id and a level:
`UXI-T02 — dragging an unselected rectangle moves it in the same gesture @feat:editor-tools.move.translate @level:gesture`.
`covers()` names only the real surface ids the test asserts (`tool:paged.tool.select`,
`keybinding:backspace→paged.object.delete`), never a spec id. `tests/e2e/uxi-baseline.spec.ts` holds
the scenarios today's editor already meets; `tests/e2e/tapes/legacy-*.tape.json` are the recorded
pointer streams of the legacy Selection, Type, Hand and Zoom tools with what each left in the
document (`uxi-legacy-tapes.spec.ts` replays them): the parity baseline a reworked pointer
coordinator must reproduce (UXI-MIG-001). Re-record them, deliberately, with
`UXI_TAPES=record npx playwright test tests/e2e/uxi-legacy-tapes.spec.ts`. They replay on the
coordinator (the default since IC4, editor ADR 1210) and on the legacy path
(`?debug=legacy-pointer`, the `uxi-legacy-pointer` project) to the same outcome. One tape was
added, not re-recorded: `type-drag-text`, a Type-tool drag that starts over text, which selects
text since IC4 (`UXI-TXT-011`) and did nothing before — the old `type-drag` recorded a frame
pulled out on empty canvas because that was the only Type drag that worked, and it still does.

## Flakes and the quarantine

[ADR 228](../adr/228-flaky-tests-are-quarantined.md). In CI a test that fails and then passes
on its retry fails the run (`failOnFlakyTests`); locally it prints as `flaky`.

- **Wait for the render, never for time.** Assert a page change with
  `designer.expectRenderChangesFrom(before)`: it snapshots again whenever the engine reports a
  change and at least once a second, for up to 30 s. A `waitForTimeout` followed by one
  `renderBytes()` is the flake this suite has had most.
- **Quarantine a flake you cannot fix now**: add `{ tag: "@quarantine" }` to the test and an
  entry to `apps/canvas/tests/quarantine.json`:

  ```json
  {
    "id": "e2e/x.spec.ts › describe › title",
    "owner": "@your-handle",
    "added": "2026-10-19",
    "expires": "2026-11-18",
    "reason": "what flakes, what the fix is, where it is tracked"
  }
  ```

  `id` is the line Playwright prints without the project; `expires` is at most 30 days after
  `added`. `bun run test:quarantine` (apps/editor) checks the list, the expiry and that the
  list and the tags name the same tests. CI runs quarantined tests apart, with retries, and
  never gates on them.

- **Measure.** `bun scripts/flake-rate.mjs <report.json>...` (apps/editor) prints the flake
  rate of any Playwright JSON report. For a local measurement run the suite with
  `--repeat-each=3 --retries=0 --reporter=json`; repeats that disagree count as flaky. CI
  writes the number of every run to the `playwright-flake-rate` artifact.
