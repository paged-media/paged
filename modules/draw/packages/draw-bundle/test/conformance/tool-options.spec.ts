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

// TOOL OPTIONS conformance — the Pencil, Paintbrush, Blob Brush, Eraser
// and Width tools read their parameters from the HOST's tool-settings
// store instead of from constants.
//
// Three things are proven, per tool, against the REAL engine:
//
//   1. THE OPTION REACHES THE GEOMETRY. A wider nib commits a wider
//      swept outline, a bigger eraser cuts a wider gap, a lower peak
//      limit bakes a thinner bulge, a coarser fidelity keeps fewer
//      anchors. Bounds and anchor tables are read back from the engine —
//      nothing is asserted about a mutation that was merely SENT.
//
//   2. THE DEFAULTS ARE THE TOOL AS IT SHIPPED. For each tool the spec
//      rebuilds the pre-options commit BY HAND — the machine constructed
//      with the old constants spelled out as LITERALS here (2 px, π/4,
//      0.3, 6 pt, 8 px, 2 / 1 / 72), applied through the same wire
//      builders — and requires the handler's result to be the same
//      anchor table. The literals are deliberately not imported: a
//      default that drifts must fail here, not move with the import.
//
//   3. THE VALUES ARE READ LIVE, FROM THE HOST. The store a handler is
//      handed in `onActivate` is the only place a value lives: a change
//      between two strokes of ONE activation shows in the second stroke,
//      and a host with no store (the headless harness, an older editor)
//      runs on the defaults.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import {
  BrushMachine,
  PencilMachine,
  WidthMachine,
} from "@paged-media/draw-tools";

import { drawTools } from "../../src/tools";
import {
  drawBundle,
  createPaintbrushHandler,
  createBlobBrushHandler,
  createEraserBrushHandler,
  createPencilHandler,
  createWidthHandler,
  insertPathMutationFor,
  outlineStrokeVariableMutationFor,
  nibFromOptions,
  eraserNibFromOptions,
  createToolOptionsReader,
  defineToolOptions,
  toolOptionsSpecOf,
  toolSettingsDoorOf,
  TOOL_OPTIONS,
  PENCIL_OPTIONS,
  PAINTBRUSH_OPTIONS,
  BLOB_BRUSH_OPTIONS,
  ERASER_OPTIONS,
  WIDTH_OPTIONS,
  PAINTBRUSH_NIB,
  ERASER_NIB,
  WIDTH_FALLOFF_ANCHORS,
  WIDTH_GAIN,
  WIDTH_MAX_PT,
} from "../../src";
import { F1_MULTI_SHAPE, F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "./host";

const PAGE = "usp";

function pointer(
  point: [number, number],
  maxDelta = 0,
): CanvasPointerEvent {
  return {
    pageId: PAGE,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
    maxDelta,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error("timed out waiting for the tool's commit to land");
}

/** The host's tool-settings store, as the editor hands it to a handler
 *  (`PagedEditor.toolSettings`): a per-tool key/value map with a `set`
 *  the popover writes through. `paged` is what `onActivate` receives. */
function settingsStore(
  initial: Record<string, Record<string, unknown>> = {},
) {
  const data: Record<string, Record<string, unknown>> = {};
  for (const [tool, values] of Object.entries(initial)) {
    data[tool] = { ...values };
  }
  const writes: [string, string, unknown][] = [];
  const toolSettings = {
    getValue: (toolId: string, key: string) => data[toolId]?.[key],
    set: (toolId: string, key: string, value: unknown) => {
      writes.push([toolId, key, value]);
      (data[toolId] ??= {})[key] = value;
    },
  };
  return { data, writes, paged: { toolSettings } };
}

/** down → moves → up, WITHOUT activating (the caller decides which
 *  `paged` the handler was activated with). */
function stroke(handler: GestureHandler, points: [number, number][]): void {
  handler.onPointerDown(pointer(points[0]));
  for (const p of points.slice(1)) handler.onPointerMove(pointer(p, 20));
  handler.onPointerUp(pointer(points[points.length - 1], 20));
}

/** The page-space box of an anchor table — anchors AND handles, so a
 *  curved outline's bulge counts. `[minX, minY, maxX, maxY]`. */
function boxOf(table: PathAnchorsResult): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const a of table.anchors) {
    for (const p of [a.anchor, a.left, a.right]) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return [minX, minY, maxX, maxY];
}

const shapeOf = (t: PathAnchorsResult) => ({
  anchors: t.anchors.map((a) => ({
    anchor: a.anchor,
    left: a.left,
    right: a.right,
  })),
  subpathStarts: t.subpathStarts,
  subpathOpen: t.subpathOpen,
});

async function leafCount(h: HeadlessHost): Promise<number> {
  const roots = await h.host.document.tree();
  let n = 0;
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id) n++;
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return n;
}

/** Run one sweep and return the element it created (the tool selects
 *  what it commits). */
async function sweepAndRead(
  h: HeadlessHost,
  handler: GestureHandler,
  points: [number, number][],
): Promise<{ id: ElementId; table: PathAnchorsResult }> {
  await h.host.selection.set([]);
  const before = await leafCount(h);
  stroke(handler, points);
  await until(async () => (await leafCount(h)) === before + 1);
  await until(async () => h.host.selection.get().length === 1);
  const id = h.host.selection.get()[0];
  const table = await h.host.document.pathAnchors(id);
  if (!table) throw new Error("the committed sweep has no anchor table");
  return { id, table };
}

// ---------------------------------------------------------------- pure

describe("tool options — the declarations", () => {
  const tools = drawTools({} as never);
  const withOptions = tools.filter((t) => t.options);

  it("the five freehand tools declare options, under their OWN tool id", () => {
    const ids = withOptions.map((t) => t.id);
    for (const id of [
      "media.paged.draw.tool.pencil",
      "media.paged.draw.tool.paintbrush",
      "media.paged.draw.tool.blobBrush",
      "media.paged.draw.tool.eraserBrush",
      "media.paged.draw.tool.width",
    ]) {
      expect(ids).toContain(id);
    }
    // The settings namespace is the tool's id: the host keys its store
    // by `spec.toolId`, and a handler reads it under its definition's.
    for (const t of withOptions) expect(t.options!.toolId).toBe(t.id);
  });

  it("every declared spec is the definition minus what the contract cannot carry", () => {
    for (const def of TOOL_OPTIONS) {
      const tool = tools.find((t) => t.id === def.toolId);
      expect(tool?.options).toEqual(toolOptionsSpecOf(def));
      for (const field of tool!.options!.fields) {
        expect(field).not.toHaveProperty("default");
      }
    }
  });

  it("no option is a toggle, and every select lists its default FIRST — an unset field displays that", () => {
    // `ToolOptionField` has no `default`; the editor's popover shows an
    // unset select as its first option. A default anywhere else would be
    // displayed as something the tool is not using.
    for (const def of TOOL_OPTIONS) {
      for (const f of def.fields) {
        expect(["number", "select"]).toContain(f.kind);
        if (f.kind === "select") expect(f.options[0].value).toBe(f.default);
        if (f.kind === "number") {
          expect(f.default).toBeGreaterThanOrEqual(f.min);
          expect(f.default).toBeLessThanOrEqual(f.max);
        }
      }
    }
  });

  it("a definition whose default cannot be displayed truthfully is refused at load", () => {
    expect(() =>
      defineToolOptions({
        toolId: "t",
        fields: [
          { kind: "number", key: "n", label: "N", min: 1, max: 2, default: 3 },
        ],
      }),
    ).toThrow(/outside 1\.\.2/);
    expect(() =>
      defineToolOptions({
        toolId: "t",
        fields: [
          {
            kind: "select",
            key: "s",
            label: "S",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
            default: "b",
          },
        ],
      }),
    ).toThrow(/must be the first option/);
  });

  it("the defaults ARE the constants the tools shipped with", () => {
    const brush = createToolOptionsReader(PAINTBRUSH_OPTIONS);
    const blob = createToolOptionsReader(BLOB_BRUSH_OPTIONS);
    const eraser = createToolOptionsReader(ERASER_OPTIONS);
    const pencil = createToolOptionsReader(PENCIL_OPTIONS);
    const width = createToolOptionsReader(WIDTH_OPTIONS);

    // The literal pre-options nib, and the exported constant it became.
    expect(nibFromOptions(brush)).toEqual({
      angle: Math.PI / 4,
      roundness: 0.3,
      size: 6,
    });
    expect(nibFromOptions(brush)).toEqual(PAINTBRUSH_NIB);
    expect(nibFromOptions(blob)).toEqual(PAINTBRUSH_NIB);
    expect(eraserNibFromOptions(eraser)).toEqual({
      angle: 0,
      roundness: 1,
      size: 6,
    });
    expect(eraserNibFromOptions(eraser)).toEqual(ERASER_NIB);

    expect(brush.number("fidelity")).toBe(2);
    expect(blob.number("fidelity")).toBe(2);
    expect(eraser.number("fidelity")).toBe(2);

    expect(pencil.number("fidelity")).toBe(2);
    expect(pencil.number("closeDistance")).toBe(8);
    expect(pencil.select("smoothing")).toBe("smooth");

    expect(width.number("falloff")).toBe(2);
    expect(width.number("gain")).toBe(1);
    expect(width.number("maxWidth")).toBe(72);
    expect(width.number("falloff")).toBe(WIDTH_FALLOFF_ANCHORS);
    expect(width.number("gain")).toBe(WIDTH_GAIN);
    expect(width.number("maxWidth")).toBe(WIDTH_MAX_PT);
  });
});

describe("tool options — the read door", () => {
  it("finds the host's store on the handle `onActivate` receives, and nothing on a host without one", () => {
    const store = settingsStore();
    expect(toolSettingsDoorOf(store.paged)).toBe(store.paged.toolSettings);
    // The headless harness activates with `undefined`; an older editor
    // hands a handle with no `toolSettings`; neither may throw.
    expect(toolSettingsDoorOf(undefined)).toBeNull();
    expect(toolSettingsDoorOf(null)).toBeNull();
    expect(toolSettingsDoorOf({})).toBeNull();
    expect(toolSettingsDoorOf({ toolSettings: {} })).toBeNull();
    expect(toolSettingsDoorOf({ toolSettings: { getValue: 1 } })).toBeNull();
  });

  it("reads LIVE — a value written after `attach` is the next read", () => {
    const store = settingsStore();
    const reader = createToolOptionsReader(PAINTBRUSH_OPTIONS);
    reader.attach(store.paged);
    expect(reader.number("size")).toBe(6);
    store.paged.toolSettings.set(PAINTBRUSH_OPTIONS.toolId, "size", 18);
    expect(reader.number("size")).toBe(18);
  });

  it("clamps to the declared range and ignores what is not a value of the field", () => {
    const id = PAINTBRUSH_OPTIONS.toolId;
    const store = settingsStore({
      [id]: { size: 9999, angle: Number.NaN, roundness: "wide", fidelity: -3 },
      [PENCIL_OPTIONS.toolId]: { smoothing: "wobbly" },
    });
    const reader = createToolOptionsReader(PAINTBRUSH_OPTIONS);
    reader.attach(store.paged);
    expect(reader.number("size")).toBe(200); // the field's max
    expect(reader.number("angle")).toBe(45); // NaN → the default
    expect(reader.number("roundness")).toBe(30); // a string → the default
    expect(reader.number("fidelity")).toBe(0.5); // the field's min

    const pencil = createToolOptionsReader(PENCIL_OPTIONS);
    pencil.attach(store.paged);
    expect(pencil.select("smoothing")).toBe("smooth");
  });

  it("is keyed by the TOOL — the Blob Brush does not read the Paintbrush's nib", () => {
    const store = settingsStore({
      [PAINTBRUSH_OPTIONS.toolId]: { size: 40 },
    });
    const blob = createToolOptionsReader(BLOB_BRUSH_OPTIONS);
    blob.attach(store.paged);
    expect(blob.number("size")).toBe(6);
  });

  it("seeds the unset defaults into the host's store on activate, and never overwrites a set value", () => {
    // The popover shows an unset number as its `min`; seeding is what
    // makes it show the value the tool is actually using.
    const id = PAINTBRUSH_OPTIONS.toolId;
    const store = settingsStore({ [id]: { size: 12 } });
    const handler = createPaintbrushHandler({} as never);
    handler.onActivate(store.paged as never);
    expect(store.data[id]).toEqual({
      size: 12,
      angle: 45,
      roundness: 30,
      fidelity: 2,
    });
    expect(store.writes.map((w) => w[1]).sort()).toEqual([
      "angle",
      "fidelity",
      "roundness",
    ]);
    // A second activation writes nothing.
    store.writes.length = 0;
    handler.onActivate(store.paged as never);
    expect(store.writes).toEqual([]);
  });

  it("a read-only store (no `set`) still answers reads", () => {
    const paged = {
      toolSettings: { getValue: (_t: string, k: string) => (k === "size" ? 9 : undefined) },
    };
    const reader = createToolOptionsReader(ERASER_OPTIONS);
    expect(() => reader.attach(paged)).not.toThrow();
    expect(reader.number("size")).toBe(9);
    expect(reader.number("fidelity")).toBe(2);
  });

  it("asking a reader for a key its tool does not declare is a programming error, loudly", () => {
    const reader = createToolOptionsReader(ERASER_OPTIONS);
    expect(() => reader.number("angle")).toThrow(/no number option "angle"/);
    expect(() => reader.select("size")).toThrow(/no select option "size"/);
  });
});

// -------------------------------------------------------------- engine

describe("tool options — paintbrush + blob brush (real engine, F1)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  // A straight horizontal stroke on empty page: its swept outline's
  // HEIGHT is the nib's deposited width, so the option is readable
  // straight off the bounds.
  const LINE: [number, number][] = [
    [420, 60],
    [460, 60],
    [500, 60],
    [540, 60],
  ];
  /** width = size · (r + (1 − r)·|sin(tangent − θ)|) at neutral
   *  pressure, for a horizontal tangent. */
  const deposited = (size: number, angleDeg: number, roundnessPct: number) => {
    const r = roundnessPct / 100;
    return size * (r + (1 - r) * Math.abs(Math.sin((-angleDeg * Math.PI) / 180)));
  };

  it("with no host store the stroke is the one the tool always made (the literal pre-options commit)", async () => {
    const handler = createPaintbrushHandler(h.host);
    handler.onActivate(undefined as never);
    const { table } = await sweepAndRead(h, handler, LINE);

    // The pre-options commit, by hand: the machine with the old
    // constants as LITERALS, through the same two wire builders.
    const machine = new BrushMachine({
      tolerance: h.host.viewport.pxToPt(2),
      nib: { angle: Math.PI / 4, roundness: 0.3, size: 6 },
    });
    machine.handle({ type: "down", point: LINE[0], pressure: 0.5 });
    for (const p of LINE.slice(1)) {
      machine.handle({ type: "move", point: p, pressure: 0.5 });
    }
    const commit = machine.handle({
      type: "up",
      point: LINE[LINE.length - 1],
      pressure: 0.5,
    }).commit!;
    const inserted = await h.host.document.mutate(
      insertPathMutationFor(PAGE, commit.anchors, commit.open),
    );
    if (!inserted.applied || !inserted.createdId) {
      throw new Error("the reference insert failed");
    }
    const outlined = await h.host.document.mutate(
      outlineStrokeVariableMutationFor(inserted.createdId, commit.widths),
    );
    expect(outlined.applied).toBe(true);
    const reference = await h.host.document.pathAnchors(inserted.createdId);

    expect(shapeOf(table)).toEqual(shapeOf(reference!));
    const [, minY, , maxY] = boxOf(table);
    expect(maxY - minY).toBeCloseTo(deposited(6, 45, 30), 1);
    handler.onDeactivate("switch");
  });

  it("a store holding the defaults explicitly gives the SAME stroke — the reader adds nothing", async () => {
    const bare = createPaintbrushHandler(h.host);
    bare.onActivate(undefined as never);
    const a = await sweepAndRead(h, bare, LINE);

    const store = settingsStore({
      [PAINTBRUSH_OPTIONS.toolId]: {
        size: 6,
        angle: 45,
        roundness: 30,
        fidelity: 2,
      },
    });
    const stored = createPaintbrushHandler(h.host);
    stored.onActivate(store.paged as never);
    const b = await sweepAndRead(h, stored, LINE);

    expect(shapeOf(b.table)).toEqual(shapeOf(a.table));
  });

  it("a WIDER nib commits a wider swept outline; the centerline's length is unchanged", async () => {
    const store = settingsStore();
    const handler = createPaintbrushHandler(h.host);
    handler.onActivate(store.paged as never);

    const thin = boxOf((await sweepAndRead(h, handler, LINE)).table);
    // The popover writes; the SAME activation's next stroke reads it.
    store.paged.toolSettings.set(PAINTBRUSH_OPTIONS.toolId, "size", 24);
    const thick = boxOf((await sweepAndRead(h, handler, LINE)).table);

    const thinH = thin[3] - thin[1];
    const thickH = thick[3] - thick[1];
    expect(thinH).toBeCloseTo(deposited(6, 45, 30), 1);
    expect(thickH).toBeCloseTo(deposited(24, 45, 30), 1);
    expect(thickH / thinH).toBeCloseTo(4, 1);
    // Both sweeps are centred on the same line.
    expect((thick[1] + thick[3]) / 2).toBeCloseTo((thin[1] + thin[3]) / 2, 1);
    handler.onDeactivate("switch");
  });

  it("the nib ANGLE and ROUNDNESS reach the sweep: a nib held along the stroke deposits only its thickness", async () => {
    // θ = 0° along a horizontal stroke: |sin| = 0, so the width is
    // roundness · size — and a ROUND nib ignores the angle altogether.
    const id = PAINTBRUSH_OPTIONS.toolId;
    const store = settingsStore({ [id]: { size: 20, angle: 0, roundness: 25 } });
    const handler = createPaintbrushHandler(h.host);
    handler.onActivate(store.paged as never);
    const flat = boxOf((await sweepAndRead(h, handler, LINE)).table);
    expect(flat[3] - flat[1]).toBeCloseTo(5, 1);

    store.paged.toolSettings.set(id, "roundness", 100);
    const round = boxOf((await sweepAndRead(h, handler, LINE)).table);
    expect(round[3] - round[1]).toBeCloseTo(20, 1);

    store.paged.toolSettings.set(id, "roundness", 25);
    store.paged.toolSettings.set(id, "angle", 90);
    const across = boxOf((await sweepAndRead(h, handler, LINE)).table);
    expect(across[3] - across[1]).toBeCloseTo(20, 1);
    handler.onDeactivate("switch");
  });

  it("the blob brush reads ITS OWN size, not the paintbrush's", async () => {
    const store = settingsStore({
      [PAINTBRUSH_OPTIONS.toolId]: { size: 60 },
      [BLOB_BRUSH_OPTIONS.toolId]: { size: 12 },
    });
    const handler = createBlobBrushHandler(h.host);
    handler.onActivate(store.paged as never);
    const box = boxOf((await sweepAndRead(h, handler, LINE)).table);
    expect(box[3] - box[1]).toBeCloseTo(deposited(12, 45, 30), 1);
    handler.onDeactivate("switch");
  });
});

describe("tool options — eraser (real engine, F4)", () => {
  let h: HeadlessHost;
  const UA = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;

  // ua is the square (100..300)²; a full horizontal crossing at y = 200
  // splits it into a top and a bottom part, and the gap between them is
  // the band the eraser cut.
  const CUT: [number, number][] = [
    [50, 200],
    [150, 200],
    [250, 200],
    [350, 200],
  ];

  /** The gap the eraser left around y = 200: the nearest geometry above
   *  and below the cut line. */
  async function gapAfterCut(size: number | null): Promise<number> {
    await h.load(F4_OVERLAP.bytes());
    await h.host.selection.set([UA]);
    const before = (await h.host.document.pathAnchors(UA))!.anchors.length;
    const handler = createEraserBrushHandler(h.host);
    const store = settingsStore(
      size === null ? {} : { [ERASER_OPTIONS.toolId]: { size } },
    );
    handler.onActivate((size === null ? undefined : store.paged) as never);
    stroke(handler, CUT);
    await until(async () => {
      const t = await h.host.document.pathAnchors(UA);
      return !!t && t.anchors.length !== before;
    });
    const table = (await h.host.document.pathAnchors(UA))!;
    let above = -Infinity;
    let below = Infinity;
    for (const a of table.anchors) {
      const y = a.anchor[1];
      if (y < 200 && y > above) above = y;
      if (y > 200 && y < below) below = y;
    }
    handler.onDeactivate("switch");
    return below - above;
  }

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("the default cut is the 6 pt band the eraser always cut", async () => {
    expect(await gapAfterCut(null)).toBeCloseTo(6, 1);
  });

  it("a bigger eraser cuts a wider gap — the size reaches BOTH the machine and the outline", async () => {
    expect(await gapAfterCut(30)).toBeCloseTo(30, 1);
    expect(await gapAfterCut(2)).toBeCloseTo(2, 1);
  });
});

describe("tool options — pencil (real engine, F1)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  // A zig-zag whose wobble is 8 pt: it survives a 2 px fidelity and
  // collapses under a 10 px one.
  const WOBBLE: [number, number][] = [
    [420, 60],
    [440, 68],
    [460, 60],
    [480, 68],
    [500, 60],
    [520, 68],
    [540, 60],
  ];
  // A loop that ends 5 pt from where it began.
  const LOOP: [number, number][] = [
    [450, 150],
    [520, 150],
    [520, 220],
    [450, 220],
    [453, 154],
  ];

  it("with no host store the stroke is the one the pencil always made (the literal pre-options commit)", async () => {
    const handler = createPencilHandler(h.host);
    handler.onActivate(undefined as never);
    const { table } = await sweepAndRead(h, handler, WOBBLE);

    const machine = new PencilMachine({
      tolerance: h.host.viewport.pxToPt(2),
      closeTolerance: h.host.viewport.pxToPt(8),
    });
    machine.handle({ type: "down", point: WOBBLE[0], pressure: 0.5 });
    for (const p of WOBBLE.slice(1)) {
      machine.handle({ type: "move", point: p, pressure: 0.5 });
    }
    const commit = machine.handle({
      type: "up",
      point: WOBBLE[WOBBLE.length - 1],
      pressure: 0.5,
    }).commit!;
    const inserted = await h.host.document.mutate(
      insertPathMutationFor(PAGE, commit.anchors, commit.open),
    );
    if (!inserted.applied || !inserted.createdId) {
      throw new Error("the reference insert failed");
    }
    const reference = await h.host.document.pathAnchors(inserted.createdId);
    expect(shapeOf(table)).toEqual(shapeOf(reference!));
    expect(table.anchors).toHaveLength(WOBBLE.length);
    handler.onDeactivate("switch");
  });

  it("a coarser FIDELITY keeps fewer anchors of the same stroke", async () => {
    const id = PENCIL_OPTIONS.toolId;
    const store = settingsStore();
    const handler = createPencilHandler(h.host);
    handler.onActivate(store.paged as never);
    const fine = (await sweepAndRead(h, handler, WOBBLE)).table;
    store.paged.toolSettings.set(id, "fidelity", 10);
    const coarse = (await sweepAndRead(h, handler, WOBBLE)).table;
    expect(fine.anchors).toHaveLength(WOBBLE.length);
    expect(coarse.anchors).toHaveLength(2);
    handler.onDeactivate("switch");
  });

  it("SMOOTHING: `corners` commits corner anchors, the default fits curves", async () => {
    const id = PENCIL_OPTIONS.toolId;
    const store = settingsStore();
    const handler = createPencilHandler(h.host);
    handler.onActivate(store.paged as never);
    const isCorner = (a: { anchor: number[]; left: number[]; right: number[] }) =>
      a.left[0] === a.anchor[0] &&
      a.left[1] === a.anchor[1] &&
      a.right[0] === a.anchor[0] &&
      a.right[1] === a.anchor[1];

    const smooth = (await sweepAndRead(h, handler, WOBBLE)).table;
    expect(smooth.anchors.some((a) => !isCorner(a))).toBe(true);

    store.paged.toolSettings.set(id, "smoothing", "corners");
    const corners = (await sweepAndRead(h, handler, WOBBLE)).table;
    expect(corners.anchors.every(isCorner)).toBe(true);
    // Same samples, same simplification — only the handles differ.
    expect(corners.anchors.map((a) => a.anchor)).toEqual(
      smooth.anchors.map((a) => a.anchor),
    );
    handler.onDeactivate("switch");
  });

  it("CLOSE DISTANCE: the default closes a loop lifted 5 pt from its start; 0 never closes", async () => {
    const id = PENCIL_OPTIONS.toolId;
    const store = settingsStore();
    const handler = createPencilHandler(h.host);
    handler.onActivate(store.paged as never);
    const closed = (await sweepAndRead(h, handler, LOOP)).table;
    expect(closed.subpathOpen?.[0]).toBe(false);

    store.paged.toolSettings.set(id, "closeDistance", 0);
    const open = (await sweepAndRead(h, handler, LOOP)).table;
    expect(open.subpathOpen?.[0]).toBe(true);
    handler.onDeactivate("switch");
  });
});

describe("tool options — width tool (real engine, F1)", () => {
  let h: HeadlessHost;
  const POLY = { kind: "polygon", id: "upoly" } as ElementId;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  /** Drag upoly's middle anchor (250, 600) 20 pt upward under `values`
   *  and return the baked outline. Each run starts from a fresh F1. */
  async function bake(
    values: Record<string, unknown> | null,
  ): Promise<PathAnchorsResult> {
    await h.load(F1_MULTI_SHAPE.bytes());
    await h.host.selection.set([POLY]);
    const handler = createWidthHandler(h.host);
    const store = settingsStore(
      values ? { [WIDTH_OPTIONS.toolId]: values } : {},
    );
    handler.onActivate((values ? store.paged : undefined) as never);
    handler.onPointerDown(pointer([250, 600]));
    handler.onPointerMove(pointer([250, 580], 30));
    handler.onPointerUp(pointer([250, 580], 30));
    await until(async () => {
      const t = await h.host.document.pathAnchors(POLY);
      return !!t && t.subpathOpen?.[0] === false;
    });
    handler.onDeactivate("switch");
    return (await h.host.document.pathAnchors(POLY))!;
  }

  /** The same bake with NO handler: the machine built from `options`,
   *  its commit sent through the wire builder. */
  async function bakeByHand(options: {
    falloff: number;
    gain: number;
    maxWidth: number;
  }): Promise<PathAnchorsResult> {
    await h.load(F1_MULTI_SHAPE.bytes());
    const table = (await h.host.document.pathAnchors(POLY))!;
    const machine = new WidthMachine({
      anchors: table.anchors.map((a) => [a.anchor[0], a.anchor[1]]),
      tolerance: h.host.viewport.pxToPt(8),
      baseWidth: 1,
      ...options,
    });
    machine.handle({ type: "down", point: [250, 600] });
    machine.handle({ type: "move", point: [250, 580] });
    const commit = machine.handle({ type: "up", point: [250, 580] }).commit!;
    const outcome = await h.host.document.mutate(
      outlineStrokeVariableMutationFor(POLY, commit.widths),
    );
    expect(outcome.applied).toBe(true);
    return (await h.host.document.pathAnchors(POLY))!;
  }

  it("with no host store the bake is the one the tool always made (2 / 1 / 72, as literals)", async () => {
    const live = await bake(null);
    const reference = await bakeByHand({ falloff: 2, gain: 1, maxWidth: 72 });
    expect(shapeOf(live)).toEqual(shapeOf(reference));
  });

  it("the PEAK LIMIT caps the bulge: a 20 pt drag under a 5 pt limit bakes a thinner outline", async () => {
    const free = await bake({});
    const capped = await bake({ maxWidth: 5 });
    expect(shapeOf(capped)).toEqual(
      shapeOf(await bakeByHand({ falloff: 2, gain: 1, maxWidth: 5 })),
    );
    // The peak sits at the path's lowest point (250, 600): the outline
    // reaches half the peak width below it.
    expect(boxOf(free)[3]).toBeGreaterThan(boxOf(capped)[3] + 4);
  });

  it("GAIN and FALLOFF reach the profile", async () => {
    const steep = await bake({ gain: 3 });
    expect(shapeOf(steep)).toEqual(
      shapeOf(await bakeByHand({ falloff: 2, gain: 3, maxWidth: 72 })),
    );
    const narrow = await bake({ falloff: 1 });
    expect(shapeOf(narrow)).toEqual(
      shapeOf(await bakeByHand({ falloff: 1, gain: 1, maxWidth: 72 })),
    );
    const base = await bake({});
    expect(boxOf(steep)[3]).toBeGreaterThan(boxOf(base)[3] + 10);
  });
});
