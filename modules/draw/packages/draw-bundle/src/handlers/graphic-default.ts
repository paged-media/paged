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

// THE GRAPHIC DEFAULT — the paint a drawing TOOL gives the shape it makes.
//
// InDesign draws a tool-made shape in its `[Normal Graphics Frame]` object
// style: no fill, a 1 pt `Color/Black` stroke. The engine's document
// defaults (`setDocumentDefaults`) feed every insert and start unset, so
// what a shape wears depended on which insert minted it. Changing those
// defaults is not the fix: File ▸ Place, plugin output (chart bars,
// barcode bars, web frames) and scripts mint through the same inserts and
// would all gain an outline, which InDesign does not give them either. So
// the TOOLS paint their own shape, in the same batch as the insert (one
// undo step), and only while the document has no defaults of its own:
// once the user has set any, the engine already applies them and they
// win. The editor's built-in drawing tools follow the same rule; this is
// the bundle's copy of it, for the tools that mint a shape from a gesture
// (Curvature, Pencil). Commands, panels and importers keep their inserts
// as they are, and so do the brushes: a Paintbrush / Blob Brush sweep is
// a filled shape that already paints itself (`./brush.ts`).
//
// Measured on engine 0.71.8: `insertPath` (and `insertLine`) already fall
// back to a 1 pt `Color/Black` stroke when the document has no stroke
// default, so in a File ▸ New document a Curvature or Pencil path was
// never invisible. What the tool now adds is the DOCUMENT's own
// `[Normal Graphics Frame]` — a document that styles it differently gets
// that paint — and independence from the engine's fallback.

import type {
  BundleHost,
  ElementId,
  MutationInput,
} from "@paged-media/plugin-api";

import { rawStyleProperties } from "../raw-wire";
import { batchMutationFor } from "../commands/v59-wire";

/** A shape's paint: swatch refs (`null` = none) and a stroke weight. */
export interface GraphicPaint {
  fill: string | null;
  stroke: string | null;
  strokeWeight: number | null;
}

/** The style InDesign applies to a shape drawn with a tool. */
export const NORMAL_GRAPHICS_FRAME_STYLE = "ObjectStyle/$ID/[Normal Graphics Frame]";

/** `[Normal Graphics Frame]` as InDesign ships it — what a document
 *  without that style (one made with File ▸ New) gets. */
export const INDESIGN_GRAPHIC_PAINT: GraphicPaint = {
  fill: null,
  stroke: "Color/Black",
  strokeWeight: 1,
};

/** The document's own `[Normal Graphics Frame]`, when it has one. */
async function normalGraphicsFramePaint(host: BundleHost): Promise<GraphicPaint | null> {
  const style = await rawStyleProperties(host, "object", NORMAL_GRAPHICS_FRAME_STYLE);
  if (!style) return null;
  const entry = (path: string) =>
    style.entries.find((e) => e.path === path)?.value ?? null;
  const fill = entry("frameFillColor");
  const stroke = entry("frameStrokeColor");
  const weight = entry("frameStrokeWeight");
  const ref = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    fill: fill?.type === "colorRef" ? ref(fill.value) : null,
    stroke: stroke?.type === "colorRef" ? ref(stroke.value) : null,
    strokeWeight:
      weight?.type === "length" && typeof weight.value === "number" ? weight.value : null,
  };
}

/**
 * The paint a drawing tool gives its new shape, or `null` when the
 * document has defaults of its own (the engine paints the shape with
 * them; adding ours would override the user's choice).
 */
export async function graphicPaintFor(host: BundleHost): Promise<GraphicPaint | null> {
  const [meta, style] = await Promise.all([
    host.document.meta().catch(() => null),
    normalGraphicsFramePaint(host).catch(() => null),
  ]);
  if (
    meta &&
    (meta.defaultFillColor != null ||
      meta.defaultStrokeColor != null ||
      meta.defaultStrokeWeight != null)
  ) {
    return null;
  }
  return style ?? INDESIGN_GRAPHIC_PAINT;
}

type ShapeInsertOp = "insertFrame" | "insertOval" | "insertLine" | "insertPath";

/** The element kind each shape insert mints — what `$created` is
 *  addressed as. */
const KIND_OF: Record<ShapeInsertOp, "rectangle" | "oval" | "graphicLine" | "polygon"> = {
  insertFrame: "rectangle",
  insertOval: "oval",
  insertLine: "graphicLine",
  insertPath: "polygon",
};

function shapeInsertOp(m: MutationInput): ShapeInsertOp | null {
  return Object.hasOwn(KIND_OF, m.op) ? (m.op as ShapeInsertOp) : null;
}

/** The property writes that paint the shape the batch minted last
 *  (`$created`, the engine's most-recent-creating-child sentinel). A
 *  `null` fill is skipped: an insert with no document defaults already
 *  has none. A line never gets a fill. */
export function graphicPaintOps(op: ShapeInsertOp, paint: GraphicPaint): MutationInput[] {
  const elementId = { kind: KIND_OF[op], id: "$created" } as ElementId;
  const ops: MutationInput[] = [];
  if (paint.fill !== null && op !== "insertLine") {
    ops.push({
      op: "setElementProperty",
      args: { elementId, path: "frameFillColor", value: { type: "colorRef", value: paint.fill } },
    });
  }
  if (paint.stroke !== null) {
    ops.push({
      op: "setElementProperty",
      args: { elementId, path: "frameStrokeColor", value: { type: "colorRef", value: paint.stroke } },
    });
    if (paint.strokeWeight !== null) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameStrokeWeight",
          value: { type: "length", value: paint.strokeWeight },
        },
      });
    }
  }
  return ops;
}

/**
 * `mutation` with `paint` applied to every shape it inserts, as ONE
 * batch. Each insert is followed by its own property writes, so
 * `$created` names that shape. Anything else in a batch (the pencil's
 * `bindCreated` and variable-width outline) keeps its place after the
 * paint — `bindCreated` still binds the insert, since a property write
 * creates nothing. `null` paint, or nothing to paint, answers `mutation`
 * itself.
 */
export function withGraphicPaint(
  mutation: MutationInput,
  paint: GraphicPaint | null,
): MutationInput {
  if (!paint) return mutation;
  const children: readonly MutationInput[] =
    mutation.op === "batch" ? mutation.args.ops : [mutation];
  const ops: MutationInput[] = [];
  let painted = false;
  for (const child of children) {
    ops.push(child);
    const op = shapeInsertOp(child);
    if (op) {
      const extra = graphicPaintOps(op, paint);
      painted ||= extra.length > 0;
      ops.push(...extra);
    }
  }
  return painted ? batchMutationFor(ops) : mutation;
}
