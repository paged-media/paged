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

// Slide ADR 714 — an animated slide as layers: which items are layers, the
// static runs that keep the stacking order, paragraph layers for builds by
// paragraph, and each layer's draw state from the player's states (the
// shape's whole state, then its part's). Pure; no engine.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";

import {
  IDENTITY_STATE,
  splitLayerKey,
  targetId,
  type EffectInfo,
  type LayerState,
} from "../../src/anim/model";
import {
  groupShapes,
  resolveTarget,
  targetOf,
  type PageItem,
  type PageShapes,
} from "../../src/anim/shapes";
import {
  apply,
  drawState,
  planScene,
  stateMatrix,
} from "../../src/show/scene";

const item = (
  kind: string,
  id: string,
  key: string | null,
  z: number,
  box = { x: 100, y: 100, w: 200, h: 100 },
): PageItem => ({ id: { kind, id } as ElementId, key, z, box });

/** A page: a picture, a shape with art and text (key #4), a box above it,
 *  a text box with three paragraphs (#6), a title on top. */
function page(): PageShapes {
  const items = [
    item("rectangle", "pic", "s#2", 0),
    item("polygon", "art4", "s#4", 1),
    item("textFrame", "txt4", "s#4", 2),
    item("polygon", "box5", "s#5", 3),
    item("textFrame", "txt6", "s#6", 4, { x: 50, y: 300, w: 400, h: 150 }),
    item("textFrame", "title", "s#7", 5),
  ];
  return { pageId: "p1", items, shapes: groupShapes(items) };
}

const effect = (
  over: Partial<EffectInfo> & Pick<EffectInfo, "target">,
): EffectInfo => ({
  index: 0,
  paragraph: null,
  bg: false,
  presetClass: "entr",
  presetId: 10,
  presetSubtype: 0,
  name: "Fade",
  start: "click",
  delayMs: 0,
  durationMs: 500,
  repeat: null,
  rewind: false,
  trigger: null,
  clickGroup: 1,
  beginMs: 0,
  endMs: 500,
  editable: true,
  ...over,
});

describe("an animated slide's layers (slide ADR 714) [plugin-slide.animations]", () => {
  it("groups items into shapes by key and resolves a target by item, then key", () => {
    const p = page();
    expect(p.shapes.map((s) => s.key)).toEqual(["s#2", "s#4", "s#5", "s#6", "s#7"]);
    const four = p.shapes[1];
    expect(four.text?.id.id).toBe("txt4");
    expect(four.art.map((a) => a.id.id)).toEqual(["art4"]);
    expect(resolveTarget({ spid: "4", item: "art4" }, p)).toBe(four);
    // A duplicated slide: the item id is stale, the key still finds it.
    expect(resolveTarget({ spid: "4", item: "gone", key: "s#4" }, p)).toBe(four);
    expect(resolveTarget({ spid: "9", item: "gone", key: "s#9" }, p)).toBeNull();
    // An effect added to the text frame names the shape's art.
    expect(targetOf(p, { kind: "textFrame", id: "txt4" } as ElementId)).toEqual({
      spid: "4",
      item: "art4",
      key: "s#4",
    });
  });

  it("puts what lies below the lowest animated item in the background and keeps the order above it", () => {
    const p = page();
    const plan = planScene(p, "p1", [
      effect({ target: { spid: "4", item: "art4", key: "s#4" } }),
      effect({
        target: { spid: "6", item: "txt6", key: "s#6" },
        paragraph: 1,
        index: 1,
      }),
    ]);
    expect(plan.hide.map((i) => i.id)).toEqual(["art4", "txt4", "box5", "txt6", "title"]);
    expect(
      plan.entries.map((e) =>
        e.kind === "static"
          ? `static:${e.items.map((i) => i.id.id).join("+")}`
          : `${e.kind}:${e.item.id.id}`,
      ),
    ).toEqual([
      "item:art4",
      "item:txt4",
      "static:box5",
      "paragraphs:txt6",
      "static:title",
    ]);
    const first = plan.entries[0];
    expect(first.kind === "item" && first.part).toBe("art");
    const second = plan.entries[1];
    expect(second.kind === "item" && second.part).toBe("text");
    expect(plan.boxes["art4"]).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(plan.missing).toEqual([]);
  });

  it("names targets that are not on the page, and the boxes of trigger shapes", () => {
    const plan = planScene(page(), "p1", [
      effect({ target: { spid: "9", key: "s#9" } }),
      effect({
        target: { spid: "4", item: "art4", key: "s#4" },
        trigger: { spid: "7", item: "title", key: "s#7" },
      }),
    ]);
    expect(plan.missing).toEqual(["key:s#9"]);
    expect(Object.keys(plan.triggers)).toEqual(["title"]);
    expect(planScene(page(), "p1", []).entries).toEqual([]);
  });

  it("splits layer keys into a target and its part", () => {
    expect(splitLayerKey("u1")).toEqual({ target: "u1", part: "whole" });
    expect(splitLayerKey("u1#bg")).toEqual({ target: "u1", part: "bg" });
    expect(splitLayerKey("key:s#4#p2")).toEqual({ target: "key:s#4", part: 2 });
    expect(splitLayerKey("u1#c0-4")).toEqual({ target: "u1", part: "whole" });
    expect(targetId({ spid: "4" })).toBe("spid:4");
    expect(targetId({ spid: "4", key: "s#4" })).toBe("key:s#4");
  });
});

describe("a layer's draw state (slide ADR 714) [plugin-slide.animations]", () => {
  const box = { x: 100, y: 100, w: 200, h: 100 };
  const st = (s: Partial<LayerState>): LayerState => ({ ...IDENTITY_STATE, ...s });

  it("turns, scales and moves about the box's centre", () => {
    const m = stateMatrix(st({ rot: 90 }), box);
    const [x, y] = apply(m, 300, 150); // the right edge's middle
    expect(x).toBeCloseTo(200);
    expect(y).toBeCloseTo(250);
    const s = stateMatrix(st({ sx: 2, sy: 2, dx: 10 }), box);
    expect(apply(s, 200, 150)).toEqual([210, 150]); // the centre moves only
    expect(apply(s, 100, 100)).toEqual([10, 50]);
  });

  it("applies the shape's whole state over its part's, and lists both filters", () => {
    const layers: Record<string, LayerState> = {
      u1: st({ dx: 50, opacity: 0.5, mask: { filter: "wipe", sub: "left", progress: 0.3, out: false } }),
      "u1#p0": st({ dy: 20, opacity: 0.5, mask: { filter: "fade", sub: null, progress: 1, out: false } }),
    };
    const para = { x: 100, y: 100, w: 200, h: 20 };
    const d = drawState(layers, "u1", { paragraph: 0 }, { u1: box, "u1#p0": para }, para);
    expect(d.opacity).toBeCloseTo(0.25);
    expect(apply(d.matrix, 0, 0)).toEqual([50, 20]);
    expect(d.masks.map((m) => [m.filter, m.box])).toEqual([
      ["fade", para],
      ["wipe", box],
    ]);
    // A part not shown hides the layer; a static layer is drawn as is.
    const hidden = drawState({ "u1#p0": st({ visible: false }) }, "u1", { paragraph: 0 }, { u1: box }, para);
    expect(hidden.visible).toBe(false);
    expect(drawState({}, null, null, {}, null).matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("recolours art with a fill change and text with a text colour change", () => {
    const layers = { u1: st({ fill: "#ff0000", text: "#00ff00" }) };
    expect(drawState(layers, "u1", "art", { u1: box }, box).tint).toBe("#ff0000");
    expect(drawState(layers, "u1", "text", { u1: box }, box).tint).toBe("#00ff00");
  });
});
