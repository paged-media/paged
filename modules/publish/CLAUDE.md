# CLAUDE.md — modules/publish (paged.publish, paged.pdf)

`modules/publish` of the monorepo `paged-media/paged` (the `paged-media/plugin-publish`
repository until 2026-10-18): the foreign-format publishing bundles, a built-in module
(PM-0017). Dual-licensed AGPL-3.0-only OR PMEL. Read [`README.md`](README.md) and
[`docs/`](docs/README.md) (concept, architecture, status, ADRs 650–699 and 022) first.

## Layout

- `packages/publish-bundle` (`@paged-media/publish`) — IDML open/save, PDF export, preflight.
- `packages/pdf-bundle` (`@paged-media/pdf`) — PDF open and place. `bin/` holds its
  `pdf-import` wasm (build output) and the committed prebuilt PDFium
  (`bin/PDFIUM.md` records its origin and what is not known about it).
- `crates/pdf-import` — the PDF IR → document mapper, a member of `engine/core`'s Cargo
  workspace. The IDML reader and writer are engine crates
  (`engine/core/crates/idml-import`, `idml-export`).

Both bundles are private workspace packages, built into the editor (PM-0008).

## Commands

```bash
moon run publish:test            # Rust (nextest + doctests), wasm, then bun test
moon run publish:rust-check && moon run publish:rust-lint   # cargo, in engine/core, -p pdf-import
moon run publish:wasm            # the pdf-import wasm into packages/pdf-bundle/bin/
(cd packages/pdf-bundle && bun run typecheck && bun run test)
```

There is no `Cargo.toml` here: run cargo in `engine/core` with `-p pdf-import`.
