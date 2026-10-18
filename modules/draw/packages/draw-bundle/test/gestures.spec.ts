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

// paged.draw's tools, driven event by event through the gesture DSL —
// the B-13 residual ("gesture REPLAY") closed: the real bundle is
// activated through the real host adapter over the test kit's recording
// fake editor, each tool is mounted BY ID from the registry the bundle
// filled, and the assertions read what it published (overlay previews)
// and what it sent (mutations).

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { loadBundle } from "@paged-media/plugin-sdk";
import {
  commitsSince,
  createFakeEditor,
  expectNoCommit,
  flattenMutation,
  gestures,
  type FakeEditorOptions,
} from "@paged-media/test-kit";

import { drawBundle } from "../src";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

const PATH = { kind: "polygon", id: "p1" } as ElementId;
const SQUARE = {
  id: PATH,
  pageId: "page-1",
  anchors: [
    [100, 100],
    [300, 100],
    [300, 300],
    [100, 300],
  ].map((p) => ({ anchor: p, left: p, right: p })),
  subpathStarts: [0],
  subpathOpen: [false],
  itemTransform: null,
};

function drawHarness(options: FakeEditorOptions = {}) {
  const fake = createFakeEditor({
    selection: [PATH],
    hitTest: () => PATH,
    pathAnchors: (id) => (id.id === "p1" ? (SQUARE as never) : null),
    geometry: (id) =>
      id.id === "p1"
        ? {
            id,
            pageId: "page-1",
            bounds: [100, 100, 300, 300],
            itemTransform: null,
          }
        : null,
    ...options,
  });
  loadBundle(() => fake.editor, drawBundle, {
    console: silent,
    storage: mapBacking(),
  });
  return { fake, g: gestures(fake) };
}

describe("paged.draw tools through the gesture DSL", () => {
  it("Add Anchor: a click on a segment of the path inserts ONE anchor there (one batch) @level:gesture", async () => {
    const { fake, g } = drawHarness();
    const mark = fake.mark();
    await g.tool("addAnchor").click([200, 100]).settle();
    const s = commitsSince(fake, mark);
    expect(s.applied).toHaveLength(1);
    const leaf = flattenMutation(s.applied[0].mutation).find(
      (m) => m.op === "pathPointInsert",
    );
    expect(leaf).toMatchObject({
      op: "pathPointInsert",
      args: { elementId: PATH, index: 1 },
    });
  });

  it("Delete Anchor: a click on an anchor removes it; a click far from every anchor sends nothing @level:gesture", async () => {
    const { fake, g } = drawHarness();
    await g.tool("deleteAnchor").click([500, 500]).settle();
    expect(fake.mutations()).toEqual([]);
    await g.click([300, 301]).settle();
    expect(fake.mutations()).toEqual([
      { op: "pathPointRemove", args: { elementId: PATH, index: 2 } },
    ]);
  });

  it("the pick radius is screen-constant: 10 pt off an anchor removes it at 25% zoom, not at 100% @level:gesture", async () => {
    for (const [zoom, n] of [
      [0.25, 1],
      [1, 0],
    ] as const) {
      const { fake, g } = drawHarness({ zoom });
      await g.tool("deleteAnchor").click([310, 310]).settle();
      expect(fake.mutations()).toHaveLength(n);
    }
  });

  it("Measure: a drag publishes the line and its readout in ONE multi-shape preview, and changes nothing @level:gesture", async () => {
    const { fake, g } = drawHarness({ hitTest: () => null });
    await g
      .tool("measure")
      .drag({ from: [100, 100], to: [400, 500] })
      .settle();
    const shown = fake.previews().filter(Array.isArray).at(-1) as Array<
      Record<string, unknown>
    >;
    expect(shown).toHaveLength(2);
    expect(shown[1]).toMatchObject({
      kind: "text",
      text: "500.00 pt · 53.1°",
      anchor: "middle",
    });
    expect(fake.mutations()).toEqual([]);
  });

  it("Pencil: a freehand drag commits ONE path; Escape mid-stroke commits nothing @level:gesture", async () => {
    const { fake, g } = drawHarness({ hitTest: () => null, selection: [] });
    let mark = fake.mark();
    await g
      .tool("media.paged.draw.tool.pencil")
      .drag({ from: [100, 100], to: [300, 220], via: [[200, 120]], steps: 6 })
      .settle();
    const s = commitsSince(fake, mark);
    expect(s.applied).toHaveLength(1);
    expect(
      flattenMutation(s.applied[0].mutation).some((m) => m.op === "insertPath"),
    ).toBe(true);
    mark = fake.mark();
    await g
      .drag({ from: [100, 100], to: [300, 220], release: false })
      .cancel()
      .up()
      .settle();
    expectNoCommit(fake, mark);
  });

  const warn = console.warn;
  for (const id of [
    "addAnchor",
    "deleteAnchor",
    "convertAnchor",
    "curvature",
    "pencil",
    "gradientAnnotator",
    "measure",
    "shapeBuilder",
    "cornerRadius",
    "paintbrush",
    "blobBrush",
    "eraserBrush",
    "eyedropper",
    "width",
    "lassoSelect",
    "livePaintBucket",
    "livePaintSelect",
    "typeOnPath",
    "repeat",
    "knife",
    "scissorsAnyPoint",
  ]) {
    it(`media.paged.draw.tool.${id}: the gesture battery (≤ 1 commit a gesture; Escape commits nothing; no throw) @level:gesture`, async () => {
      const { fake, g } = drawHarness();
      console.warn = () => {};
      try {
        await g.tool(`media.paged.draw.tool.${id}`).settle();
        let mark = fake.mark();
        await g
          .drag({ from: [120, 120], to: [280, 260] })
          .key("Enter")
          .settle();
        const one = commitsSince(fake, mark);
        expect(one.applied.length + one.committed.length).toBeLessThanOrEqual(
          1,
        );
        mark = fake.mark();
        await g
          .drag({ from: [150, 150], to: [250, 250], release: false })
          .settle()
          .cancel()
          .up()
          .settle();
        expectNoCommit(fake, mark, `${id} cancelled`);
        await g
          .click([200, 100])
          .settle()
          .dblclick([200, 300])
          .settle()
          .key("Escape")
          .settle();
      } finally {
        console.warn = warn;
      }
    });
  }
});
