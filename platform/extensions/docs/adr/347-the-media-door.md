# ADR 347 — The media door

- **Status:** Accepted 2026-10-30.
- **Scope:** `MediaSurface`, `MediaRead`, `MediaStoreOptions` and `BundleHost.media` in
  `packages/plugin-api/src/host.ts`; `MediaItem`, `MediaKind`, `MediaPlay`, `MediaSource`
  re-exported from the vendored wire; the door and the flag `document.media@1` in
  `packages/plugin-sdk/src/host-impl.ts`. Contract C6 of the PowerPoint parity program (slide
  ADR 711). Builds on engine ADR 1027.

## Context

Engine ADR 1027 gives the document movie and sound frames: a poster the engine draws and a
medium it does not play. A slide show must play the medium over the frame. It needs the
medium's bytes or URL, and, to insert a video, a way to keep new media in the document.

The frame's description is already readable and writable through the property doors
(`frameMedia`). The bytes are a container part, but `host.parts` confines a bundle to its own
namespace, and media live in the engine's shared folder (`paged/core/media/`) so that one
module's movie plays in another's presentation.

The overlay itself needs no door: a presentation surface (ADR 345) is the bundle's own DOM, and
its frames come from the page layers (ADR 346), which already leave items out (`hideItems`).

## Decision

- **`host.media.read(id)`** answers `{ media, bytes, url }` for a movie or sound frame: its
  `frameMedia` and, for a part, its bytes (read by the full path; the engine serves any
  `paged/` part for reading), for a link, its URL. `null` for a frame without a medium (or an
  engine without the path). Gated on `capabilities.document.read`.
- **`host.media.store(bytes, { mime, kind? })`** writes the bytes to
  `paged/core/media/<first 128 bits of their SHA-256>.<ext>` (the extension from the media
  type) and answers the source a `frameMedia` write names: `{ type: "part", path }`. The engine
  keeps the folder write-once, so storing the same bytes again answers the same path and no
  bundle can change a stored medium. Like `host.parts`, it is not undoable; the frame's write
  is. Gated on `capabilities.document.write`.
- **Playing is the bundle's.** It plays the medium in its own `<video>` / `<audio>` element on
  its presentation surface, laid over the frame; to hide a frame while its medium does not
  play, it leaves the frame out of the layers it draws (`hideItems`, ADR 346).
- **Static flag** `document.media@1`, like `document.imageAdjustments@1`: `frameMedia` is
  additive at protocol 78, so an older engine reads no row (`read` answers `null`) and refuses
  the write.

## Consequences

- paged.slide's show, presenter view and video export play media through this door (slide ADR
  718).
- A module that only reads the description (a panel) uses the property doors and needs no
  bytes.

## Related

- [ADR 345](345-presentations-and-module-views.md) — the presentation surface.
- [ADR 346](346-page-layers.md) — the frames a presentation draws.
