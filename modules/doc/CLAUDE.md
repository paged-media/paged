# CLAUDE.md — paged-media/plugin-doc

Orientation for Claude sessions in **paged-media/plugin-doc** — the paged.doc
Word/DOCX subsystem, delivered as a Paged plugin (dual-licensed AGPL-3.0-only OR
PMEL, And The Next GmbH, as is the shared `paged-ooxml` crate).

## What this is

A Rust/WASM engine that makes Microsoft Word **`.docx`** a first-class Paged
content type, in two symmetric modes — **embedded** (a `.docx` in a frame of a
host layout) and **standalone** (open a whole `.docx` as the canvas). The central
bet: **lower DOCX onto the engine's NATIVE text + flow stack** (native
stories/paragraphs/runs + styles), not onto a forked layout engine — because
WordprocessingML is the same styled-paragraphs-of-runs model the engine already
implements for IDML. DOCX is parsed/re-serialized through a shared **`paged-ooxml`**
foundation over the vendored **`ooxmlsdk`** crate.

Spec (the concept authority): [`docs/concept.md`](docs/concept.md) (kept IN
this repo — it is self-documenting). Architecture: [`docs/architecture.md`](docs/architecture.md).
Status/milestones: [`docs/status.md`](docs/status.md).

**STATUS: M0 foundation + M1 Tier-0 read path shipped** (green). Rust crates
(Cargo workspace, top level; the OOXML foundation `paged-ooxml` — OPC with its memory
budget + carry-through + ooxmlsdk typed DOM — is `platform/shared/ooxml`, shared with
slide and sheet, ADR 607): `docx-core` (frozen semantic WML view), `docx-import` (WML → docx-core),
`docx-lower` (docx-core → Lowered IR), `docx-js` (wasm-bindgen surface),
`docx-rtf` (RTF → docx-core) and `docx-odt` (OpenDocument → docx-core, doc ADR 616),
`docx-conformance` (TEST-ONLY). TS packages (`packages/*`): `doc-host-model` (pure
IR → Mutation[]) + `doc-bundle` (`@paged-media/doc`: manifest + `activate`).

## Project State & Feature Matrix (cockpit)

The feature inventory, test linkage and live status for ALL Paged repos are derived by
[Cockpit](https://github.com/drietsch/cockpit) from `~/paged/cockpit/` (`cockpit.toml` with
`root = ".."`; features in `cockpit/docs/features/<chapter>/<id>.md`). There is NO feature
matrix in this repo; do not create one.

Rules for every code change in this repo:

1. NEW CAPABILITY → feature file. If your change adds or completes a feature, add or update
   `cockpit/docs/features/<chapter>/<id>.md` (separate commit in `paged/cockpit`, referenced
   from this one). Feature ids are immutable; rename with `superseded_by`.
2. EVERY NEW TEST → feature link. Playwright: `{ tag: ['@feat:<id>'] }`. Rust: a test name
   ending in `__feat__<id_with_underscores>` or containing `[<id>]`. Otherwise an entry in
   `cockpit/test-map.yaml`.
3. STATUS CHANGE → `claims:` in the feature file, never prose. "X is now shipped/partial" is a
   claim edit; whether it _works_ is computed from evidence and cannot be written.
4. BEFORE claiming a feature done: `cockpit feature <id> --json` (or its page in
   `cockpit serve`) — done means the linked tests are green and were produced after the
   latest implementation commit.
5. `cockpit validate --strict` is the gate (references resolve, required evidence present and
   fresh). `cockpit pull` fetches the newest CI artifacts; `cockpit status` is the summary.
6. FOUND A BUG while working? If a test exposes it, let it fail and push — the failure shows
   up as attention on its feature. Never commit `.cockpit/`.

## Hard rules (this repo's constitution)

- **ALL DOCX SEMANTICS LIVE IN RUST.** OPC parsing, WordprocessingML mapping,
  native lowering, preservation, and save-back are `paged-ooxml` + `docx-*` crates
  compiled to ONE wasm module (`docx-js`). The TS packages are thin glue: bundle
  lifecycle, panel, file input, and translating the engine's already-computed
  Lowered IR into host mutations. **Never implement a DOCX operation in
  TypeScript** — if the bundle seems to need one, the missing piece is a `docx-js`
  API.
- **ISOLATION CONTRACT, built-in form (PM-0002).** Zero inter-plugin contact:
  the TS packages depend only on `plugin-api`, `plugin-sdk`, `platform/shared/*`
  and published contracts — never another plugin, not at build time, runtime, or
  via side channels. In Rust ONE crate reaches the engine: `docx-skeleton` builds
  the standalone-open skeleton with the engine's model crates (`paged-model`,
  `paged-scene`, `paged-store`, path dependencies at the same commit, ADR 606).
  Everything else stays engine-free: `docx-lower` is pure model→IR with **no
  core dependency**, and the open document is reached only through the host
  (`host.document.mutate`, `host.nativeDocument.open`). Rust guard: `deny.toml`
  `[sources]`. TS guard: the contract-import lint rule (`/bunfig.toml`, PM-0003).
  SDK gaps become RFI entries, not engine changes made from here.
- **PURE LOWERING.** `docx-lower` is pure `docx-core → LoweredDoc`;
  `doc-host-model` is pure `LoweredDoc → Mutation[]`. Every behavior change lands
  with a test.
- **PRESERVATION INVARIANT.** "Paged never destroys a document." Unknown parts +
  unknown subtrees survive re-emission byte-identical; understood-but-untouched
  parts re-emit original bytes (lazy-verbatim). Zero-edit round-trip is per-part
  byte-identical (decompressed).
- **HONEST DEGRADATION (ADR-007).** Constructs past the current tier are surfaced
  as diagnostics on open, never silently dropped or faked.
- **LICENSE.** Every crate, `paged-ooxml` included, is AGPL-3.0-only OR PMEL
  (the workspace default; ADR PM-0001) and every `.rs` and TS file carries the
  AGPL/PMEL header block. `paged-ooxml` was MPL-2.0 OR PMEL before the relicense.
- **ooxmlsdk is pinned** (0.12, in `platform/shared/ooxml/Cargo.toml`, behind that
  crate's `dom` feature; the DuckDB-WASM / Blitz posture): treat upstream as a
  starting point; be ready to carry patches. OPC/carry-through is
  ALWAYS our own `zip`+`quick-xml` — never trust `ooxmlsdk` for byte-exact fidelity.

## Commands

```bash
moon run doc:test     # Rust (nextest + doctests) and the bundle glue, from anywhere
# Rust (the engine) without Moon
cargo build --workspace && cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cargo deny check

# wasm artifact (100 MB app wasm budget; lands in packages/doc-bundle/bin/)
bash scripts/build-wasm.sh

# TS (the bundle) — consumes the PUBLISHED @paged-media canaries (no link chain)
bun install && bun run typecheck && bun run test
bun run validate:manifest
```
