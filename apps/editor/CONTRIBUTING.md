# Contributing to the paged editor

Thanks for your interest in the **paged** editor — the React/TypeScript
frontend on top of the open render engine (`paged-media/core`). This
repository is **open**, dual-licensed AGPL-3.0 OR PMEL, like the engine and
every other part of the paged repository (ADR PM-0001).

## License of contributions

The editor is dual-licensed — **AGPL-3.0 OR the Paged Media Enterprise
License (PMEL)**. By contributing you agree to the **Contributor License
Agreement** ([`CLA.md`](./CLA.md)), which allows And The Next GmbH to
distribute your contribution under **both** the open-source license
(AGPL-3.0) **and** the commercial license (PMEL). You retain copyright to
your contribution.

A CLA bot will ask you to sign on your first pull request.

New source files must carry the standard license header — copy it verbatim
from the top of any existing source file in this repo.

## Engine boundary

This repo consumes the engine **across a package boundary** — the published
`@paged-media` wasm/SDK packages (`@paged-media/canvas-wasm`,
`@paged-media/introspect-wasm`) — **never** a Rust path dependency, and never
by reaching into core's source tree. `bun install` suffices; there is no
build-from-core step.

## Building & testing

`apps/*` + `packages/*`, members of the repository's root Bun workspace,
React 18 + Vite + TypeScript.

```bash
bun install                                            # at the repository root
bun run --filter './apps/*' --filter './packages/*' build
bun run typecheck
```

Do **not** run a repo-wide `prettier`/format pass — it drifts unrelated
files. Format only the files you touched.

## Fidelity gate

`apps/canvas` carries the Playwright suite — per-panel behaviour specs plus an
end-to-end **fidelity** suite that diffs per-page PNG output (ΔE2000 / SSIM)
against InDesign-exported references.

```bash
cd apps/canvas
bun run test:fidelity              # full gate
BACKEND=gpu bun run test:fidelity  # WebGPU/Vello path (headed; CPU fallback)
```

Don't loosen the per-fixture thresholds
(`corpus/envato/canvas-fidelity-thresholds.json`) to make a regression
pass — fix the regression first, then tighten the threshold.

## Scope note

The full Envato-backed fidelity corpus is internal (private); the public
fixtures are sufficient to contribute.
