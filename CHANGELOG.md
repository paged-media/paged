# Changelog

Notable changes to Paged: the engine, the built-in modules, the editor, the server and the
four npm packages (`@paged-media/paged`, `@paged-media/viewer`, `@paged-media/editor`,
`@paged-media/plugin-sdk`), which share one version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
`0.<protocol>.<patch>`: the minor is the engine's wire protocol
([PM-0008](docs/adr/PM-0008-npm-packages-and-release.md)).

Releases before this file was started are described in the
[GitHub releases](https://github.com/paged-media/paged/releases); their history is not
repeated here.

## [Unreleased]

### Added

- **Viewer:** two-finger pinch zoom and one-finger pan on touch screens (`input.pinchZoom`);
  `viewer.resize()` and `viewer.registerFont()`; `contentBounds`; a camelCase session
  surface (`ViewerSessionApi`, `adaptSession`), which `createViewer` accepts beside the
  wasm's own names.
- **Extension SDK:** a README for `@paged-media/plugin-sdk`; `explainApiMismatch` and
  `API_GENERATION_RANGE`; the API version reference
  (`platform/extensions/docs/reference/api-version.md`).
- **`@paged-media/paged`:** `THIRD-PARTY-NOTICES.md`, the Rust crates in the engine wasm
  with their licence texts, generated when the package is assembled.
- **Engine:** a golden native part per format version; a sweep that runs every mutation
  through apply, undo and redo with a scene integrity check.
- **Sheet:** a formula depth limit.
- `SECURITY.md`, this changelog, and a record of the prebuilt PDFium binary
  (`modules/publish/packages/pdf-bundle/bin/PDFIUM.md`).

### Changed

- **Extension SDK:** `API_VERSION` is `0.<generation>.<revision>` and moves with the
  contract (it was `0.2.0` throughout). A manifest's `"^0.2"` loads as before;
  `"^0.2.<n>"` is refused by a host older than revision `n`, and the refusal says which
  side has to move.
- **Extension SDK:** `@types/react` is an optional peer dependency (`>=19.3`), no longer a
  dependency. A TypeScript project installs it itself; `paged-plugin init` adds it to the
  extension it writes.
- **Extension SDK:** `paged-plugin modules-upload` exits 1 when an artifact is not hosted
  and no token is set, where it exited 0 having uploaded nothing.
- **Command line:** plugin bundles load only on request (`--plugins a,b`, `--plugins auto`
  or `PAGED_PLUGINS`), no longer from whatever is installed in the current directory.
  Saves are atomic, and JSON output carries no stack traces.
- **Viewer:** the viewer follows the canvas's size and the device pixel ratio and presents
  again; pages are placed at their x origin, so the pages of a spread sit side by side.
- **Editor:** keyboard shortcuts resolve by keyboard layout; the locale follows the
  browser; a panel or dialog that fails no longer takes the editor with it; a refused
  mutation is reported.
- **Sheet:** a non-finite result is `#NUM!`; names and case folding work in every script;
  F4 leaves function names alone.

### Deprecated

- **Viewer:** the snake_case members of `ViewerSessionLike` (`register_font`, `page_count`,
  `set_page`, `page_layout`, `render_to_canvas_main`, `render_page_to_bytes`) for direct
  calls; use `adaptSession(session)` or the viewer's methods. They stay for as long as the
  wasm exports them.
- **Extension SDK:** `host.editor`, the raw editor handle, is tagged `@deprecated`: it is
  not part of the contract an extension can build on.

### Fixed

- **Viewer:** a `load` that resolves after `dispose()`, or after a later `load` started, no
  longer touches the session; overlapping loads bind the canvas once.
- **Engine:** a native part that cannot be read is refused or reported, never silently
  replaced; undo keeps its record when a replay fails; 18 mutation cases found by the
  sweep (table lines, layer removal, sections, text on a path, endnotes, flags and effect
  bags).
- **IDML:** references are decoded once on import and escaped once on export; edited
  swatches are written.
- **Editor:** a restored checkpoint is discarded only after the new one is written;
  library saves hold a lock across tabs; an engine trap is fatal instead of leaving a
  half-working editor.
- **`@paged-media/paged`:** the README's code fences and its description of plugin loading.

### Security

- **Parsers:** limits on counts, spans, nesting and dimensions read from a file (charts,
  slide and Word tables, the OOXML tree, PSD, PostScript, DXF, data expressions, image
  layers).
- **IDML:** package reads have a budget, and link names cannot leave the package.
- **ML host:** a per-launch token is required, and no program path is taken over HTTP.
- **Server:** sealing uses a random nonce; OAuth asks for consent and matches redirect
  URIs exactly; repository writes need membership.
- **Web module:** the sanitizer repeats to a fixed point, and the preview has a Content
  Security Policy.
- **Releases:** deploys wait for the commit's checks, and workflow actions are pinned by
  commit.

[Unreleased]: https://github.com/paged-media/paged/commits/main
