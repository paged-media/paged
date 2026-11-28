# CLAUDE.md — apps/cli (paged-node)

`apps/cli` of the monorepo `paged-media/paged`: the Node command line over the headless
host (`@paged-media/cli`, private; bin `paged-node`). On npm it ships as the `paged` bin of
`@paged-media/paged`, bundled by `scripts/bundle.mjs` (PM-0008, amendment 3). Its decision
record is `platform/extensions/docs/adr/324-node-cli-over-the-headless-host.md`, with its
amendments; `paged mcp` mirrors the Rust `paged mcp` of `engine/core/crates/paged-mcp`.

## Rules

- **Plugin bundles load only on request** (`src/plugins.ts`): none by default,
  `--plugins a,b`, `--plugins auto`, or `PAGED_PLUGINS`. A bundle is code that runs with the
  caller's rights; do not bring back loading by directory.
- The bin is `paged-node` in the repository, so it does not shadow the engine's Rust `paged`.
- The verbs come from one table (`src/verbs.ts`), which also generates `--help`.

## Commands

```bash
bun run typecheck && bun run test    # in apps/cli; the tests need the engine wasm (moon run core:wasm-pkg)
bun run build                        # dist/bin.js, the paged-node bin
moon run cli:test
(cd ../../packages/paged && bun run build)   # the published package, assembled
```
