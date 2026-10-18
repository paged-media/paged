# PM-0001 — One public repository, under AGPL-3.0-only OR PMEL

- **Status:** Accepted 2026-10-18.
- **Scope:** the whole repository: its layout, its home, `LICENSE`, `LICENSE.md`, every source
  file's licence notice, every `license` field in a `Cargo.toml` or `package.json`, the licence
  files shipped in published packages, and the `deny.toml` licence policies.

## Context

Paged was developed in twelve repositories: the engine, eight modules, the extension SDK, the
editor and its server. They depended on each other through git revisions and npm canaries, so one
change across them took a publish and a re-pin in each.

They were also licensed differently. All of them offered the Paged Media Enterprise License
(PMEL), the commercial option from And The Next GmbH, but the open-source option split:

| Former repository | Open-source option |
|---|---|
| core (the engine), plugin-publish, plugin-sdk (the extension SDK) | MPL-2.0 |
| editor, editor-server, plugin-image, plugin-draw, plugin-sheets, plugin-data, plugin-doc, plugin-slide, plugin-web | AGPL-3.0-only |

The split did not hold at file level either. The Word module's `paged-ooxml` crate, and the slide
module's vendored copy of it, overrode their AGPL workspaces with MPL. The image and sheet crates
carried two notices, AGPL and MPL, one above the other. The editor's vendored copy of the SDK's
`ai` package carried the MPL notice inside an AGPL repository. In one repository that boundary
would run through directories and through single files.

## Decision

- **Scope.** One repository holds the engine, the modules, the extension SDK, the editor and the
  server at one revision:

  | Directory | What it is | Former repository |
  |---|---|---|
  | `engine/core` | Rust render engine: IDML parsing, composition, GPU rendering, WASM interfaces | core |
  | `modules/{publish,image,draw,sheet,data,doc,slide,web}` | Built-in modules | plugin-publish, plugin-image, plugin-draw, plugin-sheets, plugin-data, plugin-doc, plugin-slide, plugin-web |
  | `platform/extensions` | The extension contract and SDK | plugin-sdk |
  | `apps/editor` | The editor application | editor |
  | `apps/server` | paged.server, the optional remote for repository-backed documents | editor-server (`server/`, `docs/` and licence files only) |
  | `tooling/` | Repository tooling, including the import | — |
  | `docs/` | Records that concern the whole repository: these ADRs, the migration notes | — |

  Each was imported with its history (ADR PM-0010 records how). The fidelity corpus, licensed
  fonts and colour profiles are not part of the repository; the code reaches them as optional
  resources (`docs/migration/path-rewiring.md`).
- **Home.** `paged-media/paged` on GitHub, public, default branch `main`. The former repositories
  are frozen at the final import and archived once this repository's CI covers what theirs did
  (PM-0010).
- **Licence.** Every first-party file is dual-licensed **AGPL-3.0-only OR the Paged Media
  Enterprise License (PMEL)**, `SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`:
  - every source file carries one notice, the AGPL OR PMEL one (the text is in any source file's
    header);
  - every `license` field says `AGPL-3.0-only OR LicenseRef-PMEL`;
  - the root `LICENSE` holds the AGPL-3.0 text and `LICENSE.md` the dual-licence statement; the
    former MPL directories keep a `LICENSE.md` that points there;
  - every published npm package ships its own `LICENSE` (the AGPL-3.0 text) and `LICENSE.md`.
- **Who may relicense.** And The Next GmbH holds the copyright in all first-party code. That code
  has a single human author, and contributions come in under the CLA (`CLA.md`), which lets And
  The Next GmbH distribute them under both licences. So the copyright holder can offer the former
  MPL code under new terms.
- **Earlier releases.** Everything released under `MPL-2.0 OR LicenseRef-PMEL` before the
  relicense (the engine's tags `v0.N.P`, the npm versions of `@paged-media/canvas-wasm`,
  `introspect-wasm`, `repo-wasm`, `sdk`, `idml-viewer`, `plugin-api`, `plugin-sdk`, `plugin-cli` and
  the other packages from those repositories) stays available under those terms. The MPL grant
  for them cannot be withdrawn and is not. The relicense applies from the relicense commit on.
- **Third-party material** keeps its own licence: fonts under the SIL Open Font License,
  spreadsheet fixtures derived from Apache POI, the hyphenation patterns, vendored binaries such
  as DuckDB-WASM and PDFium, each with the licence files next to it.
- **Dependencies** stay permissive. Because the work ships under the commercial PMEL as well as
  the AGPL, no dependency may be GPL or AGPL. Each `deny.toml` allows permissive licences and
  MPL-2.0 (weak, file-level copyleft), and LicenseRef-PMEL for first-party crates reached from
  another workspace or by git revision; a workspace's own unpublished crates are not checked
  against the dependency policy (`[licenses.private] ignore = true`).
- **Open item.** `LicenseRef-PMEL` names the Paged Media Enterprise License. Its legal text is
  not yet published; writing and publishing it is for the copyright holder.

## Consequences

- One licence covers the tree. A change across the engine and the editor no longer crosses a
  licence boundary, and no file carries two notices.
- The engine, the viewer and the SDK are no longer available under a file-level copyleft licence
  for new versions. Embedding them in a closed-source or hosted product takes the PMEL; under
  MPL-2.0 it did not. Consumers of versions published before the relicense keep the MPL terms
  for those versions.
- New source files take the AGPL OR PMEL notice; there is no second header to choose from.
- The notice is four lines longer than the MPL one, so every line of the rewritten files moved;
  file-and-line citations in the documentation were moved with them.
- The relicense commits, counts and checks are recorded in `docs/migration/relicense.md`.
