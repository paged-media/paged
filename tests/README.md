# tests — the cross-component tests

A unit test sits beside the code it tests. A test about how components fit
together belongs to none of them, so it lives here, at the repository root
(PM plan T1). Each directory is a category, named for what its tests are
about:

| Directory      | What it asserts                                                                                                                                                                                                                                                  | Runner                                                   | CI                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| `contracts/`   | The plugin contract between the editor, plugin-sdk and the nine built-ins: every manifest against what its bundle registers, the surface gate's static enumeration against the same, and the BundleHost doors on the editor's, the headless and the bare adapter | `bun test` (`bun run test:contracts`)                    | `tests / contracts + system`                                |
| `system/`      | The product is complete: all nine built-ins live in the headless editor                                                                                                                                                                                          | `bun test` (`bun run test:system`)                       | `tests / contracts + system`                                |
| `integration/` | Round trips across components: a module's state saved into the editor's `.paged` container and read back after a reopen (sheet, data, image, web)                                                                                                                | Playwright, project `integration` of the editor's config | `editor / tests`, the Playwright shards                     |
| `fidelity/`    | The editor's per-pack fidelity sweep: every pack of the private corpus rendered through the editor and diffed against InDesign's PDF                                                                                                                             | Playwright, project `fidelity`                           | none (local: it needs the corpus, `paged-diff`, `pdftoppm`) |

The Playwright lanes run on the editor's configuration
(`apps/editor/apps/canvas/playwright.config.ts`), because they drive the
editor's dev server and reuse its drivers (`apps/canvas/tests/fidelity/canvas-driver.ts`,
`tests/journey/driver/`, `tests/e2e/harness/`):

```sh
cd apps/editor/apps/canvas
bunx playwright test --project=integration
bunx playwright test --project=fidelity
```

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
- **Shared fixtures.** A fixture that two components read is read from the
  component that owns it (its conformance lane or test corpus), not copied:
  `tests/fixtures/` is for fixtures that no component owns, and there is none
  today (`docs/migration/test-inventory.md`, T1).

## Tiers

The surface-conformance gate (`apps/editor/scripts/surface-coverage.mjs`,
ADR 227) derives a test file's tier from its path. Here the directory names
the subject, not the tier, so the file name carries it: a `*.headless.test.ts`
runs on the headless editor (`headless`), a `*.spec.ts` is a Playwright spec
(`e2e`), and any other `*.test.ts` is `unit`.
