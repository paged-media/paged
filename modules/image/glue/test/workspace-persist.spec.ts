// @feat: image.editor.workspace
//
// WP5.12 — the workspace is part of the image document (image ADR 474):
// it survives a commit and a reopen with the layers, and a PSD's ruler
// guides (resource 1032, "grid and guides") are read on open and written
// on save — an unedited PSD still writes back byte for byte.

import { describe, expect, it } from "bun:test";

import { createBundleHost } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";
import manifestJson from "@paged-media/image-manifest/manifest.json";

import { createImageSession } from "../src/session";
import {
  makeFakeEditor,
  mapBacking,
  psdBytes,
  shellStub,
  silentConsole,
} from "./helpers";

function open(fake = makeFakeEditor()) {
  const handle = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    { console: silentConsole, storage: mapBacking(), shell: shellStub() },
  );
  const session = createImageSession(handle.host);
  return {
    session,
    dispose() {
      session.dispose();
      handle.dispose();
    },
  };
}

/** The 2×1 PSD of `psdBytes()` with a grid-and-guides resource: version
 *  1, Photoshop's 576 grid cycle, then 1/32-px locations and directions
 *  (0 vertical, 1 horizontal) — the layout Photoshop writes. */
function psdWithGuides(guides: [number, number][]): Uint8Array {
  const base = psdBytes();
  const be32 = (v: number) => [
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ];
  const data = [
    ...be32(1),
    ...be32(576),
    ...be32(576),
    ...be32(guides.length),
    ...guides.flatMap(([loc, dir]) => [...be32(loc), dir]),
  ];
  const pad = data.length % 2 ? [0] : [];
  // 8BIM, id 1032, empty name (2 bytes), size, data, pad.
  const block = [
    0x38,
    0x42,
    0x49,
    0x4d,
    0x04,
    0x08,
    0,
    0,
    ...be32(data.length),
    ...data,
    ...pad,
  ];
  // Header (26) + color-mode length (4); then the resources length.
  const head = Array.from(base.slice(0, 30));
  const tail = Array.from(base.slice(34));
  return Uint8Array.from([...head, ...be32(block.length), ...block, ...tail]);
}

describe("the workspace in the image document", () => {
  it("survives a commit and a reopen with the frame's layers", async () => {
    const fake = makeFakeEditor();
    fake.placed.set("u1", psdBytes());
    fake.geometry.set("u1", {
      id: { kind: "rectangle", id: "u1" },
      pageId: "pg1",
      bounds: [0, 0, 10, 20],
    } as never);
    fake.emitSelection([{ kind: "rectangle", id: "u1" }]);
    const a = open(fake);
    expect(await a.session.ingestSelection()).toBe(true);
    const w = a.session.workspace();
    w.addGuide("vertical", 1);
    w.addCount([0.5, 0.5]);
    w.addNote([1, 0], "dust spot");
    w.addSlice({ x: 0, y: 0, w: 1, h: 1 });
    expect(a.session.state().uncommitted).toBe(true);
    expect(await a.session.commitToDocument()).toBe(true);
    const before = w.state().info;
    a.dispose();

    const b = open(fake);
    expect(await b.session.ingestSelection()).toBe(true);
    expect(b.session.workspace().state().info).toEqual(before);
    b.dispose();
  });

  it("reads a PSD's guides on open, without an undo step", async () => {
    const s = open();
    expect(
      await s.session.importBytes(
        "guides.psd",
        psdWithGuides([
          [32, 0],
          [16, 1],
        ]),
      ),
    ).toBe(true);
    expect(s.session.workspace().state().info.guides).toEqual([
      { orientation: "vertical", position: 1 },
      { orientation: "horizontal", position: 0.5 },
    ]);
    expect(s.session.state().history?.canUndo ?? false).toBe(false);
    s.dispose();
  });

  it("an unedited PSD with guides writes back byte for byte", async () => {
    const bytes = psdWithGuides([[32, 0]]);
    const s = open();
    expect(await s.session.importBytes("guides.psd", bytes)).toBe(true);
    const out = await s.session.psdExportBytes();
    expect(out && Array.from(out.bytes)).toEqual(Array.from(bytes));
    s.dispose();
  });

  it("an edited guide is written to the PSD and read back", async () => {
    const s = open();
    expect(
      await s.session.importBytes("guides.psd", psdWithGuides([[32, 0]])),
    ).toBe(true);
    s.session.workspace().addGuide("horizontal", 0.25);
    const out = await s.session.psdExportBytes();
    expect(out).not.toBeNull();
    s.dispose();

    const back = open();
    expect(await back.session.importBytes("back.psd", out!.bytes)).toBe(true);
    expect(back.session.workspace().state().info.guides).toEqual([
      { orientation: "vertical", position: 1 },
      { orientation: "horizontal", position: 0.25 },
    ]);
    back.dispose();
  });

  it("a PSD without guides gains the record only when guides were added", async () => {
    const s = open();
    expect(await s.session.importBytes("plain.psd", psdBytes())).toBe(true);
    const same = await s.session.psdExportBytes();
    expect(same && Array.from(same.bytes)).toEqual(Array.from(psdBytes()));
    s.session.workspace().addGuide("vertical", 1);
    const out = await s.session.psdExportBytes();
    s.dispose();
    const back = open();
    expect(await back.session.importBytes("back.psd", out!.bytes)).toBe(true);
    expect(back.session.workspace().state().info.guides).toEqual([
      { orientation: "vertical", position: 1 },
    ]);
    back.dispose();
  });
});
