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

// The engine's gesture channel, asserted through the MODEL (headless
// engine, the editor's wasm): the transform maths as properties
// (fast-check, fixed seeds), and the fuzzer's findings as regression
// tests that fail today and flip when the engine is fixed.

import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import fc from "fast-check";

import type {
  ElementId,
  MainToWorkerKind,
  WorkerToMain,
} from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import {
  checkCancel,
  checkUndoRedo,
  compareDigests,
  engineModelChannel,
  geometryDigest,
  gestureFixture,
  GESTURE_TARGETS as T,
  sceneElementIds,
  type ModelChannel,
} from "../src/index.ts";

type Send = (m: MainToWorkerKind) => Promise<WorkerToMain>;
type Pt = [number, number];
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const NO_SNAP = { shift: false, alt: false, disableSnap: true };

let h: HeadlessHost;
let send: Send;
let model: ModelChannel;

beforeEach(async () => {
  h = await createHeadlessHost({ console: silent });
  await h.load(gestureFixture("targets"));
  const client = (h.host.editor as unknown as { client: { send: Send } })
    .client;
  send = client.send.bind(client);
  model = engineModelChannel(send);
});
afterEach(() => h.dispose());

interface Run {
  nodes: ElementId[];
  gesture: Record<string, unknown>;
  anchor?: { pageId: string; pointInPage: Pt; pivotInPage?: Pt } | null;
  deltas: Pt[];
  mods?:
    | { shift: boolean; alt: boolean; disableSnap: boolean }
    | Array<{ shift: boolean; alt: boolean; disableSnap: boolean }>;
}

/** begin → update × n → commit; returns the commit reply. */
async function gesture(r: Run): Promise<WorkerToMain> {
  const begun = await send({
    kind: "beginGesture",
    payload: {
      nodes: r.nodes,
      gesture: r.gesture,
      anchor: r.anchor ?? null,
      cameraScale: 1,
    },
  } as MainToWorkerKind);
  if (begun.kind !== "gestureBegun")
    throw new Error(`begin: ${JSON.stringify(begun.payload)}`);
  const handle = (begun.payload as { handle: number }).handle;
  for (const [i, delta] of r.deltas.entries()) {
    const modifiers = Array.isArray(r.mods) ? r.mods[i] : (r.mods ?? NO_SNAP);
    await send({
      kind: "updateGesture",
      payload: { handle, delta, modifiers },
    });
  }
  return send({ kind: "commitGesture", payload: { handle } });
}

/** Page-space corners of one element. */
async function corners(id: ElementId): Promise<Pt[]> {
  const d = await geometryDigest(send);
  const c = d.get(`${id.kind}:${JSON.stringify(id.id)}`);
  if (!c) throw new Error(`no geometry for ${id.kind}:${String(id.id)}`);
  return c.corners;
}

const box = (cs: Pt[]) => {
  const xs = cs.map((c) => c[0]);
  const ys = cs.map((c) => c[1]);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
};

const close = (a: Pt[], b: Pt[], tol = 1e-3) =>
  a.every(
    (p, i) =>
      Math.abs(p[0] - b[i][0]) <= tol && Math.abs(p[1] - b[i][1]) <= tol,
  );

const FRAME = T.frame.id as ElementId;
const GROUP = T.group.id as ElementId;
const CHILD = T.group.childB as ElementId;
const PAGE = T.pageId;
/** The frame's centre, page pt. */
const PIVOT: Pt = [
  (T.frame.box[1] + T.frame.box[3]) / 2,
  (T.frame.box[0] + T.frame.box[2]) / 2,
];

/** A rotate gesture by `deg` about the frame's centre: the pointer starts
 *  100 pt to the right of the pivot and ends on the circle at `deg`. */
const rotateBy = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return gesture({
    nodes: [FRAME],
    gesture: { kind: "rotate" },
    anchor: {
      pageId: PAGE,
      pointInPage: [PIVOT[0] + 100, PIVOT[1]],
      pivotInPage: PIVOT,
    },
    deltas: [[100 * Math.cos(a) - 100, 100 * Math.sin(a)]],
  });
};

const RUNS = { numRuns: 24, seed: 0x9e57 };

describe("transform maths, as properties of the engine's gestures", () => {
  it("rotations summing to 360° are the identity @level:gesture", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: 5, max: 170, noNaN: true }), {
          minLength: 1,
          maxLength: 5,
        }),
        async (parts) => {
          await h.load(gestureFixture("targets"));
          const start = await corners(FRAME);
          const total = parts.reduce((a, b) => a + b, 0);
          // The parts scaled to 360°, each below 180° so the angle is unambiguous.
          const k = 360 / total;
          let steps = parts.map((p) => p * k);
          while (steps.some((s) => s >= 180))
            steps = steps.flatMap((s) => (s >= 180 ? [s / 2, s / 2] : [s]));
          for (const s of steps)
            expect((await rotateBy(s)).kind).toBe("gestureCommitted");
          // The frame's corners come back to where they were (as a set:
          // after a full turn each corner is its own image again).
          expect(close(await corners(FRAME), start, 1e-2)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("rotate θ then −θ is the identity (an inverse round trip) @level:gesture", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: -170, max: 170, noNaN: true }),
        async (deg) => {
          await h.load(gestureFixture("targets"));
          const start = await corners(FRAME);
          await rotateBy(deg);
          await rotateBy(-deg);
          expect(close(await corners(FRAME), start, 1e-2)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("translate d then −d is the identity, exactly @level:gesture", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.double({ min: -400, max: 400, noNaN: true }),
          fc.double({ min: -400, max: 400, noNaN: true }),
        ),
        async ([dx, dy]) => {
          await h.load(gestureFixture("targets"));
          const start = await corners(FRAME);
          await gesture({
            nodes: [FRAME],
            gesture: { kind: "translate" },
            deltas: [[dx, dy]],
          });
          await gesture({
            nodes: [FRAME],
            gesture: { kind: "translate" },
            deltas: [[-dx, -dy]],
          });
          expect(close(await corners(FRAME), start, 1e-6)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  const HANDLES = [
    "north",
    "south",
    "east",
    "west",
    "northEast",
    "northWest",
    "southEast",
    "southWest",
  ] as const;
  /** What a handle keeps fixed: the opposite edge(s) of the page box. */
  const FIXED: Record<
    (typeof HANDLES)[number],
    Array<"left" | "right" | "top" | "bottom">
  > = {
    north: ["bottom"],
    south: ["top"],
    east: ["left"],
    west: ["right"],
    northEast: ["bottom", "left"],
    northWest: ["bottom", "right"],
    southEast: ["top", "left"],
    southWest: ["top", "right"],
  };

  it("the edge opposite the dragged handle stays fixed @level:gesture", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...HANDLES),
        fc.tuple(
          fc.double({ min: -40, max: 120, noNaN: true }),
          fc.double({ min: -30, max: 120, noNaN: true }),
        ),
        async (handle, delta) => {
          await h.load(gestureFixture("targets"));
          const before = box(await corners(FRAME));
          const reply = await gesture({
            nodes: [FRAME],
            gesture: { kind: "resize", handle },
            deltas: [delta],
          });
          expect(reply.kind).toBe("gestureCommitted");
          const after = box(await corners(FRAME));
          // A drag past the opposite edge flips the frame (as InDesign's
          // does), so the fixed edge stays AN edge on its axis.
          for (const edge of FIXED[handle]) {
            const [lo, hi] =
              edge === "left" || edge === "right"
                ? [after.left, after.right]
                : [after.top, after.bottom];
            expect(
              Math.min(
                Math.abs(lo - before[edge]),
                Math.abs(hi - before[edge]),
              ),
            ).toBeLessThan(1e-3);
          }
        },
      ),
      RUNS,
    );
  });

  it("Shift on a corner handle keeps the aspect ratio @level:gesture", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("northEast", "northWest", "southEast", "southWest"),
        fc.tuple(
          fc.double({ min: 5, max: 150, noNaN: true }),
          fc.double({ min: 5, max: 150, noNaN: true }),
        ),
        async (handle, [dx, dy]) => {
          await h.load(gestureFixture("targets"));
          const b0 = box(await corners(FRAME));
          const out: Pt = [
            handle.includes("East") ? dx : -dx,
            handle.startsWith("south") ? dy : -dy,
          ];
          const reply = await gesture({
            nodes: [FRAME],
            gesture: { kind: "resize", handle },
            deltas: [out],
            mods: { shift: true, alt: false, disableSnap: true },
          });
          expect(reply.kind).toBe("gestureCommitted");
          const b1 = box(await corners(FRAME));
          const ratio0 = (b0.right - b0.left) / (b0.bottom - b0.top);
          const ratio1 = (b1.right - b1.left) / (b1.bottom - b1.top);
          expect(ratio1).toBeCloseTo(ratio0, 3);
        },
      ),
      RUNS,
    );
  });

  it("Alt on a handle resizes about the centre @level:gesture", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...HANDLES),
        fc.tuple(
          fc.double({ min: 0, max: 60, noNaN: true }),
          fc.double({ min: 0, max: 60, noNaN: true }),
        ),
        async (handle, delta) => {
          await h.load(gestureFixture("targets"));
          const b0 = box(await corners(FRAME));
          const reply = await gesture({
            nodes: [FRAME],
            gesture: { kind: "resize", handle },
            deltas: [delta],
            mods: { shift: false, alt: true, disableSnap: true },
          });
          expect(reply.kind).toBe("gestureCommitted");
          const b1 = box(await corners(FRAME));
          expect((b1.left + b1.right) / 2).toBeCloseTo(
            (b0.left + b0.right) / 2,
            3,
          );
          expect((b1.top + b1.bottom) / 2).toBeCloseTo(
            (b0.top + b0.bottom) / 2,
            3,
          );
        },
      ),
      RUNS,
    );
  });
});

describe("one gesture is one undo step; cancel commits nothing (model dumps)", () => {
  const KINDS: Array<[string, Run]> = [
    [
      "translate a frame",
      {
        nodes: [FRAME],
        gesture: { kind: "translate" },
        deltas: [
          [30, 12],
          [44, 20],
        ],
      },
    ],
    [
      "resize a frame (south-east)",
      {
        nodes: [FRAME],
        gesture: { kind: "resize", handle: "southEast" },
        deltas: [[20, 10]],
      },
    ],
    [
      "rotate a frame",
      {
        nodes: [FRAME],
        gesture: { kind: "rotate" },
        anchor: { pageId: PAGE, pointInPage: [PIVOT[0] + 100, PIVOT[1]] },
        deltas: [[-10, 40]],
      },
    ],
    [
      "scale a frame",
      {
        nodes: [FRAME],
        gesture: { kind: "scale" },
        anchor: { pageId: PAGE, pointInPage: [216, 172] },
        deltas: [[30, 15]],
      },
    ],
    [
      "shear a frame",
      {
        nodes: [FRAME],
        gesture: { kind: "shear" },
        anchor: { pageId: PAGE, pointInPage: [216, 172] },
        deltas: [[25, 0]],
      },
    ],
    [
      "translate a group",
      { nodes: [GROUP], gesture: { kind: "translate" }, deltas: [[-40, 30]] },
    ],
    [
      "rotate a group",
      {
        nodes: [GROUP],
        gesture: { kind: "rotate" },
        anchor: { pageId: PAGE, pointInPage: [480, 170] },
        deltas: [[10, 30]],
      },
    ],
    [
      "resize the rotated frame (east)",
      {
        nodes: [T.rotated.id as ElementId],
        gesture: { kind: "resize", handle: "east" },
        deltas: [[20, 10]],
      },
    ],
    [
      "Alt-duplicate a frame",
      {
        nodes: [FRAME],
        gesture: { kind: "translate" },
        deltas: [[60, 0]],
        mods: { shift: false, alt: true, disableSnap: true },
      },
    ],
    [
      "translate two frames",
      {
        nodes: [FRAME, T.rotated.id as ElementId],
        gesture: { kind: "translate" },
        deltas: [[10, 90]],
      },
    ],
  ];

  for (const [label, run] of KINDS) {
    it(`${label}: undo restores the model exactly, redo re-applies it @level:gesture`, async () => {
      const report = await checkUndoRedo(model, () => gesture(run), label);
      expect(report.changed).toBe(true);
    });
    it(`${label}: cancelled mid-way, the model is byte-identical @level:gesture`, async () => {
      await checkCancel(model, async () => {
        const begun = await send({
          kind: "beginGesture",
          payload: {
            nodes: run.nodes,
            gesture: run.gesture,
            anchor: run.anchor ?? null,
          },
        } as MainToWorkerKind);
        const handle = (begun.payload as { handle: number }).handle;
        for (const delta of run.deltas) {
          await send({
            kind: "updateGesture",
            payload: { handle, delta, modifiers: NO_SNAP },
          });
        }
        expect(
          (await send({ kind: "cancelGesture", payload: { handle } })).kind,
        ).toBe("gestureCancelled");
      });
    });
  }

  it("a locked frame refuses every gesture and the model does not move @level:gesture", async () => {
    const before = await model.dump();
    for (const g of [
      { kind: "translate" },
      { kind: "resize", handle: "east" },
      { kind: "rotate" },
    ]) {
      const begun = await send({
        kind: "beginGesture",
        payload: {
          nodes: [T.locked.id],
          gesture: g,
          anchor: { pageId: PAGE, pointInPage: [216, 512] },
        },
      } as MainToWorkerKind);
      expect(begun.kind).toBe("gestureFailed");
      expect((begun.payload as { error: { kind: string } }).error.kind).toBe(
        "locked",
      );
    }
    expect(await model.dump()).toBe(before);
  });
});

// The gesture fuzzer's findings (gesture-fuzz.test.ts, KNOWN). Each
// failing commit is atomic today (the model is unchanged and the next
// gesture begins), which the second test of each pair keeps true; the
// first is the behaviour the engine should have, an expected failure
// until it does.
describe("findings: the fuzzer's (GF) and the gesture matrix's (GM)", () => {
  const groupWidth = async () => {
    const b = box(await corners(GROUP));
    return b.right - b.left;
  };

  test.failing(
    "[GF-1] resizing a group by a handle commits and widens the group @level:gesture",
    async () => {
      const w0 = await groupWidth();
      const reply = await gesture({
        nodes: [GROUP],
        gesture: { kind: "resize", handle: "east" },
        deltas: [[40, 0]],
      });
      expect(reply.kind).toBe("gestureCommitted");
      expect(await groupWidth()).toBeCloseTo(w0 + 40, 1);
    },
  );

  test.failing(
    "[GF-2] Alt-dragging a group duplicates the group @level:gesture",
    async () => {
      const before = (await sceneElementIds(send)).filter(
        (id) => id.kind === "group",
      ).length;
      const reply = await gesture({
        nodes: [GROUP],
        gesture: { kind: "translate" },
        deltas: [[0, 120]],
        mods: { shift: false, alt: true, disableSnap: true },
      });
      expect(reply.kind).toBe("gestureCommitted");
      expect(
        (await sceneElementIds(send)).filter((id) => id.kind === "group")
          .length,
      ).toBe(before + 1);
    },
  );

  test.failing(
    "[GF-3] Alt pressed, released and pressed again while dragging a grouped item duplicates it @level:gesture",
    async () => {
      const before = (await sceneElementIds(send)).length;
      const alt = (on: boolean) => ({
        shift: false,
        alt: on,
        disableSnap: true,
      });
      const reply = await gesture({
        nodes: [CHILD],
        gesture: { kind: "translate" },
        deltas: [
          [20, 0],
          [30, 0],
          [40, 0],
        ],
        mods: [alt(true), alt(false), alt(true)],
      });
      expect(reply.kind).toBe("gestureCommitted");
      expect((await sceneElementIds(send)).length).toBe(before + 1);
    },
  );

  test.failing(
    "[GF-4] a rotated frame survives IDML save → load to a micro-point @level:gesture",
    async () => {
      await rotateBy(30);
      const exported = await send({
        kind: "exportIdml",
        payload: { linkBase: null },
      });
      expect(exported.kind).toBe("idmlExported");
      const reload = await createHeadlessHost({ console: silent });
      try {
        await reload.load(
          Uint8Array.from(
            (exported.payload as { idmlBytes: number[] }).idmlBytes,
          ),
        );
        const client = (
          reload.host.editor as unknown as { client: { send: Send } }
        ).client;
        const diff = compareDigests(
          await geometryDigest(send),
          await geometryDigest(client.send.bind(client)),
        );
        // Today: "precision" — the writer prints the transform to 4 decimals.
        expect(diff).toBeNull();
      } finally {
        reload.dispose();
      }
    },
  );

  it("the 4-decimal drift stays within its bound, and nothing else moves on save → load @level:gesture", async () => {
    await rotateBy(30);
    await gesture({
      nodes: [GROUP],
      gesture: { kind: "shear" },
      anchor: { pageId: PAGE, pointInPage: [480, 170] },
      deltas: [[25, 0]],
    });
    const exported = await send({
      kind: "exportIdml",
      payload: { linkBase: null },
    });
    const reload = await createHeadlessHost({ console: silent });
    try {
      await reload.load(
        Uint8Array.from(
          (exported.payload as { idmlBytes: number[] }).idmlBytes,
        ),
      );
      const client = (
        reload.host.editor as unknown as { client: { send: Send } }
      ).client;
      const diff = compareDigests(
        await geometryDigest(send),
        await geometryDigest(client.send.bind(client)),
      );
      expect(diff === null || diff.verdict === "precision").toBe(true);
    } finally {
      reload.dispose();
    }
  });

  // Found by the gesture matrix (gesture-matrix.json, GM-1): the pointer
  // turns 90° about the group's centre and the group turns ~37° about
  // (260, 90) — the mean of its members' centres AND a phantom point at
  // the origin: (0 + 340 + 440) / 3, (0 + 130 + 140) / 3. A frame or a
  // single member turns about its own centre.
  test.failing(
    "[GM-1] a group turns about its centre, as a frame does @level:gesture",
    async () => {
      const centre = (cs: Pt[]): Pt => [
        (cs[0][0] + cs[2][0]) / 2,
        (cs[0][1] + cs[2][1]) / 2,
      ];
      const c0 = centre(await corners(GROUP));
      const reply = await gesture({
        nodes: [GROUP],
        gesture: { kind: "rotate" },
        anchor: { pageId: PAGE, pointInPage: [c0[0] + 100, c0[1]] },
        deltas: [[-100, 100]],
      });
      expect(reply.kind).toBe("gestureCommitted");
      const c1 = centre(await corners(GROUP));
      expect(c1[0]).toBeCloseTo(c0[0], 1);
      expect(c1[1]).toBeCloseTo(c0[1], 1);
    },
  );

  it("a frame turns about its own centre (the GM-1 control) @level:gesture", async () => {
    const centre = (cs: Pt[]): Pt => [
      (cs[0][0] + cs[2][0]) / 2,
      (cs[0][1] + cs[2][1]) / 2,
    ];
    const c0 = centre(await corners(FRAME));
    await rotateBy(90);
    const c1 = centre(await corners(FRAME));
    expect(c1[0]).toBeCloseTo(c0[0], 3);
    expect(c1[1]).toBeCloseTo(c0[1], 3);
  });

  it("the failing commits are atomic: nothing changes and the next gesture begins @level:gesture", async () => {
    const before = await model.dump();
    const alt = (on: boolean) => ({ shift: false, alt: on, disableSnap: true });
    await gesture({
      nodes: [GROUP],
      gesture: { kind: "resize", handle: "east" },
      deltas: [[40, 0]],
    });
    await gesture({
      nodes: [GROUP],
      gesture: { kind: "translate" },
      deltas: [[0, 120]],
      mods: alt(true),
    });
    await gesture({
      nodes: [CHILD],
      gesture: { kind: "translate" },
      deltas: [
        [20, 0],
        [30, 0],
        [40, 0],
      ],
      mods: [alt(true), alt(false), alt(true)],
    });
    expect(await model.dump()).toBe(before);
    expect(
      (
        await gesture({
          nodes: [FRAME],
          gesture: { kind: "translate" },
          deltas: [[5, 5]],
        })
      ).kind,
    ).toBe("gestureCommitted");
  });
});
