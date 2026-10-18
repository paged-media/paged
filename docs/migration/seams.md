# B3b — the version-skew seams, deleted

Before the monorepo, each module installed a *published* plugin-api, plugin-sdk and engine,
usually older than the editor that hosted it. So the modules carried code whose only job was to
run against an older host or engine: mirrors of contract types, `typeof host.x === "function"`
probes, casts toward unpublished ops, fallback lanes for doors an old host lacked, and tests of
all of that. B3a put every first-party dependency on `workspace:*` (protocol 74), so every module
now builds and tests against the in-tree contract, SDK and engine at one revision. That code is
dead. B3b deletes it, and stops committing the wasm of the three modules that still did.

This file is the record T5 asks for: each deletion, and each deleted test, with its reason.

## What counted as a seam

Deleted:

- **The seam files the plan names**, whole, with every lane inside them.
- **Every `typeof` probe of a contract door.** A door is on the in-tree contract and in both hosts:
  the editor's (plugin-sdk's `createBundleHost` over the editor's backends) and the headless one
  (`createHeadlessHost`), which build the same facade. A fake host in a unit test is not a host;
  where a fake lacked a door the code now calls, the fake gained the door.
- **Fallback lanes** that only an older host or engine reached: the raw editor client's
  `documentLoaded` broadcast (every host has `document.onDidOpen`), the `minted` scene-tree diffs
  and raw-reply listeners (every outcome carries `minted`), the menu fallbacks (every host has
  `contribute.menu`), the per-host memories of "this host lacks door X".
- **Casts** toward ops and requests the wire now carries, and the editor's two
  `as unknown as PluginBundle` casts.
- **The host's courtesy menu entries** (and the shell registry's `fallbackFor` mechanism) that
  stood in for bundles without the menu door.

Kept (see [Probes kept](#probes-kept)): `host.supports()` probes. A *dynamic* feature says a host
wired a backend, and a host may not (the headless harness wires no shell, no widget catalog, no
binary mutation lane); a *static* feature is the contract's capability mechanism and costs
nothing. Static probes were removed only where they were part of a deleted seam or lane.

## Per module

| Commit | Module | Deleted | Lines (+/−) |
|---|---|---|---|
| `451c452` | web | menu fallback; `document-opened.ts`'s raw-broadcast lane; `typeof` probes in `overlay-channel.ts`, `web-source-panel.tsx`, `bake-to-document.ts`; `test/sdk-pin.spec.ts` | +71 −200 |
| `fdcf37b` | doc | menu fallback | +3 −23 |
| `4474bf1` | image | `glue/src/host66.ts` (136) and `glue/test/host66.spec.ts` (167); menu fallback; `typeof` probes; the `undoLabel`/`redoLabel` cast; `test/sdk-pin.spec.ts` | +94 −482 |
| `0612e7d` | data | `src/doors.ts` (81), `src/module-door.ts` (63); the per-document engine-label probe and the pre-69 "session part alone" lane; the raw-broadcast open lane; menu fallback; `typeof` probes; `test/sdk-pin.spec.ts` | +202 −513 |
| `04883ba` | sheet | `src/protocol66.ts` (208), `src/binding-provider/adr023-seam.ts` (184); the `minted` tree-diff lane, `tableHandlesLikely`, the `deleteTable` memory, the frame-to-story walk, the frame-chain read-back; the raw-broadcast open lane; menu fallback; `typeof` probes; three host simulators in `test/perf/workload.ts`; `test/sdk-pin.spec.ts` | +370 −1188 |
| `848dc64` | draw-tools | `src/wire-compat.ts` (144): the machines' `*Wire` shapes are now the contract's `Mutation` variants | +22 −223 |
| `8bb65c8` | draw | `src/binding-provider/adr023-seam.ts` (172), `src/commands/v58-wire.ts` (234), `src/commands/v59-wire.ts` (223); `minted.ts`'s reply and diff lanes; four probes; menu fallback; casts; four host views in `test/conformance/one-batch.ts` | +517 −1731 |
| `e8d5df4` | editor (+ bundle menu comments) | the four courtesy `Object ▸ Insert …` entries and `MenuRegistry`'s `fallbackFor`; two `as unknown as PluginBundle` casts; local copies of `ModulesBackend` / `DocumentsBackend` / `OpenDocumentResult`; `tests/menu-fallback.spec.ts` | +61 −422 |
| `a8a1753` | platform/extensions | prose only (a contract comment and ADR 305 named deleted files); plugin-api and plugin-sdk 0.2.67-canary.0 | +9 −11 |
| `939be61` | draw, image, publish | committed wasm build output (see [Wasm](#wasm)) | +238 −6310 |

The live parts of a deleted seam moved to where they belong: draw's batch-handle builders to
`commands/batch-handles.ts`, its opacity-mask and type-on-a-path builders to their commands, the
refusal reader to `commands/refusal.ts`, the Layers provider's op builders into
`layers-provider.ts`; data's module-door resolver to `hostWasm` in `bin-url.ts`, its documents
probe to `hasDocumentsDoors` in `session.ts`.

One bug came out of removing a cast: data's variable-library export called
`host.shell.saveFile({ name, bytes })`, but the contract's field is `suggestedName`, so the
proposed file name was dropped. It now passes `suggestedName: "variables.xml"`.

## Tests deleted

Counts are vitest results with the CI environment of each module (`REQUIRE_REAL_*`, the DuckDB
browser lane), before (B3a, `b3/workspace-deps`) → after.

| Package | Before | After | Deleted |
|---|---|---|---|
| web-bundle | 339 | 330 | 9 |
| doc-bundle | 41 | 41 | 0 |
| image glue | 349 + 3 skipped + 1 failed | 343 | 10 (the failure and the skips are the stale committed wasm; see [Wasm](#wasm)) |
| data-bundle | 401 + 2 skipped | 386 + 2 skipped | 15 |
| sheet-bundle | 348 + 1 skipped | 335 + 1 skipped | 13 |
| draw-bundle | 1650 + 34 skipped | 1645 + 34 skipped | 5 |
| draw-tools | 337 | 337 | 0 (`wire-compat.ts` was types only) |
| editor Playwright | — | — | 4 (`tests/menu-fallback.spec.ts`) |

Every other package is unchanged (plugin-sdk 713, ai 31, cli 54 + 1 skipped, idml-viewer 27,
publish 39, slide 59, the host models, editor `node:test` 23).

### Itemised

**web** (`451c452`)
- `test/sdk-pin.spec.ts`, 7 tests — the workspace pins it checked are checked repo-wide by
  `tooling/js/check-workspace-deps.mjs` (every manifest's first-party dependencies and peers are
  `workspace:`, and `bun.lock` resolves them to the workspace); one plugin-api and one plugin-sdk
  exist, so "they move together" holds by construction.
- `test/auto-render.spec.ts`, 1 — "an opened document is rendered afresh (raw client broadcast)":
  the deleted older-host lane. The `document.onDidOpen` case stays.
- `test/parts-gc.spec.ts`, 1 — "a file opened after activation is collected (raw client
  broadcast)": same.

**image** (`4474bf1`)
- `test/host66.spec.ts`, 5 of its 6 — the splice, binary-lane, JSON-lane, "null for every door an
  older host lacks" and "uses each door" cases of the deleted accessors (the SDK's
  `mutateWithBytes` owns the splice fallback now). The sixth, "old revisions are collected"
  (`collectGarbage`), moved to `test/persist.spec.ts` unchanged.
- `test/sdk-pin.spec.ts`, 5 — as web's.

**data** (`0612e7d`)
- `test/sdk-pin.spec.ts`, 8 — as web's, plus "data-host-model depends on the same plugin-api",
  which the same workspace check covers.
- `src/__tests__/protocol69-consumers.test.ts`, 4 — "a 0.2.40-shaped host has none of them and is
  never asked" and "a v69 SDK on a v69 engine has them; on a v68 engine the label is off" (the
  door detection of the deleted `doors.ts`); "without the doors: the session part alone" and
  "restore without the doors reads the session part" (the pre-69 lanes).
- `test/protocol69-real-core.spec.ts`, 1 — "the engine probe agrees with the engine": the probe
  is gone.
- `src/__tests__/module-door.test.ts` → `wasm-door.test.ts`, 2 of the resolver's 4 — "is null
  when the door refuses, throws, or answers nothing" (a rejecting door is now asserted in the
  `initEngineGlue` test; malformed answers and a throwing `supports` are old-host shapes) and
  "normalises a missing integrity" (`HostedModule.integrity` is never absent). The no-backend case
  stays.

**sheet** (`04883ba`)
- `test/sdk-pin.spec.ts`, 8 — as data's.
- `test/swatches-provider.spec.ts`, 2 — `supportsBindingProviders` on a host without the door and
  without a registry; the function is gone, and the no-registry case stays covered by "activate()
  registers NO provider on a host without the registry".
- `test/session-document-open.spec.ts`, 1 — the raw-broadcast iteration of "a document opened
  after boot restores its workbook part".
- `test/session-place66.spec.ts`, 1 — "a host with no 66 door: never sent, two mutates as before".
- `test/perf/perf-budgets.spec.ts`, 1 — the two-batch "place a 50×20 range" budget, measured
  through a pre-66 host view; the one-call scenario now carries its name.

**draw** (`8bb65c8`)
- `test/conformance/minted.spec.ts`, 4 — "REPLY", "OUTCOME with no raw client beside it", "DIFF"
  and "a hatch whose replies carry no list": the lanes are gone. The outcome, refusal and
  `bindMinted` tests stay.
- `test/conformance/layers-provider.spec.ts`, 1 — "degrades honestly on a host with no
  binding-provider registry": it drove the deleted `registerBindingProvider`; the probe is one
  expression in `activate.ts`, and plugin-sdk's `binding-provider.spec.ts` covers the SDK's
  no-registry door.
- Not whole tests: the `reply`, `diff`, `unlisted` and `asFound` runs inside the lane-comparison
  tests of appearance-bake, blend, compound-path, image-trace, live-paint, pattern, repeat and
  symbols, and svg-io's older-lane passes. Those tests keep their `oneBatch` and `stepwise` runs.

**editor** (`e8d5df4`)
- `apps/canvas/tests/menu-fallback.spec.ts` (Playwright), 4 — the `fallbackFor` registry
  behaviour and the four marked courtesy entries, both gone. What a user sees stays pinned by
  AC-INSERT-1 (`tests/e2e/insert-menu.spec.ts`) and by the plugin-surface and plugin-menus checks
  that each insert verb appears once.

Test fixtures changed without deleting tests: fake hosts in 2 web/doc, 19 data and 19 sheet spec
files gained the doors the code now calls unguarded, two fakes stopped claiming a capability they
did not carry, the sheet fakes that model an engine reply now include `minted` and a text frame's
geometry `storyId`, and data's labelled boot budget dropped from 43 to 40 host calls.

The Cockpit test map (in the cockpit repository) still names `test/sdk-pin.spec.ts` (data, image,
web) and image's `test/host66.spec.ts`. Those entries now match nothing; their features stay
covered (`wasm-fresh.spec.ts`, `persist.spec.ts`, the bundle-lifecycle specs). Removing the dead
entries is a change in that repository.

## Probes kept

- **Dynamic backends**, true only where a host wires them: `bindings.provider@1` (draw, sheet),
  `overlay.layers@1` (web), `widgets.codeEditor@1` (web), `widgets.colorPicker@1` and
  `shell.enterEditContext@1` (image; the headless harness wires no widget catalog and no shell),
  `document.mutateBinary@1` (image's 8 MB cap; the harness has no binary lane),
  `tools.settings@1` and `document.onWillSave@1` (image, sheet), `documents.open@1` /
  `documents.exportPaged@1`, `text.measureStrings@1` (the perf budgets count the per-word lane),
  `text.caret@1` and `modules@1` (data).
- **Static features** (`storage.parts@1`, `contribute.objectModel@1`, `objects@1`,
  `document.documentMetadata@1`, `document.placeholders@1`, …): kept where they are not part of a
  deleted seam. For an in-tree bundle they are always true; dropping them is a separate, mechanical
  follow-up.
- **Fallbacks that also serve a refusal**: sheet's two-batch and phased placements and
  lower-chart's two-phase label pour (they run when the engine refuses a batch, now tried
  first in one call), the `deleteTable`-refused emptying, and web's estimate when a measurement
  is refused.

## Not in this step

- draw's engine-vocabulary probes: Join's pre-v56 coincide lane (`supportsPathWeld`),
  Reflect/Rotate's copy (`supportsDuplicate`, pre-v65) and Shape Builder's `pathfinderFaces`
  probe, whose element lane is also its fallback when the region lane finds nothing.
- draw's STEPWISE lanes (an engine refusing `bindCreated`) and the `refusingBindCreated`
  comparison lane.
- sheet's tolerance of an engine that reports no table band counts (before core 0.71.13).
- data's probes of its own engine wasm's exports (`typeof e.load_payload === "function"` and
  similar): they guard a stale local data-js build, which `wasm-fresh.spec.ts` already catches.
- plugin-api's `PendingMutation` aliases: no in-tree bundle uses them, but removing exported
  contract types would break bundles outside the repository.
- draw's `test/conformance/host.ts` engine anchors and `test/engine-pin.spec.ts` (B4's module
  index).

## Wasm

draw, image and publish committed their wasm-bindgen output so that a checkout without Rust could
typecheck and test. The copies had drifted: image's `SOURCE_HASH` was stale on the base, so its
`wasm-fresh` spec failed and three real-wasm specs skipped, and pdf-import's mapper wasm was months
older than its crate with no workflow rebuilding it.

- **draw** `packages/draw-bundle/wasm/trace_js*`, **image** `glue/wasm/image_js*` and
  `glue/wasm/SOURCE_HASH` (its `manifest/wasm/` copy was already ignored), **publish**
  `packages/pdf-bundle/bin/pdf_import*`: untracked with `git rm --cached` (history unchanged) and
  gitignored.
- **pdfium** (`packages/pdf-bundle/bin/pdfium.esm.wasm` and `.js`) stays committed. It is a
  third-party prebuilt (`paulocoutinhox/pdfium-lib`, ADR 655) that nothing in the repository
  builds.
- `.github/actions/module-wasm` builds the three (or restores them from the cache), and every job
  that needs them uses it: draw-vitest, image-ci's TS job, publish-ci's tests, the editor's checks,
  Playwright, playground and showcase jobs, and the two reference publish workflows. Moon's `wasm`
  tasks declare their outputs and the `js-test` tasks depend on them; the typechecks do not need
  the wasm.
- image's `wasm-fresh.spec.ts` checks the build output, with the dual gate the other modules use:
  skipped when nothing is built, a failure under `REQUIRE_REAL_WASM=1`, always checked when present.
  With the wasm built from this checkout, image's glue runs 343 tests with none skipped or failed.
