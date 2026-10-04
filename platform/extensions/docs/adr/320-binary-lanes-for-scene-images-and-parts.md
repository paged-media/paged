# ADR 320 — Scene images and container parts cross as bytes; the SDK keeps the JSON fallback

- **Status:** Accepted, 2026-10-04. Targets engine protocol 66.
- **Scope:** `SceneLayerSurface.submitImage` / `submitImageTiles`, `PartsSurface.delete`,
  the optional `PagedEditor.sceneLayers.submitImage` / `submitImageTiles` and
  `PagedEditor.parts` channels, and the `rendering.sceneLayer.binary@1` and
  `storage.parts@2` flags.

## Context

Until protocol 65 every byte a plugin handed the engine travelled inside a JSON message. A
scene layer's image item carried its pixels as `number[]`
(`packages/plugin-api/src/wire.d.ts`, `SceneItem` `kind: "image"`), and `host.parts`
converted every part with `Array.from(bytes)` before `client.send`. A raster plugin that
previews a brush stroke resubmitted the whole image per pointer sample, so each sample cost
a copy into a JavaScript array, a JSON string roughly eight times the pixel size, and a parse
on the worker side, for a change that covered a few dozen pixels.

The engine already had a binary precedent: the editor loads documents through a transfer
list to a direct wasm export instead of the JSON channel. Protocol 66 adds the same kind of
export for one scene image, for tiles that patch it in place, for part bytes, and adds a
`deletePagedPart` message. A part could be written, read and listed, but never removed, so
a plugin that keeps revisions in the container could only grow it.

## Decision

- `SceneLayerSurface` gains `submitImage(elementId, image, options?)` and
  `submitImageTiles(elementId, tiles, options?)`. An image is RGBA8 with a destination
  rectangle in frame-content points; a tile is a rectangle in image pixels. Tiles patch the
  image the same surface last submitted for that element. A malformed image, a tile outside
  it, or a wrong byte count rejects the whole call before anything is sent.
- `options.transfer: true` hands the buffers to the host, which may detach them. The default
  copies, so a bundle that reuses its buffer is not surprised.
- The bundle calls the same methods on every host. Where the host wires both binary members
  of `PagedEditor.sceneLayers`, the SDK uses them and `rendering.sceneLayer.binary@1` is
  true. Otherwise the SDK keeps its own copy of the image, patches tiles into that copy and
  resubmits the whole image through `submit` as an `image` item. The fallback lives in the
  SDK, not in each plugin.
- `PartsSurface.delete(path)` resolves whether the part existed. It uses
  `PagedEditor.parts` when the host wires it and the `deletePagedPart` message otherwise;
  `write` and `read` take the binary lane on the same condition. Paths stay relative to the
  plugin's own subtree and the adapter names the caller to the engine, as for writes.
  `storage.parts@2` is static, because the pinned engine answers the message.

## Consequences

- A raster preview pays for the pixels it changed, not for the image, on a host with the
  binary lane; on an older host it pays what it paid before, plus one copy the SDK holds.
- The engine invalidates only the pages that show the frame for a binary submission and
  reports them, so a host can repaint those pages' tiles rather than every page.
- A deleted part that the loaded file already carried is left out of the next save; it does
  not return from the source container.
- Both new `PagedEditor` members are optional, so a host that has not adopted them stays
  assignable to the contract.

## Related

- [ADR 302](302-vendored-wire-types.md) — the wire types these doors use are vendored per protocol.
- [ADR 305](305-doors-always-present.md) — the doors exist on every host; the flags report the lane.
- [ADR 311](311-plugin-state-under-own-id.md) — parts stay under the plugin's own id.
