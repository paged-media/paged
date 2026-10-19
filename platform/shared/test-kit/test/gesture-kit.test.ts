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

// The editor-side gesture kit: the shell fake, the fixtures, the
// fuzzer's pieces and the matrix maths.

import { describe, expect, it } from "bun:test";

import { createHeadlessHost } from "@paged-media/plugin-sdk";

import {
  cellId,
  compareDigests,
  createFakeShellEditor,
  expandMatrix,
  gestureFixture,
  GESTURE_TARGETS,
  matrixCoverage,
  matrixModifierKeys,
  sceneElementIds,
  scenePageIds,
  seededRandom,
  storedZip,
  validateMatrix,
  type GeometryDigest,
  type GestureMatrix,
} from "../src/index.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("createFakeShellEditor", () => {
  it("records the typed gesture methods on the gesture channel, with the SAB lane", async () => {
    const fake = createFakeShellEditor({ zoom: 2 });
    const c = fake.shell.client as unknown as {
      beginGesture(n: unknown[], g: unknown, a?: unknown): Promise<number>;
      updateGesture(
        h: number,
        d: [number, number],
        m: unknown,
        mode?: string,
      ): Promise<unknown>;
      commitGesture(h: number): Promise<unknown>;
      cancelGesture(h: number): Promise<unknown>;
      camera: { read(): { scale: number } };
    };
    const h = await c.beginGesture(
      [{ kind: "rectangle", id: "r" }],
      { kind: "rotate" },
      { pageId: "page-1", pointInPage: [1, 2] },
    );
    await c.updateGesture(h, [3, 4], { shift: true, alt: false }, "sab");
    await c.commitGesture(h);
    expect(fake.gestureMessages().map((g) => g.message)).toEqual([
      "beginGesture",
      "updateGesture",
      "commitGesture",
    ]);
    expect(fake.gestureMessages()[0].payload).toMatchObject({ cameraScale: 2 });
    expect(fake.gestureMessages()[1].payload).toMatchObject({
      delta: [3, 4],
      lane: "sab",
    });
    expect(c.camera.read().scale).toBe(2);
    expect(fake.undoDepth()).toBe(1);
  });

  it("serves tool settings, marquee hits, snapshots and the content selection", async () => {
    const fake = createFakeShellEditor({
      toolSettings: { "paged.tool.polygon": { sides: 5 } },
      marqueeHits: () => [{ kind: "polygon", id: "p" }],
      snapshot: (_page, w) => ({
        pngBytes: [1, 2, 3],
        widthPx: w,
        heightPx: w,
      }),
    });
    const s = fake.shell as unknown as {
      toolSettings: { getValue(t: string, k: string): unknown };
      contentSelection: { setContentSelection(v: unknown): void };
      client: {
        marqueeHits(p: string, r: number[]): Promise<unknown[]>;
        requestSnapshot(p: string, w: number): Promise<{ widthPx: number }>;
      };
    };
    expect(s.toolSettings.getValue("paged.tool.polygon", "sides")).toBe(5);
    fake.setToolSetting("paged.tool.polygon", "sides", 7);
    expect(s.toolSettings.getValue("paged.tool.polygon", "sides")).toBe(7);
    expect(await s.client.marqueeHits("page-1", [0, 0, 1, 1])).toEqual([
      { kind: "polygon", id: "p" },
    ]);
    expect((await s.client.requestSnapshot("page-1", 64)).widthPx).toBe(64);
    s.contentSelection.setContentSelection({ storyId: "s", start: 0, end: 0 });
    expect(fake.contentSelection()).toEqual({ storyId: "s", start: 0, end: 0 });
    expect(fake.ofChannel("extra")).toHaveLength(1);
  });
});

describe("the gesture fixtures", () => {
  it("are stored ZIPs whose first entry is the IDML mimetype", () => {
    const zip = storedZip([{ name: "mimetype", data: "x" }]);
    expect(new TextDecoder().decode(zip.slice(30, 38))).toBe("mimetype");
    for (const name of ["targets", "paths", "dense"] as const) {
      const bytes = gestureFixture(name);
      expect(new TextDecoder().decode(bytes.slice(38, 38 + 43))).toBe(
        "application/vnd.adobe.indesign-idml-package",
      );
      // Deterministic bytes.
      expect(gestureFixture(name)).toEqual(bytes);
    }
  });

  it("load in the engine with every target type where the kit says it is", async () => {
    const h = await createHeadlessHost({ console: silent });
    try {
      await h.load(gestureFixture("targets"));
      const send = (
        h.host.editor as unknown as {
          client: { send: (m: never) => Promise<never> };
        }
      ).client.send;
      expect(await scenePageIds(send as never)).toEqual([
        GESTURE_TARGETS.pageId,
        GESTURE_TARGETS.secondPageId,
      ]);
      const ids = (await sceneElementIds(send as never)).map(
        (id) => `${id.kind}:${String(id.id)}`,
      );
      expect(ids).toEqual([
        "rectangle:uframe",
        "group:ugroup",
        "rectangle:ugA",
        "oval:ugB",
        "rectangle:urot",
        "rectangle:ulock",
        "polygon:upath",
        "rectangle:up2frame",
      ]);
      const geo = (
        await h.host.document.elementGeometry([
          GESTURE_TARGETS.rotated.id as never,
        ])
      )[0];
      expect(geo.itemTransform).toEqual([...GESTURE_TARGETS.rotated.transform]);
      for (const name of ["paths", "dense"] as const) {
        await h.load(gestureFixture(name));
        expect((await sceneElementIds(send as never)).length).toBeGreaterThan(
          5,
        );
      }
    } finally {
      h.dispose();
    }
  });
});

describe("the fuzzer's pieces", () => {
  it("seededRandom is deterministic, seed-distinct and uniform-ish", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(seededRandom(8)()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("compareDigests: corners as a set; precision drift vs a move; missing elements", () => {
    const d = (
      corners: Array<[number, number]>,
      magnitude = 400,
    ): GeometryDigest => new Map([["rectangle:r", { corners, magnitude }]]);
    const box: Array<[number, number]> = [
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
    ];
    expect(
      compareDigests(d(box), d([...box.slice(2), ...box.slice(0, 2)])),
    ).toBeNull();
    expect(
      compareDigests(
        d(box),
        d(box.map(([x, y]) => [x + 0.02, y] as [number, number])),
      )?.verdict,
    ).toBe("precision");
    expect(
      compareDigests(
        d(box),
        d(box.map(([x, y]) => [x + 3, y] as [number, number])),
      )?.verdict,
    ).toBe("moved");
    expect(compareDigests(d(box), new Map())?.verdict).toBe("missing");
  });
});

describe("the gesture matrix", () => {
  const M: GestureMatrix = {
    version: 1,
    dragPx: [120, 80],
    tools: [
      {
        tool: "t.rect",
        rows: [
          {
            mods: "*",
            target: "*",
            expect: { creates: "rectangle", shape: "box" },
          },
          {
            mods: "shift",
            target: "*",
            expect: { creates: "rectangle", shape: "square" },
          },
          {
            mods: "shift",
            target: "locked",
            zooms: [4],
            expect: { unchanged: "refused" },
            known: "X-1",
          },
        ],
      },
      { tool: "t.hand", unspecified: "the camera, not the document" },
    ],
  };

  it("expands most-specific-row-first, zoom-aware", () => {
    const cells = expandMatrix(M);
    const at = (mods: string, zoom: number, target: string) =>
      cells.find(
        (c) =>
          c.tool === "t.rect" &&
          c.mods === mods &&
          c.zoom === zoom &&
          c.target === target,
      )!;
    expect(at("none", 1, "frame").expect).toEqual({
      creates: "rectangle",
      shape: "box",
    });
    expect(at("shift", 1, "frame").expect).toEqual({
      creates: "rectangle",
      shape: "square",
    });
    expect(at("shift", 4, "locked")).toMatchObject({
      expect: { unchanged: "refused" },
      known: "X-1",
    });
    expect(at("shift", 1, "locked").expect).toEqual({
      creates: "rectangle",
      shape: "square",
    });
    expect(cellId(at("shift", 0.25, "group"))).toBe(
      "t.rect shift @25% on group",
    );
    expect(matrixModifierKeys("shift+alt")).toEqual(["shift", "alt"]);
  });

  it("counts coverage against the registry: missing and stale tools, unspecified cells", () => {
    const c = matrixCoverage(M, ["t.rect", "t.hand", "t.new"]);
    expect(c.cells).toBe(3 * 5 * 3 * 6);
    expect(c.specified).toBe(90);
    expect(c.knownFailing).toBe(1);
    expect(c.missingTools).toEqual(["t.new"]);
    expect(matrixCoverage(M, ["t.rect"]).staleTools).toEqual(["t.hand"]);
  });

  it("validates the table", () => {
    expect(validateMatrix(M)).toBe(M);
    expect(() =>
      validateMatrix({ ...M, tools: [...M.tools, M.tools[0]] }),
    ).toThrow(/twice/);
    expect(() => validateMatrix({ ...M, tools: [{ tool: "x" }] })).toThrow(
      /unspecified/,
    );
    expect(() =>
      validateMatrix({
        ...M,
        tools: [
          {
            tool: "x",
            rows: [
              {
                mods: "hyper" as never,
                target: "*",
                expect: { unchanged: "refused" },
              },
            ],
          },
        ],
      }),
    ).toThrow(/modifier/);
  });
});
