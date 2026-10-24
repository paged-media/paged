/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// WP4.4 — Align / Distribute (`paged.align.objects`): every scope
// (selection, key object, margins, page, spread) and every mode (align,
// distribute objects by an edge or centre, distribute spacing, a fixed
// spacing), planned in spread space on each object's TRANSFORMED box and
// written through the `frameTransform` door; and the client reads the
// command plans from.

import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  ALIGN_COMMAND,
  alignOps,
  planAlign,
  type AlignArgs,
  type AlignPage,
} from "../../../src/align-plan";
import {
  readAlignPages,
  readSpreadTargets,
  type SpreadReadClient,
} from "../../../src/spread-targets";
import { buildTransformCommands } from "../../../src/transform-commands";
import {
  compose,
  invert,
  translate,
  writtenTransform,
  type Affine,
  type Bounds,
  type SpreadTarget,
} from "../../../src/transform-targets";

/** A page item at spread box `box` (identity transform unless given). */
const item = (
  address: string,
  box: Bounds,
  pageId: string | null = "p1",
  composed: Affine | null = null,
): SpreadTarget => ({ address, box, pageId, spreadId: "s1", composed });

/** A facing spread s1 (p1 at x 0..612, p2 at 612..1224) and a lone s2. */
const PAGES: AlignPage[] = [
  {
    id: "p1",
    spreadId: "s1",
    rect: [0, 0, 792, 612],
    margins: { top: 36, left: 54, bottom: 48, right: 30 },
  },
  {
    id: "p2",
    spreadId: "s1",
    rect: [0, 612, 792, 1224],
    margins: { top: 36, left: 30, bottom: 48, right: 54 },
  },
  {
    id: "p3",
    spreadId: "s2",
    rect: [0, 0, 792, 612],
    margins: { top: 0, left: 0, bottom: 0, right: 0 },
  },
];

const A = item("rectangle:a", [0, 0, 10, 10]);
const B = item("rectangle:b", [20, 30, 40, 50]);
const C = item("rectangle:c", [5, 100, 25, 140]);

/** The planned moves as `{ address: [dx, dy] }`. */
const moves = (
  args: Omit<AlignArgs, "targets">,
  targets: readonly SpreadTarget[],
  pages: readonly AlignPage[] = PAGES,
) =>
  Object.fromEntries(
    planAlign(args, targets, pages).map((m) => [
      m.address,
      m.delta.map((v) => Math.round(v * 1000) / 1000),
    ]),
  );

describe("align to the selection [editor-shell.align-transform-each]", () => {
  test("the six alignments move to the union's edges and centres", () => {
    covers("command:paged.align.objects");
    const all = [A, B, C];
    expect(moves({ kind: "left" }, all)).toEqual({
      "rectangle:b": [-30, 0],
      "rectangle:c": [-100, 0],
    });
    expect(moves({ kind: "right" }, all)).toEqual({
      "rectangle:a": [130, 0],
      "rectangle:b": [90, 0],
    });
    expect(moves({ kind: "centerH" }, all)).toEqual({
      "rectangle:a": [65, 0],
      "rectangle:b": [30, 0],
      "rectangle:c": [-50, 0],
    });
    expect(moves({ kind: "top" }, all)).toEqual({
      "rectangle:b": [0, -20],
      "rectangle:c": [0, -5],
    });
    expect(moves({ kind: "bottom" }, all)).toEqual({
      "rectangle:a": [0, 30],
      "rectangle:c": [0, 15],
    });
    expect(moves({ kind: "centerV" }, all)).toEqual({
      "rectangle:a": [0, 15],
      "rectangle:b": [0, -10],
      "rectangle:c": [0, 5],
    });
  });

  test("one object aligns to nothing; distribute needs three", () => {
    covers("command:paged.align.objects");
    expect(moves({ kind: "left" }, [A])).toEqual({});
    expect(moves({ kind: "distributeH" }, [A, B])).toEqual({});
    expect(moves({ kind: "spaceH" }, [A, B])).toEqual({});
  });

  test("a rotated object aligns by the box it shows, written through its transform", () => {
    covers("command:paged.align.objects");
    // A 100 × 20 frame turned 90° about its origin, placed at x 200: it
    // shows as a 20 × 100 box at x 180..200.
    const rot: Affine = [0, 1, -1, 0, 200, 0];
    const turned = item("rectangle:r", [180 - 180, 180, 100, 200], "p1", rot);
    const plan = planAlign({ kind: "left" }, [A, turned], PAGES);
    expect(plan).toEqual([{ address: "rectangle:r", delta: [-180, 0] }]);
    const [op] = alignOps(plan, [A, turned]);
    expect(op).toEqual({
      op: "set",
      address: "rectangle:r",
      path: "frameTransform",
      // translate(-180, 0) ∘ rot: the rotation kept, the origin moved.
      value: [0, 1, -1, 0, 20, 0],
    });
  });
});

describe("align to a key object [editor-shell.align-transform-each]", () => {
  test("the key stays; the others align to it (the first object by default)", () => {
    covers("command:paged.align.objects");
    expect(
      moves({ kind: "left", to: "keyObject", key: "rectangle:c" }, [A, B, C]),
    ).toEqual({ "rectangle:a": [100, 0], "rectangle:b": [70, 0] });
    expect(moves({ kind: "bottom", to: "keyObject" }, [A, B, C])).toEqual({
      "rectangle:b": [0, -30],
      "rectangle:c": [0, -15],
    });
  });

  test("distribute and space with a fixed spacing step out from the key", () => {
    covers("command:paged.align.objects");
    // Lefts 0, 30, 100; key b at 30; step 50 → a at -20, c at 80.
    expect(
      moves(
        {
          kind: "distributeLeft",
          to: "keyObject",
          key: "rectangle:b",
          spacing: 50,
        },
        [A, B, C],
      ),
    ).toEqual({ "rectangle:a": [-20, 0], "rectangle:c": [-20, 0] });
    // Gaps of 5 around b (30..50): a ends at 25, c starts at 55.
    expect(
      moves(
        { kind: "spaceH", to: "keyObject", key: "rectangle:b", spacing: 5 },
        [A, B, C],
      ),
    ).toEqual({ "rectangle:a": [15, 0], "rectangle:c": [-45, 0] });
  });
});

describe("align to the page, the margins and the spread [editor-shell.align-transform-each] [layout-model.page-margin-reads]", () => {
  test("one object aligns to its own page", () => {
    covers("command:paged.align.objects");
    const onP2 = item("rectangle:q", [100, 700, 150, 800], "p2");
    expect(moves({ kind: "right", to: "page" }, [onP2])).toEqual({
      "rectangle:q": [424, 0],
    });
    expect(moves({ kind: "left", to: "page" }, [A, onP2])).toEqual({
      "rectangle:q": [-88, 0],
    });
    expect(moves({ kind: "bottom", to: "page" }, [A])).toEqual({
      "rectangle:a": [0, 782],
    });
  });

  test("margins inset the page by its own margins", () => {
    covers("command:paged.align.objects");
    const onP2 = item("rectangle:q", [100, 700, 150, 800], "p2");
    expect(moves({ kind: "left", to: "margins" }, [A, onP2])).toEqual({
      "rectangle:a": [54, 0],
      "rectangle:q": [-58, 0],
    });
    expect(moves({ kind: "top", to: "margins" }, [A])).toEqual({
      "rectangle:a": [0, 36],
    });
    expect(moves({ kind: "centerH", to: "margins" }, [A])).toEqual({
      // (54 + 582) / 2 - 5
      "rectangle:a": [313, 0],
    });
  });

  test("the spread is the union of its pages", () => {
    covers("command:paged.align.objects");
    expect(moves({ kind: "right", to: "spread" }, [A])).toEqual({
      "rectangle:a": [1214, 0],
    });
    expect(moves({ kind: "centerH", to: "spread" }, [A])).toEqual({
      "rectangle:a": [607, 0],
    });
  });

  test("a pasteboard object aligns to its spread's first page", () => {
    covers("command:paged.align.objects");
    const off = item("rectangle:o", [10, -200, 20, -150], null);
    expect(moves({ kind: "left", to: "page" }, [off])).toEqual({
      "rectangle:o": [200, 0],
    });
  });

  test("distributing to the page runs from its start edge to its end edge", () => {
    covers("command:paged.align.objects");
    const x = item("rectangle:x", [0, 100, 10, 120]);
    const y = item("rectangle:y", [0, 300, 10, 340]);
    // Left edges: first at 0, last at 612 - 40 = 572.
    expect(moves({ kind: "distributeLeft", to: "page" }, [x, y])).toEqual({
      "rectangle:x": [-100, 0],
      "rectangle:y": [272, 0],
    });
    // Spacing: the gap (612 - 60) between the two, flush to the edges.
    expect(moves({ kind: "spaceH", to: "page" }, [x, y])).toEqual({
      "rectangle:x": [-100, 0],
      "rectangle:y": [272, 0],
    });
    // A lone object on its page is not distributed.
    expect(moves({ kind: "distributeLeft", to: "page" }, [x])).toEqual({});
  });
});

describe("distribute objects and distribute spacing [editor-shell.align-transform-each]", () => {
  const D = item("rectangle:d", [0, 10, 10, 20]);
  const E = item("rectangle:e", [0, 90, 10, 100]);
  const F = item("rectangle:f", [0, 30, 10, 60]);

  test("each edge or centre is spaced evenly between the outer two", () => {
    covers("command:paged.align.objects");
    // Lefts 10, 30, 90 → 10, 50, 90.
    expect(moves({ kind: "distributeLeft" }, [D, E, F])).toEqual({
      "rectangle:f": [20, 0],
    });
    // Centres 15, 45, 95 → 15, 55, 95.
    expect(moves({ kind: "distributeH" }, [D, E, F])).toEqual({
      "rectangle:f": [10, 0],
    });
    // Rights 20, 60, 100 → 20, 60, 100: already even.
    expect(moves({ kind: "distributeRight" }, [D, E, F])).toEqual({});
  });

  test("the vertical kinds work on the vertical edges", () => {
    covers("command:paged.align.objects");
    const v = [
      item("rectangle:1", [0, 0, 10, 10]),
      item("rectangle:2", [20, 0, 40, 10]),
      item("rectangle:3", [90, 0, 100, 10]),
    ];
    expect(moves({ kind: "distributeTop" }, v)).toEqual({
      "rectangle:2": [0, 25],
    });
    expect(moves({ kind: "distributeV" }, v)).toEqual({
      "rectangle:2": [0, 20],
    });
    expect(moves({ kind: "distributeBottom" }, v)).toEqual({
      "rectangle:2": [0, 15],
    });
    // Heights 10 + 20 + 10 in 0..100: gaps of 30.
    expect(moves({ kind: "spaceV" }, v)).toEqual({
      "rectangle:2": [0, 20],
    });
  });

  test("distribute spacing makes the gaps equal", () => {
    covers("command:paged.align.objects");
    // Widths 10 + 10 + 30 in 10..100: gaps of 20 → f at 40.
    expect(moves({ kind: "spaceH" }, [D, E, F])).toEqual({
      "rectangle:f": [10, 0],
    });
  });

  test("a fixed spacing steps from the first object, two objects are enough", () => {
    covers("command:paged.align.objects");
    expect(moves({ kind: "spaceH", spacing: 4 }, [D, E])).toEqual({
      "rectangle:e": [-66, 0],
    });
    expect(moves({ kind: "distributeLeft", spacing: 25 }, [D, E, F])).toEqual({
      "rectangle:f": [5, 0],
      "rectangle:e": [-30, 0],
    });
  });
});

describe("the write door", () => {
  test("a page item composes the move onto its transform", () => {
    covers("command:paged.align.objects");
    const t = item("rectangle:t", [0, 0, 10, 10], "p1", [2, 0, 0, 2, 5, 5]);
    expect(writtenTransform(t, translate(10, 0))).toEqual([2, 0, 0, 2, 15, 5]);
  });

  test("a top-level group writes R ∘ G; a nested one R seen from its frame", () => {
    covers("command:paged.align.objects");
    const g: Affine = [1, 0, 0, 1, 50, 50];
    const top: SpreadTarget = {
      ...item("group:g", [0, 0, 10, 10]),
      composed: g,
      group: { stored: g },
    };
    const [op] = alignOps([{ address: "group:g", delta: [10, 0] }], [top]);
    expect(op).toEqual({
      op: "invoke",
      command: "core.setGroupTransform",
      args: { groupId: "group:g", transform: [1, 0, 0, 1, 60, 50] },
    });
    // Nested: its parent frame F turns it 90°; E = F ∘ G.
    const frame: Affine = [0, 1, -1, 0, 0, 0];
    const nested: SpreadTarget = {
      ...item("group:n", [0, 0, 10, 10]),
      composed: compose(frame, g),
      group: { stored: g },
    };
    const written = writtenTransform(nested, translate(10, 0));
    // What reaches the spread is F ∘ written = translate(10, 0) ∘ E.
    const landed = compose(frame, written);
    const want = compose(translate(10, 0), compose(frame, g));
    landed.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9));
    expect(invert(frame)).not.toBeNull();
  });
});

// ── The command through the registry ────────────────────────────────

function fakeClient(opts: {
  geometry: Record<
    string,
    {
      bounds: number[];
      itemTransform?: number[] | null;
      pageId?: string | null;
      pageOrigin?: number[] | null;
    }
  >;
  pages?: unknown[];
  groupTransforms?: Record<string, number[] | null>;
}): SpreadReadClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async elementGeometry(ids) {
      calls.push(`geometry:${ids.map((i) => `${i.kind}:${String(i.id)}`)}`);
      return ids.flatMap((id) => {
        const g = opts.geometry[`${id.kind}:${String(id.id)}`];
        return g ? [{ id, spreadId: "s1", pageId: "p1", ...g }] : [];
      });
    },
    async elementProperties(id) {
      calls.push(`properties:${id.kind}:${String(id.id)}`);
      const v = opts.groupTransforms?.[`${id.kind}:${String(id.id)}`];
      return {
        entries: [
          { path: "frameTransform", value: { type: "transform", value: v } },
        ],
      };
    },
    async collection<T>() {
      calls.push("pages");
      return (opts.pages ?? []) as T[];
    },
  };
}

function alignHarness(client: SpreadReadClient) {
  const batches: Array<{ ops: unknown[]; label?: string }> = [];
  const objects = {
    async batch(ops: readonly unknown[], opts?: { label?: string }) {
      batches.push({ ops: [...ops], label: opts?.label });
      return { applied: true, undoSteps: 1 as const };
    },
  };
  const paged = { client };
  const registry = createCommandRegistry(() => paged);
  for (const c of buildTransformCommands(objects as never))
    registry.register(c);
  return { registry, batches };
}

describe("paged.align.objects through the registry [editor-shell.align-transform-each]", () => {
  const client = () =>
    fakeClient({
      geometry: {
        "rectangle:a": { bounds: [0, 0, 10, 10] },
        // On a verso at spread (-612, 0): page-space x 30 is spread -582.
        "rectangle:b": {
          bounds: [0, 0, 20, 20],
          itemTransform: [1, 0, 0, 1, 30, 20],
          pageOrigin: [-612, 0],
        },
      },
      pages: [
        {
          selfId: "p1",
          sizePt: [612, 792],
          pageOrigin: [-612, 0],
          spreadId: "s1",
          marginTopPt: 10,
          marginLeftPt: 20,
          marginBottomPt: 30,
          marginRightPt: 40,
        },
      ],
    });

  test("align left: ONE batch of frameTransform writes, in spread space", async () => {
    covers("command:paged.align.objects");
    const h = alignHarness(client());
    const result = await h.registry.invoke(ALIGN_COMMAND, {
      kind: "left",
      targets: ["rectangle:a", "rectangle:b"],
    });
    expect(result).toEqual({ applied: true, undoSteps: 1 });
    expect(h.batches).toEqual([
      {
        label: "align left",
        ops: [
          {
            op: "set",
            address: "rectangle:a",
            path: "frameTransform",
            value: [1, 0, 0, 1, -582, 0],
          },
        ],
      },
    ]);
  });

  test("align to the margins reads the pages", async () => {
    covers("command:paged.align.objects");
    const c = client();
    const h = alignHarness(c);
    await h.registry.invoke(ALIGN_COMMAND, {
      kind: "top",
      targets: ["rectangle:b"],
      to: "margins",
    });
    expect(c.calls).toContain("pages");
    expect(h.batches[0]?.ops).toEqual([
      {
        op: "set",
        address: "rectangle:b",
        path: "frameTransform",
        value: [1, 0, 0, 1, -582, 10],
      },
    ]);
  });

  test("nothing to move is zero undo steps and no batch", async () => {
    covers("command:paged.align.objects");
    const h = alignHarness(client());
    expect(
      await h.registry.invoke(ALIGN_COMMAND, {
        kind: "left",
        targets: ["rectangle:a", "rectangle:nope"],
      }),
    ).toEqual({ applied: true, undoSteps: 0 });
    expect(h.batches).toEqual([]);
  });

  test("a payload that does not match the declared args is refused", async () => {
    covers("command:paged.align.objects");
    const h = alignHarness(client());
    await expect(
      h.registry.invoke(ALIGN_COMMAND, { kind: "diagonal", targets: [] }),
    ).rejects.toThrow(/^invalidValue: paged\.align\.objects/);
    await expect(
      h.registry.invoke(ALIGN_COMMAND, {
        kind: "left",
        targets: [],
        to: "galaxy",
      }),
    ).rejects.toThrow(/invalidValue/);
    await expect(
      h.registry.invoke(ALIGN_COMMAND, { kind: "left", targets: "a" }),
    ).rejects.toThrow(/must be a list/);
    expect(h.batches).toEqual([]);
  });
});

describe("the reads", () => {
  test("targets fold the page origin in; a group reads its stored transform", async () => {
    covers("command:paged.align.objects");
    const c = fakeClient({
      geometry: {
        "rectangle:r": {
          bounds: [0, 0, 10, 20],
          itemTransform: [1, 0, 0, 1, 5, 5],
          pageOrigin: [-612, -396],
        },
        "group:g": { bounds: [0, 0, 50, 50], itemTransform: null },
      },
      groupTransforms: { "group:g": [1, 0, 0, 1, 7, 7] },
    });
    const t = await readSpreadTargets(c, [
      "rectangle:r",
      "group:g",
      "story:s@0..1",
      "rectangle:missing",
    ]);
    expect(t).toEqual([
      {
        address: "rectangle:r",
        box: [-391, -607, -381, -587],
        pageId: "p1",
        spreadId: "s1",
        composed: [1, 0, 0, 1, -607, -391],
      },
      {
        address: "group:g",
        box: [0, 0, 50, 50],
        pageId: "p1",
        spreadId: "s1",
        composed: null,
        group: { stored: [1, 0, 0, 1, 7, 7] },
      },
    ]);
  });

  test("pages read as spread-space boxes with their margins", async () => {
    covers("command:paged.align.objects");
    const c = fakeClient({
      geometry: {},
      pages: [
        { selfId: "p1", sizePt: [612, 792], pageOrigin: [-612, -396] },
        {
          selfId: "p2",
          sizePt: [612, 792],
          pageOrigin: [0, -396],
          spreadId: "s1",
          marginLeftPt: 30,
        },
      ],
    });
    expect(await readAlignPages(c)).toEqual([
      {
        id: "p1",
        spreadId: null,
        rect: [-396, -612, 396, 0],
        margins: { top: 0, left: 0, bottom: 0, right: 0 },
      },
      {
        id: "p2",
        spreadId: "s1",
        rect: [-396, 0, 396, 612],
        margins: { top: 0, left: 30, bottom: 0, right: 0 },
      },
    ]);
  });
});
