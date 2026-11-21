# Paged

**Paged is an open platform for professional page layout and programmable
publishing.** Design magazines, catalogues and reports in the browser, work
with InDesign documents through IDML, and run the same engine from the command
line to render and export print-ready PDF. Features and their release state
vary; the [capability record](https://docs.paged.media/state/) says what is
stable, what is experimental and what is planned.

- See a real publication: [The Paged Annual](https://paged.media/library/)
- Try the editor: [play.paged.media](https://play.paged.media)
- Understand IDML compatibility: [Coming from InDesign](https://paged.media/indesign/)
- Run the command line: [CLI reference](https://docs.paged.media/cli/)
- Build an extension: [plugin SDK](https://docs.paged.media/plugin-sdk/)
- Evaluate commercial licensing: [paged.media/enterprise](https://paged.media/enterprise/)

This repository holds all of it at one revision: an IDML render engine, the
editor, and the built-in modules for images, vector drawing, spreadsheets, data
publishing, Word, PowerPoint, HTML and PDF.

| Path                  | What it is                                                                              |
| --------------------- | --------------------------------------------------------------------------------------- |
| `engine/core`         | Rust render engine: IDML parsing, composition, GPU rendering, WASM interfaces           |
| `modules/*`           | Built-in modules: `image`, `draw`, `sheet`, `data`, `doc`, `slide`, `web`, `publish`    |
| `platform/extensions` | The extension contract and SDK (`plugin-api`, `plugin-sdk` with the `paged-plugin` bin) |
| `apps/editor`         | The editor application                                                                  |
| `apps/server`         | paged.server, the optional remote for repository-backed documents                       |
| `tooling/`            | Repository tooling, including the import that assembled this repository                 |

Each directory keeps its own README, docs and build instructions. The
repository was assembled from the former per-component repositories with their
history; see [`tooling/import/`](./tooling/import/) for exactly what was
imported and how.

License: AGPL-3.0-only OR LicenseRef-PMEL — see [`LICENSE.md`](./LICENSE.md).
