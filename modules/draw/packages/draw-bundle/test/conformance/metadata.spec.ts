// Conformance — plugin metadata persistence across mutate + undo. The
// draw bundle stamps a leaf's `x-paged:media.paged.draw` envelope (e.g.
// which anchor tool last touched it); this proves the envelope survives
// unrelated edits and undo, through the REAL v34 metadata carrier.
//
// SHARP EDGE (wire limit, a real finding — present through protocol
// v35, the currently-vendored stamp): the metadata carrier round-trips
// on `<Rectangle>` leaves but NOT on `<Polygon>` — a `setMetadata` on a
// polygon reports `applied:true` yet `getMetadata` reads back `null`
// (the engine accepts the write but the read accessor doesn't surface
// it for the polygon kind). The rectangle is therefore the corpus's
// metadata carrier; the polygon limitation is asserted below as a
// pinned-gap test so a future engine fix fails THIS test loudly (the
// signal to move the polygon onto the round-trip path above).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as const;
const POLY = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! } as const;

describe("draw conformance — metadata persistence", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("write → read round-trips this plugin's envelope on a rectangle", async () => {
    const env = { v: 1, data: { tool: "addAnchor", at: [175, 500] } };
    const set = await h.host.document.setMetadata(RECT as never, env);
    expect(set.applied).toBe(true);
    expect(await h.host.document.getMetadata(RECT as never)).toEqual(env);
    // Clear for the next test.
    await h.host.document.setMetadata(RECT as never, null);
    expect(await h.host.document.getMetadata(RECT as never)).toBeNull();
  });

  it("the envelope survives an unrelated mutate (other element)", async () => {
    const env = { v: 1, data: { tool: "convertAnchor" } };
    await h.host.document.setMetadata(RECT as never, env);
    // Insert an unrelated frame on the page — the rectangle's metadata
    // must be untouched.
    const out = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [10, 10, 60, 60] },
    } as never);
    expect(out.applied).toBe(true);
    expect(await h.host.document.getMetadata(RECT as never)).toEqual(env);
    await h.host.document.undo(); // remove the frame
    await h.host.document.setMetadata(RECT as never, null);
  });

  it("setMetadata is undoable (set → undo clears it)", async () => {
    const env = { v: 1, data: { tool: "deleteAnchor" } };
    await h.host.document.setMetadata(RECT as never, env);
    expect(await h.host.document.getMetadata(RECT as never)).toEqual(env);
    await h.host.document.undo();
    expect(await h.host.document.getMetadata(RECT as never)).toBeNull();
  });

  it("the metadata namespace gate still bites on a foreign key", async () => {
    // A raw setPluginMetadata for ANOTHER plugin's namespace is refused
    // at the SDK door before the engine sees it (same gate as in-process,
    // proven headless — B-16's SDK-side enforcement).
    const out = await h.host.document.mutate({
      op: "setPluginMetadata",
      args: {
        elementId: RECT,
        key: "x-paged:media.paged.other",
        value: '{"v":1,"data":{}}',
      },
    } as never);
    expect(out.applied).toBe(false);
    expect(await h.host.document.getMetadata(RECT as never)).toBeNull();
  });

  it("polygon metadata round-trips (read accessor fixed in the engine)", async () => {
    // The earlier wire gap — a polygon metadata write applied but read
    // back null — is GONE: the engine's element_properties gained the
    // Polygon/GraphicLine arms (core af54c7c, ships in the 0.36.0 wire
    // the bundle now targets), so the polygon read accessor returns the
    // envelope and the polygon joins the rectangle on the full
    // round-trip + undo path.
    const env = { v: 1, data: { tool: "addAnchor" } };
    const set = await h.host.document.setMetadata(POLY as never, env);
    expect(set.applied).toBe(true);
    expect(await h.host.document.getMetadata(POLY as never)).toEqual(env);
    await h.host.document.undo();
    expect(await h.host.document.getMetadata(POLY as never)).toBeNull();
  });
});
