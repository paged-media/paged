# Paged

Paged is a page-layout platform: an IDML render engine, an editor, and the
built-in modules for images, vector drawing, spreadsheets, data publishing,
Word, PowerPoint, HTML and PDF. This repository holds all of it at one revision.

| Path | What it is |
|---|---|
| `engine/core` | Rust render engine: IDML parsing, composition, GPU rendering, WASM interfaces |
| `modules/*` | Built-in modules: `image`, `draw`, `sheet`, `data`, `doc`, `slide`, `web`, `publish` |
| `platform/extensions` | The extension contract and SDK (`plugin-api`, `plugin-sdk`, `plugin-cli`) |
| `apps/editor` | The editor application |
| `apps/server` | paged.server, the optional remote for repository-backed documents |
| `tooling/` | Repository tooling, including the import that assembled this repository |

Each directory keeps its own README, docs and build instructions. The
repository was assembled from the former per-component repositories with their
history; see [`tooling/import/`](./tooling/import/) for exactly what was
imported and how.

License: AGPL-3.0-only OR LicenseRef-PMEL — see [`LICENSE.md`](./LICENSE.md).
