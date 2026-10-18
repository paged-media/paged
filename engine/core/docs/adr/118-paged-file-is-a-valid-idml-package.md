# ADR 118 — A `.paged` file is a ZIP that stays a valid IDML package

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `9f933f1`.
- **Scope:** the container-parts door and load path in `crates/paged-canvas`, `crates/paged-store`, and the container writer in `plugin-publish: crates/idml-export`

## Context

Plugins persist their own data with a document. The note for protocol 51 gives the reason
for putting it inside the file: parts written into the container "travel with the `.paged`
file, unlike per-browser OPFS blob storage" (`crates/paged-canvas/src/channel.rs:334-336`).

The container writer states the rule the file obeys and what it buys. Extra parts "ride
alongside as ZIP entries UNREFERENCED by `designmap.xml` (the EPUB/ODF private-parts idiom —
InDesign ignores them on open)", and the mimetype "stays the Adobe IDML magic so InDesign
opens the file" (`plugin-publish: crates/idml-export/src/paged.rs:21-25`, `:160-163`).
[ADR 021](021-paged-native-document-model-idml-as-format.md) set the direction of a
container of native parts; this record describes the shape that is shipped.

## Decision

A `.paged` file is a ZIP that is a structurally valid IDML package. Everything Paged adds
is either under the `paged/` prefix or the top-level `manifest.json`.

- **Layout.** `mimetype` (the Adobe IDML value) is the first entry, stored. The IDML parts
  follow. Plugin parts live at `paged/<plugin>/…`; `paged/core/` is the engine's own
  namespace. `designmap.xml` references none of them.
- **`manifest.json`.** Written on every container save: `v`, `format: "paged-container"`,
  `pagedProtocol`, `idmlPartsHash` (FNV-1a 64 over the IDML parts), `domVersion`, and
  `parts`, an index of every `paged/` entry with its plugin, byte length and hash. Keys the
  writer does not own are kept.
- **The parts door.** `WritePagedPart`, `ReadPagedPart`, `ListPagedParts` and `ExportPaged`
  (protocol 51). The model keeps written parts as an overlay on the loaded archive. A
  write outside `paged/` is refused; with a named `caller` it is confined to
  `paged/<caller>/`. Reads and lists never serve IDML parts or the manifest.
- **The model part.** `paged-store` serialises the document model to
  `paged/core/model/document.pgm`, a JSON envelope `{format_version, model}` at version 3.
  `export_paged` adds a fresh one on each save. On load the part wins; when it is absent,
  unparseable or of another version, the IDML parts are imported instead.
- **Which half lives where.** The engine owns the parts door, the load order and the model
  codec. The writer `write_paged`, the manifest and the constants `PAGED_PREFIX` and
  `MANIFEST_NAME` are in `plugin-publish`'s `idml-export`, which the engine links at a
  pinned revision. `paged_store::package::wrap_document` is a second writer, for documents
  with no IDML source: the model part plus a one-page IDML skeleton.

## Evidence

- `crates/paged-canvas/src/channel.rs:331-339` — protocol 51: the four messages, "valid IDML + the paged/ parts + manifest.json"
- `crates/paged-canvas/src/model.rs:4604-4626` — the `paged/` and per-caller checks; `:4628-4661` read and list; `:4663-4686` `export_paged` embeds the model part and calls `idml_export::write_paged`
- `crates/paged-canvas/src/model.rs:1524-1564` — the load order: native part, else IDML import
- `crates/paged-store/src/lib.rs:40`, `:58`, `:76-98` — the part path, `PGM_FORMAT_VERSION = 3`, the envelope and `None` on mismatch
- `crates/paged-store/src/package.rs:19-27`, `:147-167` — `wrap_document`: the fallback skeleton and the entries it writes
- `plugin-publish: crates/idml-export/src/paged.rs:53-65`, `:86-109`, `:179-190`, `:204-284` — prefix and manifest name, the parts hash, the manifest fields, `write_paged`
- `plugin-publish: crates/idml-export/src/lib.rs:329-349` — one writer for `.idml` and `.paged`; the `.idml` product drops the container parts
- `crates/paged-canvas/Cargo.toml:35` — `idml-export` as a git dependency at revision `a88315d`

## Alternatives considered

- A mimetype of its own: not chosen. Paged "detects its own identity by this part + the
  `paged/` namespace, never by the mimetype" (`plugin-publish: crates/idml-export/src/paged.rs:160-163`).
- A binary model codec: "a deferred optimization"; JSON was taken "for now (inspectable,
  wasm-clean, matching the `document.pgd` precedent)" (`crates/paged-store/src/lib.rs:30-31`).

## Consequences

A `.paged` file carries the document twice: the IDML parts and the model part. The comment
there calls it a "Transitional cost" that goes away "when IDML leaves core"
(`crates/paged-canvas/src/model.rs:4672-4675`); the IDML code has since moved to
`plugin-publish` and both copies are still written. Inline image bytes are fields of the
model and are serialised inside the JSON model part; no separate image part exists.

Any change to the model's serde shape must raise `PGM_FORMAT_VERSION`; older files then
open through their IDML parts. With a model part adopted, the loader still reads
`Resources/Styles.xml` to fill missing style leading (`crates/paged-canvas/src/model.rs:9908-9916`).

The manifest is written but not read. No code in this repository or in `plugin-publish`
reads `idmlPartsHash` or `manifest.json` on load, so the data-loss guard the writer
describes has no read side, and a file whose IDML parts were changed while the model part
was kept opens from the model part. `wrap_document` writes no `manifest.json`.

The caller check is "an HONESTY AID", "not a security boundary": a write that names no
caller bypasses it (`crates/paged-canvas/src/model.rs:4593-4597`).
`crates/paged-store/src/lib.rs:23-24` still describes the raw IDML bytes as a skipped field
of the model; `Document` has no such field, and the loader keeps the source archive beside
the model (`crates/paged-canvas/src/model.rs:1530-1531`).

## Related

- [ADR 021](021-paged-native-document-model-idml-as-format.md) — the direction; [ADR 022](https://github.com/paged-media/plugin-publish/blob/main/docs/adr/022-idml-relocates-to-plugin-publish.md) — why the writer is in `plugin-publish`
- [ADR 650](https://github.com/paged-media/plugin-publish/blob/main/docs/adr/650-mutual-git-revision-pins.md) — the mutual revision pins; [ADR 007](007-carry-through-rendering-honesty.md) — carry-through on save
- `../reference/paged-file-format.md` — the format note the writer cites
