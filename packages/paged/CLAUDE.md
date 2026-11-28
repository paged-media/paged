# CLAUDE.md — packages/paged (@paged-media/paged)

The published engine package (PM-0008, amendment 3). This directory holds only its
`package.json`, README, licence files and `scripts/`; everything else here is build output
(`.gitignore`), assembled by `bun run build` (`scripts/assemble.mjs`) from two private
workspace packages:

- the engine wasm of `engine/core/packages/canvas-wasm` (build it first:
  `moon run core:wasm-pkg`), copied unchanged;
- the `paged` bin, `apps/cli` bundled into `dist/paged.js`, with the JavaScript notices in
  `dist/THIRD-PARTY-NOTICES.md`;
- the default face, `fonts/Inter.ttf` with its licence;
- `THIRD-PARTY-NOTICES.md`, the Rust crates in the wasm with their licence texts
  (`scripts/third-party-notices.mjs`, from the engine's `Cargo.lock`; needs cargo).

## Rules

- A file the package ships is listed in `package.json` `files`; `assemble.mjs` fails when one
  is missing, and `tooling/release/verify-tarballs.mjs` checks the tarball.
- The committed version is `0.<protocol>.0-dev`, held to the engine's `PROTOCOL_VERSION`; a
  release tag sets the published version (`tooling/release/stage.mjs`).
- It depends on no private package.

## Commands

```bash
moon run core:wasm-pkg && bun run build         # assemble
bun scripts/third-party-notices.mjs --list      # the crates the wasm is built from
```
