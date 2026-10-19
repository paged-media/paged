# tests — the cross-component tests

A unit test sits beside the code it tests. A test about how components fit
together belongs to none of them, so it lives here, at the repository root
(PM plan T1). Each directory is a category, named for what its tests are
about:

| Directory    | What it asserts                                                                                                                                                                                                                                                  | Runner                                | CI                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------- |
| `contracts/` | The plugin contract between the editor, plugin-sdk and the nine built-ins: every manifest against what its bundle registers, the surface gate's static enumeration against the same, and the BundleHost doors on the editor's, the headless and the bare adapter | `bun test` (`bun run test:contracts`) | `tests / contracts + system` |
| `system/`    | The product is complete: all nine built-ins live in the headless editor                                                                                                                                                                                          | `bun test` (`bun run test:system`)    | `tests / contracts + system` |

The `bun test` lanes run here:

```sh
cd tests
bun run test:contracts
bun run test:system          # needs the engine's and the modules' wasm built
```

## What is not here, and why

- **A module's own conformance** stays in the module
  (`modules/<name>/tests/conformance/`, `<name>-conformance` crates): it tests
  one component.
- **The engine's fidelity lanes** (the golden snapshot, the generated-corpus
  pixel gate, the text-layer gate, export-diff, the InDesign probes) stay in
  `engine/core`: they test the engine alone against InDesign and run from its
  Cargo workspace (`core / fidelity`).

## Tiers

The surface-conformance gate (`apps/editor/scripts/surface-coverage.mjs`,
ADR 227) derives a test file's tier from its path. Here the directory names
the subject, not the tier, so the file name carries it: a `*.headless.test.ts`
runs on the headless editor (`headless`), a `*.spec.ts` is a Playwright spec
(`e2e`), and any other `*.test.ts` is `unit`.
