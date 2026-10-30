# ADR 1027 — Movie and sound items

- **Status:** Accepted 2026-10-30.
- **Scope:** protocol v78 (additive; no bump). `paged-model` (`media`: `MediaItem`,
  `MediaKind`, `MediaSource`, `MediaPlay`, the `media` field of `Rectangle`, the label helpers,
  `MEDIA_PART_PREFIX`); `paged-mutate` (`PropertyPath::FrameMedia`, `Value::Media`);
  `paged-introspect` (the `frameMedia` row); `paged-canvas` (the rectangle's property read, the
  media folder's write rule in `set_paged_part_as`, `export_losses.rs`); `paged-store`
  (`media_part_path`, `package::wrap_document_with_parts`); `idml-import` and `idml-export`
  (the label). The slide side is slide ADR 718, the contract extensions ADR 347.

## Context

PowerPoint decks carry video and audio, InDesign documents carry `<Movie>` and `<Sound>` items.
Both are the same shape: a frame that shows a poster where it is printed and plays a medium
where the document is presented. The engine dropped them: paged.slide imported the poster as a
plain picture and lost the medium, so a deck that played a video exported without it.

The engine renders print, PDF, thumbnails and the canvas. It does not present, and a media
player in the engine (decoders, audio, a clock) would duplicate what every browser has.

## Decision

**A movie or sound is a rectangle with a medium.** `Rectangle.media: Option<MediaItem>`. The
frame's placed picture is the poster; it is all the engine draws, in every output. `MediaItem`
holds:

| field | meaning |
|---|---|
| `kind` | `movie` or `sound` |
| `source` | `{ type: "part", path }` (a container part under `paged/`) or `{ type: "link", uri }` |
| `mime`, `name`, `durationMs` | what the medium is, when known |
| `trimStartMs`, `trimEndMs` | trimmed off the start and the end |
| `fadeInMs`, `fadeOutMs` | fades |
| `play` | `onClick` (default) or `auto` |
| `loop`, `volume` (0..1), `hideWhileNotPlaying`, `rewind`, `fullScreen`, `showControls` | how it plays |

The field is `#[serde(default, skip_serializing_if = "Option::is_none")]` and every default is
left out: a frame without a medium serialises as before and the state hash (ADR 195) is
unchanged. `PGM_FORMAT_VERSION` does not move.

**The bytes are never in the model.** A medium is large and an edit to a frame (its volume, its
place) must not copy it, so the model holds a reference. A part travels with the `.paged` file,
the repository stores it like every part (ADR 180), and a slide duplicated with its movie
shares the part.

**The media folder.** `paged/core/media/` is shared and write-once: any caller may add a part
there (a movie inserted by one module plays in another's presentation), none may change one
(`set_paged_part_as` refuses other bytes for a path that is held; the same bytes are a no-op).
A part is named by its content: `paged_store::media_part_path` (BLAKE3, as the model's image
blobs are) for the Rust writers, the SHA-256 of the media door (extensions ADR 347) in the
browser. `package::wrap_document_with_parts` lets an importer write the parts into the
package it builds.

**The wire.** `PropertyPath::FrameMedia` (`frame.media`, the catalog's `frameMedia`, a
`MediaItem` structure) carries the medium as `Value::Media` (`{ type: "media", value }`, `null`
for none) on a Rectangle. Range-checked (`MediaItem::is_valid`: a part path under `paged/`
without `..`, a link that is not empty, a volume in 0..=1, trims and fades up to a day; out of
range is `InvalidValue`). Paint-only. The inverse carries the medium it replaced, so undo
restores it exactly (ADR 197). A new path and a new value variant are additive (governance
rule 1): protocol v78 stays.

**IDML.** `idml-import` parses no `<Movie>` or `<Sound>`, so there is nothing to round-trip
from InDesign. A paged movie is written as the picture frame of its poster, with the medium's
JSON in a `paged:media` label the import reads back onto the frame; `idml_export_losses` names
each one (InDesign shows the poster; a part medium travels only in a `.paged` file).

**Playing is the host's.** A presentation reads the medium (extensions ADR 347) and plays it in
its own media element over the frame.

## Consequences

- A medium removed from every frame leaves its part in the container until a later clean-up.
- A frame pasted into another document loses a part medium (the part stays behind); a link
  medium travels.
- `Oval` and `Polygon` carry no medium: both PowerPoint and InDesign place media in rectangles.

## Evidence

- `crates/paged-model/src/media.rs`: the JSON form, defaults left out, range refusals, the label
  round trip, part names.
- `crates/paged-mutate/src/lib.rs` (`frame_media_round_trip`): set, paint-only, inverse,
  refusals.
- `crates/paged-canvas/tests/it/media.rs`: read, write, undo, redo through the canvas model;
  the poster drawn; the IDML label, its loss line and the round trip; the `.paged` round trip
  with its part; the write-once media folder.
- `crates/paged-store/tests/it/media.rs`: the model field, the content name, the package parts.

Tests are named `*__feat__plugin_slide_media`.
