# Canvas fidelity tests

End-to-end fidelity suite that drives the canvas app in a real
browser and diffs per-page PNG output against InDesign-exported
reference PDFs from `corpus/idml/`.

## Quickstart

```bash
# from apps/canvas/
npm run wasm                        # rebuild paged-canvas-wasm if needed
npm run fonts:list                  # show declared fonts per pack (read-only)
npm run fonts:resolve               # download free fonts to corpus/fonts/.cache/
npm run test:fidelity               # gate every non-skip pack
npm run test:fidelity:capture       # record metrics, write thresholds
npm run test:fidelity:ui            # interactive Playwright UI

# subset
FIDELITY_PACKS=ancient-building-magazine,brochure npm run test:fidelity

# turn the GPU/Vello path on (sub-phase D — local only)
# Forces headed Chromium because headless ships no WebGPU adapter;
# falls through to the CPU snapshot path automatically if the GPU
# init fails (so the suite never refuses to run, just notes the
# fallback in the worker warnings).
BACKEND=gpu npm run test:fidelity
```

Output lands in `/tmp/paged-canvas-fidelity/<pack>/`:

- `cand-NNN.png` — canvas snapshot for page N
- `ref-NNN.png` — `pdftoppm`-rasterised reference PDF page N
- `heat-NNN.png` — ΔE heatmap (peak red ≈ ΔE 5)
- `pack.json` — per-page mean ΔE / p99 ΔE / SSIM + worst-of-pack

`/tmp/paged-canvas-fidelity/results.json` rolls every pack into one
file for downstream analysis. `corpus/config/canvas-fidelity-thresholds.json`
is the gate spec — captured by `npm run test:fidelity:capture`.

## Environment

| Var              | Default                      | Meaning                                                                                                                                                                                     |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIDELITY_DPI`   | `144`                        | Resolution. Mirrors `corpus/harness/test.sh`'s `IDML_ENVATO_DPI`.                                                                                                                           |
| `FIDELITY_OUT`   | `/tmp/paged-canvas-fidelity` | Output root.                                                                                                                                                                                |
| `FIDELITY_PACKS` | (all non-skip)               | Comma- or space-separated pack-name subset.                                                                                                                                                 |
| `FIDELITY_MODE`  | `gate`                       | `gate` fails gated packs on threshold violation; `capture` writes baseline JSON; `advisory` logs only.                                                                                      |
| `BACKEND`        | `cpu`                        | `gpu` routes per-page renders through the Vello WebGPU readback path. Forces headed Chromium + `--enable-unsafe-webgpu --use-vulkan` flags. Falls back to CPU if the adapter request fails. |

## Architecture

- `playwright.config.ts` — single-worker chromium project, Vite as
  `webServer` on port 5180.
- `tests/fidelity.spec.ts` — one `test()` per pack; generates the
  tests at module load from the manifest.
- `tests/fidelity/canvas-driver.ts` — `openCanvas`, `loadIdml`,
  `snapshotPagePng`. Bypasses the React file-input path so the test
  can pass the CMYK ICC profile directly to `client.loadDocument`.
- `tests/fidelity/fixtures.ts` — pack discovery + manifest parsing.
- `tests/fidelity/pdf-rasterize.ts` — caching wrapper around
  `pdftoppm`. Caches by `(pdf mtime, dpi)`.
- `tests/fidelity/png-align.ts` — pads PNGs to a common bounding
  box when `pdftoppm`'s pt-rounded output differs by ≤ 8 px from the
  canvas's fractional-pt snapshot.
- `tests/fidelity/diff.ts` — shells out to `target/release/paged-diff`.
- `tests/fidelity/fonts.ts` — parses per-pack
  `corpus/idml/overrides/<pack>/fonts.sh`. Source of truth for
  family → TTF substitution (mirrored to the canvas via the wasm
  `registerFont` method so canvas and reference PDF use the same
  fonts).
- `tests/fidelity/idml-fonts.ts` — extracts declared font families
  from an IDML's `Resources/Fonts.xml` for the auto-resolver.
- `tests/fidelity/google-fonts.ts` — downloads families from the
  Google Fonts CSS API + decompresses WOFF2 to TTF via
  `woff2_decompress` (host dep, `brew install woff2`).
- `tests/fidelity/thresholds.ts` — read/write per-pack ΔE/SSIM
  thresholds. Capture mode writes baseline + 25 % headroom.
- `scripts/fonts-resolve.ts` — `npm run fonts:resolve` driver.

## Multi-font wasm path

The wasm worker accumulates a font registry across `registerFont`
calls; `loadDocument` builds a `BytesResolver` from the registry +
the default font and hands it to `paged_renderer::PipelineOptions`.
Mirrors `paged-inspect --font-family "Family=path"` and `--default-font`.

## Known gaps

- **CMYK ICC**: closed by routing through Mozilla's `qcms` on
  wasm32. ~0.6 ΔE residual remains vs the native lcms2 path on
  CMYK-coloured pages (algorithmic precision differences in BPC
  and LUT interpolation). The thresholds JSON absorbs this.
- **GPU path** (sub-phase D): landed but requires headed Chromium.
  Headless WebGPU isn't available; CI continues to gate the CPU
  tier and the GPU path is opt-in via `BACKEND=gpu` for local
  validation.

## Relation to the native gate

`corpus/harness/test.sh` exercises the native renderer (`paged-inspect`
CLI) against the same PDFs. The canvas suite exercises the
`apps/canvas` worker + wasm path. They share the corpus, the
overrides, and the diff binary but not the renderer driver, so each
catches regressions the other can miss.

## The headless editor (`tests/headless/`)

Not Playwright: `bun run test:headless` (from `apps/canvas`, or from
`apps/editor`) runs `tests/headless/**/*.test.ts` under `bun test`, with no
browser. `tests/headless/harness.ts` builds the editor on the real engine:

```ts
import {
  gestureFixture,
  GESTURE_TARGETS as T,
  covers,
} from "@paged-media/test-kit";
import { createHeadlessEditor } from "./harness";

const ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
await ed.select([T.frame.id]);
await ed.invoke("paged.object.delete"); // the real command registry
covers("command:paged.object.delete");
expect(ed.problems()).toEqual([]);
const dump = await ed.dump(); // canonical model JSON (test-kit modelDump)
await ed.dispose();
```

Real: the canvas-wasm engine (one module per process, a fresh engine per
editor), `CanvasClient` over an in-process render worker
(`@paged-media/test-kit` `createEngineWorker`, which mirrors
`src/worker/worker.ts` message for message; painting is off), the shell
registries (`createShellRegistries`), the app's command, menu and keybinding
sets with their real runners (registered as `main.tsx` registers them: keep
the two in step), the app's object registry, Boa `paged.*` scripts
(`ed.script`), `editor.*` / `demo.*` automation (`ed.automation`,
`ed.runDemo`, and `globalThis.__canvas` while the editor is live), plugin
hosts (`ed.host()`, `ed.loadBundle(bundle)`), keyboard dispatch
(`ed.press("cmd+z")`), and the editor's default font. Stand-ins: the
shell's React state (document, selection, camera, tool, content selection,
tool settings, screen mode, overlay signals, edit context) is `ed.state`,
plain objects with the same members; set `ed.state.editContext` to run a
command inside a plugin content type. Off: rendering, panels and dialogs
(`ed.opened` records what a command asked to open). Not registered
headlessly: the `paged.panel.show.*` pairs (they derive from mounted
panels) and the shell-internal chrome commands. The surface-parity suite and
its matrix are described in `docs/development/surface-parity.md`.
