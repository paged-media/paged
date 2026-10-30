/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// TYPE LAYERS (WP5.10) through the session, over the real image-js wasm:
// a Photoshop text layer opens as editable type, the type tool makes point
// and box type, an edit re-renders through `host.render.story` and each
// editing session is one undo step, the panels restyle the layer, and
// Rasterize / Paint text into layer keep the pixels lanes. The engine's
// layout itself is the fake editor's stand-in (test/helpers.ts); the real
// one is asserted in engine/core (snapshot_story.rs) and plugin-sdk
// (render-story.spec.ts).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { createBundleHost } from "@paged-media/plugin-sdk";
import type {
  ElementGeometryItem,
  PluginManifest,
} from "@paged-media/plugin-api";

import manifestJson from "@paged-media/image-manifest/manifest.json";

import { createImageSession } from "../src/session";
import { layoutBox, storyOf, type TypeSource } from "../src/type-layer";
import { typeAt } from "../src/type-tool";
import { covers } from "@paged-media/test-kit";

import { bundleOnFake, C, PANEL_ID } from "./command-kit";
import {
  makeFakeEditor,
  mapBacking,
  shellStub,
  silentConsole,
} from "./helpers";

const FIXTURE = new URL(
  "../../image-conformance/fixtures/photoshop/text-layers/black-on-white.psd",
  import.meta.url,
);

async function open() {
  const fake = makeFakeEditor();
  fake.placed.set("u1", new Uint8Array(readFileSync(FIXTURE)));
  fake.geometry.set("u1", {
    id: { kind: "rectangle", id: "u1" } as never,
    pageId: "pg1",
    bounds: [0, 0, 64, 160],
  } as ElementGeometryItem);
  fake.emitSelection([{ kind: "rectangle", id: "u1" }]);
  const handle = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    { console: silentConsole, storage: mapBacking(), shell: shellStub() },
  );
  const session = createImageSession(handle.host);
  expect(await session.ingestSelection()).toBe(true);
  return { session, fake, handle };
}

const typeRows = (s: ReturnType<typeof createImageSession>) =>
  s.state().layers.layers.filter((l) => l.kind === "type");

describe("type layers [image.layers.type]", () => {
  it("opens Photoshop's text layer as editable type", async () => {
    const { session } = await open();
    const [row] = typeRows(session);
    expect(row).toBeDefined();
    const src = session.typeLayerSource(row!.index)!;
    expect(src.text).toBe("Ragged 0123");
    expect(src.frame).toEqual({ kind: "point", x: 4, y: 40 });
    expect(src.runs[0]!.font).toBe("Myriad Pro");
    expect(src.runs[0]!.size).toBe(22);
  });

  it("an edit re-renders through the engine, and a session is one undo step", async () => {
    const { session, fake } = await open();
    const index = typeRows(session)[0]!.index;
    expect(session.beginTypeEdit(index)).toBe(true);
    const sid = session.state().typeEdit!.session;
    // Node has no GPU: the composite after each write declines, the layer
    // changes regardless (what is asserted below).
    await session.setTypeEditText("Ragged 01234");
    await session.setTypeEditText("Edited");
    expect(session.state().typeEdit!.session).toBe(sid);
    session.endTypeEdit();
    expect(session.state().typeEdit).toBeNull();
    expect(session.typeLayerSource(index)!.text).toBe("Edited");
    // The story the engine laid out: the text in the run's face, at the
    // run's size (canvas px = pt at k = 1), first baseline on the anchor.
    const story = fake.stories.at(-1) as ReturnType<typeof storyOf>;
    expect(story.paragraphs[0]!.runs[0]!.text).toBe("Edited");
    expect(story.paragraphs[0]!.runs[0]!.font).toBe("Myriad Pro");
    expect(story.paragraphs[0]!.runs[0]!.pointSize).toBe(22);
    expect(story.firstBaseline).toBeGreaterThan(0);
    // Both writes of the session undo together.
    await session.undo();
    expect(session.typeLayerSource(index)!.text).toBe("Ragged 0123");
  });

  it("the type tool makes point type on a click and box type on a drag", async () => {
    const { session, fake } = await open();
    // The PSD's own text covers most of this small canvas: make it pixels
    // so a click lands on empty canvas.
    await session.rasterizeLayer(typeRows(session)[0]!.index);
    const before = typeRows(session).length;
    const point = await typeAt(session, [100, 20], [100, 20]);
    expect(point).not.toBeNull();
    expect(typeRows(session).length).toBe(before + 1);
    const p = session.typeLayerSource(point!)!;
    expect(p.frame).toEqual({ kind: "point", x: 100, y: 20 });
    expect(session.state().typeEdit?.index).toBe(point!);

    const box = await typeAt(session, [10, 5], [70, 45]);
    const b = session.typeLayerSource(box!)!;
    expect(b.frame).toEqual({
      kind: "box",
      x: 10,
      y: 5,
      width: 60,
      height: 40,
    });
    // Box type wraps at its width: the story's frame is the box.
    const story = fake.stories.at(-1) as ReturnType<typeof storyOf>;
    expect(story.bounds).toEqual([0, 0, 40, 60]);
    expect(story.firstBaseline).toBeUndefined();

    // A click on existing text edits it instead of adding a layer.
    const n = typeRows(session).length;
    const hit = await typeAt(session, [101, 18], [101, 18]);
    expect(typeRows(session).length).toBe(n);
    expect(hit).toBe(point);
    expect(session.state().typeEdit?.index).toBe(hit!);
  });

  it("the Character and Paragraph settings restyle the active type layer", async () => {
    const { session } = await open();
    const index = typeRows(session)[0]!.index;
    session.setActiveLayer(index);
    session.setType({ sizePx: 30, align: "center", family: "Inter" });
    // The edit is asynchronous: wait for the write.
    for (
      let i = 0;
      i < 50 && session.typeLayerSource(index)!.runs[0]!.size !== 30;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const src = session.typeLayerSource(index)!;
    expect(src.runs[0]!.size).toBe(30);
    expect(src.runs[0]!.font).toBe("Inter");
    expect(src.runs[0]!.postscript).toBeNull();
    expect(src.paragraphs[0]!.align).toBe("center");
  });

  it("Rasterize makes pixels; Warp Text without a GPU says so", async () => {
    const { session } = await open();
    const index = typeRows(session)[0]!.index;
    session.setActiveLayer(index);
    const warped = await session.setTypeWarp({
      style: "arc",
      bend: 0.5,
      horizontal: 0,
      vertical: 0,
    });
    if (!session.state().gpu) {
      expect(warped).toBe(false);
      expect(session.state().status).toContain("GPU");
    }
    await session.rasterizeLayer(index);
    expect(session.typeLayerSource(index)).toBeNull();
  });
});

describe("type layer layout", () => {
  const src = (frame: TypeSource["frame"], align = "left"): TypeSource => ({
    text: "Hello\nWorld",
    runs: [{ length: 11, font: "Inter", size: 20, color: [0, 0, 0] }],
    paragraphs: [{ align: align as never }],
    frame,
    warp: { style: "none", bend: 0, horizontal: 0, vertical: 0 },
  });

  it("puts point type's anchor on the alignment point of the first baseline", () => {
    const left = layoutBox(src({ kind: "point", x: 100, y: 50 }));
    expect(left.left).toBe(100);
    expect(left.top + left.firstBaseline!).toBe(50);
    const centre = layoutBox(src({ kind: "point", x: 100, y: 50 }, "center"));
    expect(centre.left + centre.width / 2).toBe(100);
    const right = layoutBox(src({ kind: "point", x: 100, y: 50 }, "right"));
    expect(right.left + right.width).toBe(100);
  });

  it("splits runs at paragraph marks and scales lengths by k", () => {
    const s = src({ kind: "box", x: 0, y: 0, width: 4000, height: 100 });
    const story = storyOf(s, 4);
    expect(story.bounds).toEqual([0, 0, 25, 1000]);
    expect(story.paragraphs.map((p) => p.runs.map((r) => r.text))).toEqual([
      ["Hello"],
      ["World"],
    ]);
    expect(story.paragraphs[0]!.runs[0]!.pointSize).toBe(5);
  });
});

describe("the Type commands [image.layers.type]", () => {
  async function onTextLayer() {
    const k = await bundleOnFake();
    k.fake.placed.set("u1", new Uint8Array(readFileSync(FIXTURE)));
    await k.ingest();
    return k;
  }

  it("rasterizeType turns the active type layer into pixels, as one undo step", async () => {
    covers("command:media.paged.image.command.rasterizeType");
    const k = await onTextLayer();
    const index = typeRows(k.session)[0]!.index;
    k.session.setActiveLayer(index);
    await k.run(`${C}.rasterizeType`);
    expect(k.session.typeLayerSource(index)).toBeNull();
    await k.session.undo();
    expect(k.session.typeLayerSource(index)?.text).toBe("Ragged 0123");
    k.dispose();
  });

  it("rasterizeType leaves a pixel layer alone", async () => {
    const k = await onTextLayer();
    k.session.setActiveLayer(0);
    const before = k.session.state().layers.layers.map((l) => l.kind);
    await k.run(`${C}.rasterizeType`);
    expect(k.session.state().layers.layers.map((l) => l.kind)).toEqual(before);
    k.dispose();
  });

  it("warpText raises the Image panel, where the Warp text section is", async () => {
    covers("command:media.paged.image.command.warpText");
    const k = await onTextLayer();
    await k.run(`${C}.warpText`);
    expect(k.opened).toContain(PANEL_ID);
    k.dispose();
  });

  it("paintTextIntoLayer paints the Type section's text as pixels into the active layer", async () => {
    covers("command:media.paged.image.command.paintTextIntoLayer");
    const k = await onTextLayer();
    const asked: unknown[] = [];
    const original = k.session.paintText;
    (k.session as { paintText: typeof original }).paintText = async (...a) => {
      asked.push(a);
      return true;
    };
    k.session.setActiveLayer(0);
    k.session.setType({ text: "Hi", family: "Test", sizePx: 20 });
    await k.run(`${C}.paintTextIntoLayer`);
    // No type-tool click yet: the image centre (160 × 64).
    expect(asked).toEqual([[[80, 32], "Hi", "Test", 20]]);
    k.dispose();
  });
});
