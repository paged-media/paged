# @paged-media/paged

The paged engine, as wasm-bindgen modules for the browser and Node, and the `paged` command
line over it. One package, three entry points, each its own wasm module, so a page loads
only the one it imports:

| Import                          | What it is                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@paged-media/paged`            | The editing canvas the editor's render worker runs: the wire types, the document model and WebGPU rendering.                                                                              |
| `@paged-media/paged/introspect` | The engine's read-only introspection (`Inspector`). `@paged-media/paged/introspect/catalog.json` is the static capability catalog; `describeCatalog()` returns the same data at run time. |
| `@paged-media/paged/repo`       | The document repository (`Repository`): a document kept as versions, branches and releases in packs its host stores. It has no engine and no wire.                                        |

Each entry's wasm is importable on its own (`…/paged_canvas_wasm_bg.wasm`,
`…/introspect/paged_introspect_wasm_bg.wasm`, `…/repo/paged_repo_wasm_bg.wasm`), for bundlers
that take a wasm URL:

```ts
import init, { Repository } from "@paged-media/paged/repo";
import repoWasmUrl from "@paged-media/paged/repo/paged_repo_wasm_bg.wasm?url";

await init({ module_or_path: repoWasmUrl });
```

To show a document read-only, `@paged-media/viewer` is the small package: the renderer
alone, without editing, scripting or introspection. To write an extension,
`@paged-media/plugin-sdk`.

## The `paged` command

```sh
npx paged --help
npx paged get brochure.idml 'swatch[name=Black]'
npx paged set brochure.idml page:#1 itemName Cover -o out.paged
npx paged export brochure.idml -o brochure.pdf
```

The verbs read and write any property core or an installed plugin bundle publishes, run
scripts, and export (`.paged`, `.idml`, `.pdf`).

Text a document sets in a face that is not given is set in **Inter**, which the package
ships (`fonts/Inter.ttf`, SIL Open Font License 1.1 in `fonts/OFL-inter.txt`), the face core's
Rust `paged` bundles: `--font <file.ttf>` names another fallback, `--no-default-font` goes
without one (text no font answers for is then not set, and the run says so). For PDF/X,
`--cmyk-profile <file.icc>` gives the CMYK working space and output intent:

````sh
npx paged export brochure.idml -o print.pdf --pdf-standard pdfx4 --cmyk-profile CoatedFOGRA39.icc
``` It is the program the repository calls
`paged-node` (`apps/cli`), bundled into `dist/paged.js` with its first-party modules and the
third-party code it uses (`dist/THIRD-PARTY-NOTICES.md`), so it needs nothing but this
package: Node 22 or later, or Bun. Its engine is this package's wasm.

### `paged mcp`: the engine for agents

`paged mcp` is an MCP server over stdio (one JSON-RPC message per line), for Claude Desktop,
Claude Code or any MCP client, with nothing deployed:

```json
{
  "mcpServers": {
    "paged": { "command": "npx", "args": ["-y", "@paged-media/paged", "mcp"] }
  }
}
````

It serves the tools of the engine's Rust `paged mcp`, with the same names and schemas: a
library of documents on disk (`--library <dir>`, default `$PAGED_LIBRARY`, else
`~/.paged/library`, the layout the Rust `paged library` writes), each a repository of
versions and branches (`list_documents`, `describe_document`, `read_part`, `history`,
`diff`, `create_branch`, `commit_parts`, `propose_change`, `list_changes`,
`download_link`); the engine run here (`open_document`, `run_script` with `paged.*`
scripts, `render_page` as a PNG, `save_document`); and `lookup_api` over the capability
catalog. An agent's writes land on `agent/<run>/…` branches with provenance, for the
library's owner to merge.

Plugin bundles are found where the command runs: `--plugins <a,b>` loads those, otherwise
every installed dependency of the current directory's `package.json` that declares a paged
manifest. The built-in modules (sheet, draw, image, data, …) are part of the editor and are
not on npm, so `apply` and `merge`, which need the paged.data module (and DuckDB-WASM, 34 MiB),
report that it is not loaded.

## Version

`0.<protocol>.<patch>`: the minor is the engine's wire protocol (`PROTOCOL_VERSION` in
`engine/core/crates/paged-canvas/src/channel.rs`). A release tag `v0.<protocol>.<patch>`
publishes it. It replaces `@paged-media/canvas-wasm` (and the older `introspect-wasm`), which
stay on npm at their last versions, deprecated.

## In the repository

The engine's files are built into the workspace package `engine/core/packages/canvas-wasm`
(private; about a hundred files in the repository import it under that name), and the CLI
lives in `apps/cli`. This directory holds the published package's `package.json`, this
README and the licence files; `bun run build` (`scripts/assemble.mjs`) copies the engine's
built files here and bundles the CLI into `dist/`. Build the engine first:

```sh
moon run core:wasm-pkg
(cd packages/paged && bun run build)
```

Why one package carries the engine and the command line, and why the viewer stays its own:
[PM-0008, amendment 3](https://github.com/paged-media/paged/blob/main/docs/adr/PM-0008-npm-packages-and-release.md).

## Licence

`AGPL-3.0-only OR LicenseRef-PMEL`; see [LICENSE.md](./LICENSE.md). The third-party code
bundled into `dist/paged.js` keeps its own licences (`dist/THIRD-PARTY-NOTICES.md`).
