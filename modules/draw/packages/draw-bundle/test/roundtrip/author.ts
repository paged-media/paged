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

// The ROUND-TRIP lane's AUTHOR: one document per Tier-A row, built
// through paged.draw's REAL surfaces on the real headless engine — the
// Pen machine for drawing, the bundle's registered COMMANDS (looked up in
// the contribution log and fired with the payload a panel or menu would
// hand them), its importer and its exported apply functions where a flow
// returns what it built. `generate.spec.ts` exports each one as IDML into
// `test/fixtures/roundtrip/<case>.idml` for InDesign to read; the replay
// specs re-author the SAME document and compare.
//
// WHERE NO DRAW SURFACE EXISTS the case writes what the surface that
// does exist would write, and says so in `surfaces`:
//   * "panel"  — a schema-panel row the HOST widget commits (the Stroke
//                panel's Weight / Cap / Line-ends rows, the Fill panel's
//                swatch row): a `setElementProperty` on the row's own
//                path with the row's own token;
//   * "wire"   — no draw surface writes it at all (stroke join / miter
//                limit; a document swatch; a free story for Type on a
//                Path, which no op mints): the wire op itself;
//   * "builder"— draw's exported wire builder where the bundle has no
//                command (`groupMutationFor` — Group is a HOST command
//                now — and `cornerStyleMutationFor` for InsetCorner,
//                which has no preset command).
// Everything else is "command" or "machine" or "importer".
//
// THE BASE DOCUMENT is the conformance scaffold (`build-idml.ts`): one US
// Letter page "usp" and nothing else, or — where a row needs an element
// draw cannot mint (a `<Rectangle>`, a `<GraphicLine>`) — that element
// authored in the source XML, the way a user's own IDML would carry it.

import type {
  CommandContribution,
  ElementId,
  MutationInput,
  MutationOutcome,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { PenMachine, penPlanMutation, type PenPlan } from "@paged-media/draw-tools";

import {
  applyAttachTextToPath,
  commitAppearance,
  cornerStyleMutationFor,
  drawBundle,
  gradientAxisMutationFor,
  groupMutationFor,
  importSvg,
  resetBlendSwatchSeq,
  setTextOnPathStory,
  writeGraphicStyleLibrary,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { openHost } from "../conformance/host";
import { exportIdml } from "./package";

export const PAGE = "usp";

export type Vec2 = [number, number];

/** How a case reached the engine — see the header. */
export type Surface = "machine" | "command" | "importer" | "panel" | "builder" | "wire";

/** Something the author ASKED for that the engine refused. Kept, because
 *  a refused write is a capability gap the InDesign comparison cannot see
 *  (the item simply keeps its default). */
export interface Refusal {
  what: string;
  error: string;
}

export interface AuthorContext {
  h: HeadlessHost;
  /** Draw one path with the Pen MACHINE (draw-tools `PenMachine`, the
   *  machine the editor's Pen tool wraps): a click per point, a drag
   *  where `drag` is given (it pulls the outgoing handle and mirrors the
   *  incoming one), then Enter — or a click back on the first anchor to
   *  close. Commits the plan through `penPlanMutation`. */
  pen(points: readonly PenPoint[], close: boolean): Promise<ElementId>;
  /** Fire a registered draw command with a payload, as a menu / panel
   *  does. THROWS when the command is not registered. */
  command(id: string, payload?: unknown): Promise<void>;
  select(ids: readonly ElementId[]): Promise<void>;
  /** Apply a mutation; THROWS when refused. */
  mutate(m: MutationInput, what: string): Promise<MutationOutcome>;
  /** Apply a mutation; a refusal is RECORDED (see `Refusal`), not thrown. */
  attempt(m: MutationInput, what: string): Promise<boolean>;
  /** A document swatch (RGB 0-255), `Color/<id>`, named `name` (default:
   *  the id) — "wire": no draw surface creates a swatch. */
  swatch(id: string, rgb: [number, number, number], name?: string): Promise<string>;
  /** The Fill panel's swatch row: `frameFillColor` ("panel"). */
  fill(id: ElementId, colorRef: string | null): Promise<void>;
  /** The Stroke panel's Weight row: `frameStrokeWeight` ("panel"). */
  strokeWeight(id: ElementId, pt: number): Promise<void>;
  /** Every element in the tree, in tree (= paint) order. */
  tree(): Promise<SceneTreeNode[]>;
  refusals: Refusal[];
  surfaces: Set<Surface>;
}

export interface PenPoint {
  at: Vec2;
  drag?: Vec2;
}

export interface RoundtripCase {
  /** Fixture stem: `test/fixtures/roundtrip/<id>.idml`. */
  id: string;
  /** The Tier-A row this case covers. */
  row: string;
  /** The source document's page-item XML ("" = an empty page). */
  base?: string;
  author(ctx: AuthorContext): Promise<void>;
}

export interface AuthoredCase {
  h: HeadlessHost;
  idml: Uint8Array;
  /** The engine's own list of what the IDML could not carry. */
  lost: string[];
  refusals: Refusal[];
  surfaces: Surface[];
}

// ---------------------------------------------------------------------------
// The authoring context
// ---------------------------------------------------------------------------

const NO_MODIFIERS = { shift: false, alt: false };

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

function context(h: HeadlessHost): AuthorContext {
  const refusals: Refusal[] = [];
  const surfaces = new Set<Surface>();
  const mutate = async (m: MutationInput, what: string): Promise<MutationOutcome> => {
    const outcome = await h.host.document.mutate(m);
    if (!outcome.applied) {
      throw new Error(`${what}: the engine refused ${JSON.stringify(outcome)}`);
    }
    return outcome;
  };
  const ctx: AuthorContext = {
    h,
    refusals,
    surfaces,
    async pen(points, close) {
      surfaces.add("machine");
      const m = new PenMachine({ closeTolerance: 4, dragThreshold: 2 });
      for (const p of points) {
        m.handle({ type: "down", point: p.at, modifiers: NO_MODIFIERS });
        if (p.drag) m.handle({ type: "move", point: p.drag, modifiers: NO_MODIFIERS });
        m.handle({ type: "up", point: p.drag ?? p.at, modifiers: NO_MODIFIERS });
      }
      let snap;
      if (close) {
        m.handle({ type: "down", point: points[0].at, modifiers: NO_MODIFIERS });
        snap = m.handle({ type: "up", point: points[0].at, modifiers: NO_MODIFIERS });
      } else {
        snap = m.handle({ type: "key", key: "Enter" });
      }
      const plan: PenPlan | null =
        snap.plan ??
        (snap.commit
          ? { kind: "insertPath", anchors: snap.commit.anchors, open: snap.commit.open }
          : null);
      if (!plan || plan.kind !== "insertPath") {
        throw new Error(`the pen committed no new path (${JSON.stringify(snap.plan)})`);
      }
      if (plan.open === close) throw new Error("the pen did not close/open the path as asked");
      const outcome = await mutate(penPlanMutation(plan, PAGE) as MutationInput, "pen");
      const id = (outcome as { createdId?: ElementId | null }).createdId;
      if (!id) throw new Error("the pen's insertPath created nothing");
      return id;
    },
    async command(id, payload) {
      surfaces.add("command");
      await commandFor(h, id).handler(undefined, payload);
    },
    async select(ids) {
      await h.host.selection.set([...ids]);
    },
    mutate,
    async attempt(m, what) {
      const outcome = await h.host.document.mutate(m);
      if (!outcome.applied) {
        refusals.push({ what, error: JSON.stringify((outcome as { error?: unknown }).error ?? outcome) });
      }
      return outcome.applied;
    },
    async swatch(swatchId, rgb, name = swatchId) {
      surfaces.add("wire");
      const selfId = `Color/${swatchId}`;
      await mutate(
        { op: "createSwatch", args: { spec: { selfId, name, space: "RGB", value: [...rgb] } } } as MutationInput,
        `swatch ${name}`,
      );
      return selfId;
    },
    async fill(id, colorRef) {
      surfaces.add("panel");
      await mutate(
        {
          op: "setElementProperty",
          args: { elementId: id, path: "frameFillColor", value: { type: "colorRef", value: colorRef } },
        } as MutationInput,
        "Fill panel: frameFillColor",
      );
    },
    async strokeWeight(id, pt) {
      surfaces.add("panel");
      await mutate(
        {
          op: "setElementProperty",
          args: { elementId: id, path: "frameStrokeWeight", value: { type: "length", value: pt } },
        } as MutationInput,
        "Stroke panel: frameStrokeWeight",
      );
    },
    tree: () => h.host.document.tree(),
  };
  return ctx;
}

/** Author one case on a FRESH headless engine and export it. The host is
 *  returned open — the caller reads the model back, then disposes it. */
export async function authorCase(c: RoundtripCase): Promise<AuthoredCase> {
  const h = await openHost();
  await h.load(packageWithSpread(c.base ?? ""));
  h.loadBundle(drawBundle);
  // Module-level id counters (the blend swatch nonce) start from zero per
  // case, so a case authors the same document alone or in a run.
  resetBlendSwatchSeq();
  setTextOnPathStory(null);
  const ctx = context(h);
  await c.author(ctx);
  const { bytes, lost } = await exportIdml(h);
  return { h, idml: bytes, lost, refusals: ctx.refusals, surfaces: [...ctx.surfaces].sort() };
}

// ---------------------------------------------------------------------------
// Geometry the cases share (points, page-local, Y down)
// ---------------------------------------------------------------------------

/** One cubic per quarter circle. */
const KAPPA = 0.5522847498;

/** A pen-drawn circle: four drags, clockwise on a Y-down page from the
 *  east point, then a click back on it to close. */
function circle(cx: number, cy: number, r: number): PenPoint[] {
  const k = r * KAPPA;
  return [
    { at: [cx + r, cy], drag: [cx + r, cy + k] },
    { at: [cx, cy + r], drag: [cx - k, cy + r] },
    { at: [cx - r, cy], drag: [cx - r, cy - k] },
    { at: [cx, cy - r], drag: [cx + k, cy - r] },
  ];
}

/** A pen-drawn axis-aligned rectangle: four clicks, clockwise. */
function box(x0: number, y0: number, x1: number, y1: number): PenPoint[] {
  return [{ at: [x0, y0] }, { at: [x1, y0] }, { at: [x1, y1] }, { at: [x0, y1] }];
}

/** The `<Rectangle>` a user's own IDML carries (draw cannot mint one:
 *  every draw insert is a `<Polygon>`). */
function rectangleXml(self: string, top: number, left: number, bottom: number, right: number): string {
  const pt = (x: number, y: number) =>
    `<PathPointType Anchor="${x} ${y}" LeftDirection="${x} ${y}" RightDirection="${x} ${y}"/>`;
  return (
    `<Rectangle Self="${self}" GeometricBounds="${top} ${left} ${bottom} ${right}" ` +
    `ItemTransform="1 0 0 1 0 0" FillColor="Color/Black">` +
    `<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
    pt(left, top) + pt(left, bottom) + pt(right, bottom) + pt(right, top) +
    `</PathPointArray></GeometryPathType></PathGeometry></Properties></Rectangle>`
  );
}

/** A stroked `<GraphicLine>` a user's own IDML carries. */
function graphicLineXml(self: string, a: Vec2, b: Vec2): string {
  const pt = (p: Vec2) =>
    `<PathPointType Anchor="${p[0]} ${p[1]}" LeftDirection="${p[0]} ${p[1]}" RightDirection="${p[0]} ${p[1]}"/>`;
  return (
    `<GraphicLine Self="${self}" ItemTransform="1 0 0 1 0 0" StrokeColor="Color/Black" StrokeWeight="3">` +
    `<Properties><PathGeometry><GeometryPathType PathOpen="true"><PathPointArray>` +
    pt(a) + pt(b) +
    `</PathPointArray></GeometryPathType></PathGeometry></Properties></GraphicLine>`
  );
}

const D = "media.paged.draw.command.";

/** Text set on a `setElementProperty` text path ("panel"). */
const textProp = (elementId: ElementId, path: string, value: string): MutationInput =>
  ({ op: "setElementProperty", args: { elementId, path, value: { type: "text", value } } }) as MutationInput;
const lengthProp = (elementId: ElementId, path: string, value: number): MutationInput =>
  ({ op: "setElementProperty", args: { elementId, path, value: { type: "length", value } } }) as MutationInput;

/** The Illustrator oracle's pathfinder inputs: a circle (back) cut by a
 *  rectangle (front), both filled, so every verb cuts curves. */
async function pathfinderInputs(ctx: AuthorContext): Promise<[ElementId, ElementId]> {
  const blue = await ctx.swatch("rt-blue", [40, 90, 200]);
  const orange = await ctx.swatch("rt-orange", [240, 140, 30]);
  const back = await ctx.pen(circle(160, 160, 50), true);
  await ctx.fill(back, blue);
  const front = await ctx.pen(box(150, 130, 260, 190), true);
  await ctx.fill(front, orange);
  return [back, front];
}

// ---------------------------------------------------------------------------
// The cases — one per Tier-A row, more where a row has variants
// ---------------------------------------------------------------------------

const PATHFINDER_VERBS = [
  ["union", "pathfinderUnite"],
  ["subtract", "pathfinderSubtract"],
  ["intersect", "pathfinderIntersect"],
  ["exclude", "pathfinderExclude"],
] as const;

/** Live-corner styles and the surface that applies each: the four preset
 *  commands, and InsetCorner through draw's own builder (it is in the
 *  token vocabulary but has no command). */
const CORNER_STYLES = [
  ["RoundedCorner", "cornersRounded"],
  ["InverseRoundedCorner", "cornersInverseRounded"],
  ["BeveledCorner", "cornersBevel"],
  ["FancyCorner", "cornersFancy"],
  ["InsetCorner", null],
] as const;

async function applyCornerStyle(
  ctx: AuthorContext,
  id: ElementId,
  style: string,
  command: string | null,
): Promise<void> {
  await ctx.select([id]);
  if (command) {
    await ctx.command(D + command);
    return;
  }
  ctx.surfaces.add("builder");
  await ctx.mutate(
    cornerStyleMutationFor(id, {
      id: "roundtrip.inset",
      title: "Inset",
      style: style as never,
      radius: 12,
    }) as MutationInput,
    `corner style ${style}`,
  );
}

export const ROUNDTRIP_CASES: readonly RoundtripCase[] = [
  {
    id: "pen-open",
    row: "pen path — open, with curves",
    async author(ctx) {
      await ctx.pen(
        [
          { at: [100, 200], drag: [150, 120] },
          { at: [260, 200], drag: [320, 280] },
          { at: [420, 200] },
        ],
        false,
      );
    },
  },
  {
    id: "pen-closed",
    row: "pen path — closed, with curves",
    async author(ctx) {
      const id = await ctx.pen(circle(300, 300, 100), true);
      await ctx.fill(id, await ctx.swatch("rt-teal", [20, 160, 150]));
    },
  },
  {
    id: "compound-hole",
    row: "compound path with a hole",
    async author(ctx) {
      const outer = await ctx.pen(box(100, 100, 400, 400), true);
      const inner = await ctx.pen(circle(250, 250, 70), true);
      await ctx.fill(outer, "Color/Black");
      await ctx.fill(inner, "Color/Black");
      await ctx.select([outer, inner]);
      await ctx.command(D + "makeCompoundPath");
    },
  },
  ...PATHFINDER_VERBS.map(
    ([kind, command]): RoundtripCase => ({
      id: `pathfinder-${kind}`,
      row: `Pathfinder ${kind}`,
      async author(ctx) {
        const [back, front] = await pathfinderInputs(ctx);
        await ctx.select([back, front]);
        await ctx.command(D + command);
      },
    }),
  ),
  {
    id: "pathfinder-divide",
    row: "Pathfinder Divide",
    async author(ctx) {
      const [back, front] = await pathfinderInputs(ctx);
      await ctx.select([back, front]);
      await ctx.command(D + "pathfinderDivide");
    },
  },
  {
    id: "offset-path",
    row: "offset path",
    async author(ctx) {
      // A closed shape with one curved side and one acute corner.
      const id = await ctx.pen(
        [
          { at: [150, 150] },
          { at: [350, 150], drag: [400, 200] },
          { at: [350, 350] },
          { at: [200, 300] },
        ],
        true,
      );
      await ctx.fill(id, await ctx.swatch("rt-green", [60, 170, 70]));
      await ctx.select([id]);
      await ctx.command(D + "offsetPath", { delta: 12, join: "miter", miterLimit: 4 });
    },
  },
  {
    id: "outline-stroke",
    row: "outline stroke",
    async author(ctx) {
      const id = await ctx.pen(
        [{ at: [120, 300], drag: [200, 200] }, { at: [320, 300], drag: [400, 400] }, { at: [480, 300] }],
        false,
      );
      await ctx.strokeWeight(id, 16);
      await ctx.select([id]);
      await ctx.command(D + "outlineStroke", { width: 16, cap: "round", join: "round" });
    },
  },
  {
    id: "simplify",
    row: "simplify",
    async author(ctx) {
      // A wobbly open line: many anchors a few points off one arc.
      const pts: PenPoint[] = [];
      for (let i = 0; i <= 12; i++) {
        const x = 100 + i * 30;
        const y = 300 - 120 * Math.sin((Math.PI * i) / 12) + (i % 2 === 0 ? 3 : -3);
        pts.push({ at: [x, Math.round(y * 100) / 100] });
      }
      const id = await ctx.pen(pts, false);
      await ctx.strokeWeight(id, 2);
      await ctx.select([id]);
      await ctx.command(D + "simplifyPath", { tolerance: 8 });
    },
  },
  {
    id: "join",
    row: "join",
    async author(ctx) {
      const a = await ctx.pen([{ at: [100, 200], drag: [150, 150] }, { at: [250, 200] }], false);
      const b = await ctx.pen([{ at: [250, 200] }, { at: [400, 200], drag: [450, 250] }], false);
      await ctx.strokeWeight(a, 3);
      await ctx.strokeWeight(b, 3);
      await ctx.select([a, b]);
      await ctx.command(D + "joinEndpoints");
    },
  },
  {
    id: "live-corners-rectangle",
    row: "live corners — every style, on a Rectangle",
    base: CORNER_STYLES.map((_, i) =>
      rectangleXml(`rc${i}`, 60 + i * 140, 100, 160 + i * 140, 300),
    ).join(""),
    async author(ctx) {
      for (const [i, [style, command]] of CORNER_STYLES.entries()) {
        await applyCornerStyle(ctx, { kind: "rectangle", id: `rc${i}` } as ElementId, style, command);
      }
    },
  },
  {
    id: "live-corners-polygon",
    row: "live corners — every style, on a Polygon",
    async author(ctx) {
      for (const [i, [style, command]] of CORNER_STYLES.entries()) {
        const id = await ctx.pen(box(100, 60 + i * 140, 300, 160 + i * 140), true);
        await ctx.fill(id, "Color/Black");
        await applyCornerStyle(ctx, id, style, command);
      }
    },
  },
  {
    id: "dash-presets",
    row: "dash presets",
    async author(ctx) {
      const presets = ["strokeDashSolid", "strokeDashDashed", "strokeDashDotted", "strokeDashDashDot"];
      for (const [i, preset] of presets.entries()) {
        const y = 150 + i * 100;
        const id = await ctx.pen([{ at: [100, y] }, { at: [500, y] }], false);
        await ctx.strokeWeight(id, 4);
        await ctx.select([id]);
        await ctx.command(D + preset);
      }
    },
  },
  {
    id: "arrowheads",
    row: "arrowheads on a line",
    base: graphicLineXml("uline", [100, 150], [500, 150]),
    async author(ctx) {
      // The Stroke panel's Line-ends section: a GraphicLine takes them.
      ctx.surfaces.add("panel");
      const line = { kind: "graphicLine", id: "uline" } as ElementId;
      await ctx.mutate(textProp(line, "frameStrokeStartArrowhead", "CircleSolidArrowHead"), "start arrowhead");
      await ctx.mutate(textProp(line, "frameStrokeEndArrowhead", "TriangleArrowHead"), "end arrowhead");
      // A Pen-drawn line is a POLYGON: the same two writes are attempted
      // and their refusal is recorded (RFI C-62 — caps / arrowheads on
      // paths are being added to the engine).
      const pen = await ctx.pen([{ at: [100, 300] }, { at: [500, 300] }], false);
      await ctx.strokeWeight(pen, 3);
      await ctx.attempt(textProp(pen, "frameStrokeStartArrowhead", "CircleSolidArrowHead"), "start arrowhead on a pen path");
      await ctx.attempt(textProp(pen, "frameStrokeEndArrowhead", "TriangleArrowHead"), "end arrowhead on a pen path");
    },
  },
  {
    id: "stroke-attributes",
    row: "stroke weight / cap / join / miter",
    async author(ctx) {
      // Three zig-zags at 10 pt: round join, bevel join, miter join with a
      // miter limit low enough to bevel the sharp apex. Join and miter
      // limit have NO draw surface (no panel row, no command) — "wire".
      const zig = (y: number): PenPoint[] => [
        { at: [100, y + 60] },
        { at: [200, y] },
        { at: [300, y + 60] },
        { at: [400, y] },
      ];
      const joins: [string, number | null][] = [
        ["RoundEndJoin", null],
        ["BevelEndJoin", null],
        ["MiterEndJoin", 2],
      ];
      for (const [i, [join, miter]] of joins.entries()) {
        const id = await ctx.pen(zig(100 + i * 150), false);
        await ctx.strokeWeight(id, 10);
        ctx.surfaces.add("wire");
        await ctx.attempt(textProp(id, "frameStrokeJoin", join), `join ${join}`);
        if (miter !== null) await ctx.attempt(lengthProp(id, "frameStrokeMiterLimit", miter), "miter limit");
        // The Stroke panel's Cap row on the first one (a POLYGON — RFI
        // C-62: the attempt is recorded either way).
        if (i === 0) await ctx.attempt(textProp(id, "frameStrokeEndCap", "RoundEndCap"), "cap on a pen path");
      }
    },
  },
  {
    id: "gradient-linear",
    row: "linear gradient fill",
    async author(ctx) {
      const id = await ctx.pen(box(100, 100, 400, 300), true);
      await ctx.select([id]);
      await ctx.command(D + "fillGradientLinear");
      // The Gradient Annotator's drag commits the axis (angle, length).
      ctx.surfaces.add("builder");
      await ctx.mutate(gradientAxisMutationFor([id], 30, 250) as MutationInput, "gradient axis");
    },
  },
  {
    id: "gradient-radial",
    row: "radial gradient fill",
    async author(ctx) {
      const id = await ctx.pen(circle(300, 300, 120), true);
      await ctx.select([id]);
      await ctx.command(D + "fillGradientRadial");
    },
  },
  {
    id: "opacity-blend",
    row: "opacity + blend mode",
    async author(ctx) {
      const red = await ctx.swatch("rt-red", [220, 40, 40]);
      const blue = await ctx.swatch("rt-blue", [40, 90, 200]);
      const back = await ctx.pen(box(100, 100, 300, 300), true);
      await ctx.fill(back, red);
      const front = await ctx.pen(circle(300, 300, 100), true);
      await ctx.fill(front, blue);
      // A Graphic Style carrying opacity 50 + Multiply, applied with the
      // draw command (the library is seeded as the Save command would
      // leave it; no draw surface sets an item's own opacity directly).
      const saved = await writeGraphicStyleLibrary(ctx.h.host, {
        v: 1,
        styles: [
          {
            id: "gs-roundtrip",
            name: "Half Multiply",
            appearance: {
              stack: { fills: [], strokes: [] },
              base: {
                fill: blue,
                fillTint: null,
                stroke: "Color/Black",
                strokeWeight: 1,
                opacity: 50,
                blendMode: "Multiply",
              },
            },
          },
        ],
      });
      if (!saved) throw new Error("the graphic style library was not written (no parts writer)");
      await ctx.select([front]);
      await ctx.command(D + "applyGraphicStyle", { styleId: "gs-roundtrip" });
    },
  },
  {
    id: "group",
    row: "a group",
    async author(ctx) {
      const a = await ctx.pen(box(100, 100, 220, 220), true);
      const b = await ctx.pen(circle(300, 160, 60), true);
      const c = await ctx.pen([{ at: [380, 100] }, { at: [480, 220] }], false);
      await ctx.fill(a, "Color/Black");
      ctx.surfaces.add("builder");
      await ctx.mutate(groupMutationFor([a, b, c]) as MutationInput, "group");
    },
  },
  {
    id: "appearance-bake",
    row: "appearance bake (a group of stacked items)",
    base: rectangleXml("urect", 100, 100, 300, 300),
    async author(ctx) {
      const rect = { kind: "rectangle", id: "urect" } as ElementId;
      // A tinted + multiplied bottom fill, a Paper fill, and a
      // half-transparent stroke — every per-layer modifier the bake
      // lowers (C-19 / C-20).
      await commitAppearance(
        ctx.h.host,
        rect,
        {
          fills: [{ color: "Color/Black", tint: 40, blendMode: "Multiply" }, { color: "Color/Paper" }],
          strokes: [{ color: "Color/Black", weight: 6, opacity: 55 }],
        },
        await ctx.h.host.document.getMetadata(rect),
      );
      await ctx.select([rect]);
      await ctx.command(D + "bakeAppearance");
    },
  },
  {
    id: "repeat-expanded",
    row: "repeat (expanded)",
    async author(ctx) {
      const petal = await ctx.pen(
        [{ at: [300, 300], drag: [330, 270] }, { at: [300, 200], drag: [270, 230] }],
        true,
      );
      await ctx.fill(petal, await ctx.swatch("rt-violet", [130, 60, 180]));
      await ctx.select([petal]);
      await ctx.command(D + "makeRadialRepeat", { count: 6, radiusPt: 110, startDeg: -90 });
      await ctx.command(D + "expandRepeat", {});
    },
  },
  {
    id: "blend-expanded",
    row: "blend (expanded)",
    async author(ctx) {
      const a = await ctx.pen(box(100, 100, 180, 180), true);
      const b = await ctx.pen(circle(440, 340, 50), true);
      // Blend reads a key's RGB by parsing the swatch NAME as a CSS
      // colour (`refRgbOf`, "the narrow-facade lane"), so the keys' swatches
      // are named by hex — the blend spec's own convention.
      const red = await ctx.swatch("rt-red", [255, 0, 0], "#ff0000");
      const blue = await ctx.swatch("rt-blue", [0, 0, 255], "#0000ff");
      await ctx.fill(a, red);
      // A blend needs the same anchor count on both keys: a 4-click box
      // and a 4-drag circle.
      await ctx.fill(b, blue);
      await ctx.select([a, b]);
      await ctx.command(D + "blendSelected", { steps: 3 });
      await ctx.command(D + "expandBlend", {});
    },
  },
  {
    id: "svg-import",
    row: "SVG import of a small multi-shape file",
    async author(ctx) {
      ctx.surfaces.add("importer");
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">` +
        `<rect x="20" y="20" width="150" height="100" fill="#d62828" stroke="#003049" stroke-width="4"/>` +
        `<circle cx="280" cy="80" r="60" fill="#fcbf49"/>` +
        `<path d="M 40 260 C 120 160 200 360 280 260" fill="none" stroke="#2a9d8f" stroke-width="6"/>` +
        `<polygon points="300,180 380,280 220,280" fill="#264653" stroke="none"/>` +
        `</svg>`;
      const ids = await importSvg(ctx.h.host, {
        name: "roundtrip.svg",
        bytes: new TextEncoder().encode(svg),
        mimeType: "image/svg+xml",
      });
      if (ids.length !== 4) throw new Error(`the SVG import made ${ids.length} elements, not 4`);
    },
  },
  {
    id: "text-on-path",
    row: "text on a path",
    async author(ctx) {
      // No op mints a bare story (draw's own refusal names the workflow):
      // type into a frame, then delete the FRAME — "wire".
      ctx.surfaces.add("wire");
      const before = new Set(
        (await ctx.h.host.document.collection<{ selfId: string }>("stories")).map((s) => s.selfId),
      );
      const frame = await ctx.mutate(
        { op: "insertTextFrame", args: { pageId: PAGE, bounds: [20, 20, 140, 80] } } as MutationInput,
        "text frame",
      );
      const story = (await ctx.h.host.document.collection<{ selfId: string }>("stories")).find(
        (s) => !before.has(s.selfId),
      );
      if (!story) throw new Error("the text frame minted no story");
      await ctx.mutate(
        { op: "insertText", args: { storyId: story.selfId, offset: 0, text: "Type on a path" } } as MutationInput,
        "text",
      );
      const frameId = (frame as { createdId?: ElementId | null }).createdId;
      await ctx.mutate(
        { op: "deleteFrame", args: { frameId: String(frameId!.id) } } as MutationInput,
        "delete the frame",
      );
      const path = await ctx.pen(
        [{ at: [100, 300], drag: [200, 150] }, { at: [450, 300], drag: [550, 450] }],
        false,
      );
      ctx.surfaces.add("command");
      const ref = await applyAttachTextToPath(ctx.h.host, {
        elementId: path,
        storyId: story.selfId,
        pathTypeAlignment: "BaselinePathType",
        startBracket: 10,
      });
      if (!ref) throw new Error("Type on a Path refused to attach");
    },
  },
  {
    id: "opacity-mask",
    row: "opacity mask (expected LOST in IDML)",
    async author(ctx) {
      const target = await ctx.pen(box(100, 100, 400, 300), true);
      await ctx.fill(target, await ctx.swatch("rt-red", [220, 40, 40]));
      const mask = await ctx.pen(circle(250, 200, 90), true);
      await ctx.fill(mask, "Color/Black");
      await ctx.select([target, mask]);
      await ctx.command(D + "makeOpacityMask", {});
    },
  },
];

export const caseById = (id: string): RoundtripCase => {
  const c = ROUNDTRIP_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no round-trip case "${id}"`);
  return c;
};
