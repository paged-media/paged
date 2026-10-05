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

// The ROUND-TRIP lane's COMPARISON: one shape — a `ViewNode` tree — for
// what OUR model holds (read back through the engine's own doors) and for
// what InDesign reported, and one function that lists every difference
// between two of them. The replay spec decides what each difference IS.
//
// VOCABULARY. Both sides are put in InDesign's: enumerations as its
// SCREAMING_SNAKE names (the engine's IDML token `RoundEndJoin` is
// InDesign's `ROUND_END_JOIN`, by the same rule for every enum), swatches
// by NAME ("None", "Black", a gradient as `gradient:<name>`). That is a
// spelling map, not a judgement: a token that maps to a DIFFERENT name
// (the engine's `BeveledCorner`, InDesign's `BEVEL_CORNER`) still shows
// up as a difference.
//
// UNSET. Where our model holds NO value (`null`, `""`, `[]`, or a property
// this element kind does not carry), IDML omits the attribute and InDesign
// answers its own document default. `INDESIGN_DEFAULTS` lists those
// defaults; an unset value of ours is compared AS that default, and the
// replay pins every entry of the table to a recording where it was seen
// (so the table cannot quietly grow a guess).
//
// ORDER. Children are listed BACK TO FRONT on both sides: the engine's
// scene tree is paint order, and InDesign's `z` comes from its own IDML
// export (the DOM's `pageItems` is grouped by kind — see the reader).

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { DRAW_METADATA_KEY } from "../../src";
import { pathsOfTable, type OraclePath } from "../oracle/oracle";
import { isUnreadable, type InDesignItem, type InDesignRecording, type InDesignSwatch } from "./indesign";

/** Geometry agrees within 0.01 pt per coordinate. IDML carries the
 *  anchors as decimal text and InDesign hands them back as doubles; the
 *  reader rounds to 1e-6. Nothing a convention moves is anywhere near this
 *  small, and the engine's own grid (1/64 pt) is above it — a geometry
 *  difference here is a real one. */
export const GEOMETRY_TOL = 0.01;
/** Numeric paint attributes (weights, tints, radii, angles) within 1e-3. */
export const NUMBER_TOL = 1e-3;

export interface Corner {
  option: string;
  /** Null when the option is NONE: InDesign keeps a radius (12) on every
   *  corner whatever its option, and it means nothing there. */
  radius: number | null;
}

/** A value our model carries but the engine's property door does not
 *  report for this element kind. */
export const NO_READ_DOOR = "(no read door on this kind)";

export interface GradientView {
  type: string;
  stops: { color: string; location: number }[];
}

export interface ViewNode {
  kind: string;
  /** Who this is, for a reader of a difference: `polygon:u1` (ours) or
   *  `Polygon#209` (InDesign). Never compared. */
  ref: string;
  children?: ViewNode[];
  paths?: OraclePath[] | null;
  fill?: string;
  fillTint?: number;
  gradient?: GradientView | null;
  gradientAngle?: number | null | typeof NO_READ_DOOR;
  gradientLength?: number | null | typeof NO_READ_DOOR;
  stroke?: string;
  strokeTint?: number;
  strokeWeight?: number | null;
  endCap?: string;
  endJoin?: string;
  miterLimit?: number;
  strokeAlignment?: string;
  strokeType?: string;
  dash?: number[];
  lineEnds?: { left: string; right: string };
  corners?: Record<string, Corner>;
  opacity?: number;
  blendMode?: string;
  /** The text set on the path, or null. */
  textPath?: string | null;
  /** This plugin's metadata envelope (ours) / the parsed IDML `<Label>`
   *  value under the same key (InDesign), or null. */
  metadata?: unknown;
}

/** What InDesign answers for an attribute IDML leaves out. */
export const INDESIGN_DEFAULTS = {
  fillTint: -1,
  strokeTint: -1,
  endCap: "BUTT_END_CAP",
  endJoin: "MITER_END_JOIN",
  miterLimit: 4,
  gradientAngle: 0,
  strokeAlignment: "CENTER_ALIGNMENT",
  strokeType: "$ID/Solid",
  lineEnd: "NONE",
  cornerOption: "NONE",
  opacity: 100,
  blendMode: "NORMAL",
} as const;

export type DefaultKey = keyof typeof INDESIGN_DEFAULTS;

/** Which unset values of ours were compared as a default — per case, so
 *  the replay can pin the table. */
export type DefaultsUsed = Set<DefaultKey>;

/** IDML token → InDesign enum name: `RoundEndJoin` → `ROUND_END_JOIN`. */
export const enumName = (token: string): string =>
  token
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();

const CORNERS = [
  ["topLeft", "TopLeft"],
  ["topRight", "TopRight"],
  ["bottomRight", "BottomRight"],
  ["bottomLeft", "BottomLeft"],
] as const;

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

// ---------------------------------------------------------------------------
// OUR side: the model, read back through the engine
// ---------------------------------------------------------------------------

interface RawClient {
  send(m: { kind: string; payload: unknown }): Promise<{ kind: string; payload: Record<string, unknown> }>;
}

type PropValue = { type: string; value: unknown } | null | undefined;

const apply = (t: readonly number[] | null | undefined, p: [number, number]): [number, number] =>
  t ? [t[0] * p[0] + t[2] * p[1] + t[4], t[1] * p[0] + t[3] * p[1] + t[5]] : [p[0], p[1]];

/** Read our model as a `ViewNode` tree (the page's children, back to
 *  front). `defaults` collects every unset value compared as a default. */
export async function engineView(h: HeadlessHost, defaults: DefaultsUsed = new Set()): Promise<ViewNode[]> {
  const doc = h.host.document;
  const swatches = await doc.collection<{ selfId: string; name: string }>("swatches");
  const gradients = await doc.collection<{ selfId: string; name: string }>("gradients");
  const nameOf = (ref: string | null | undefined): string => {
    if (!ref || ref === "Swatch/None") return "None";
    const g = gradients.find((x) => x.selfId === ref);
    if (g) return `gradient:${g.name}`;
    const s = swatches.find((x) => x.selfId === ref);
    if (s) return s.name;
    // A reference the collection does not list (the engine's implicit
    // `Color/Paper` on a document whose Graphic.xml never defined it):
    // its id's last segment, which is the name every InDesign document
    // gives that swatch.
    return ref.slice(ref.indexOf("/") + 1);
  };
  const client = (h.host as unknown as { editor: { client: RawClient } }).editor.client;

  async function leaf(node: SceneTreeNode): Promise<ViewNode> {
    const id = node.id as ElementId;
    const kind = lowerFirst(node.kind);
    const props = await doc.elementProperties(id);
    const entry = (path: string): PropValue => props?.entries.find((e) => e.path === path)?.value as PropValue;
    const has = (path: string): boolean => entry(path) !== undefined;
    const raw = (path: string): unknown => entry(path)?.value ?? null;
    const text = (path: string): string => {
      const v = raw(path);
      return typeof v === "string" ? v : "";
    };
    const num = (path: string): number | null => {
      const v = raw(path);
      return typeof v === "number" ? v : null;
    };
    const orDefault = <K extends DefaultKey>(key: K, v: (typeof INDESIGN_DEFAULTS)[K] | string | number | null) => {
      if (v === null || v === "") {
        defaults.add(key);
        return INDESIGN_DEFAULTS[key];
      }
      return v;
    };
    const token = (path: string, key: DefaultKey): string => {
      const v = text(path);
      return String(orDefault(key, v === "" ? null : enumName(v)));
    };

    const out: ViewNode = { kind, ref: `${id.kind}:${String(id.id)}` };

    // Geometry: the anchor table in page space, or — for a bounds-only
    // `<Rectangle>`, whose table comes back EMPTY (measured) — its four
    // corners from `frameBounds` ([top, left, bottom, right]) in the order
    // IDML writes a rectangle: top-left, bottom-left, bottom-right,
    // top-right.
    const table = await doc.pathAnchors(id);
    if (table && table.anchors.length > 0) {
      out.paths = pathsOfTable(table).map((p) => ({
        closed: p.closed,
        anchors: p.anchors.map((a) => ({
          anchor: apply(table.itemTransform, a.anchor),
          left: apply(table.itemTransform, a.left),
          right: apply(table.itemTransform, a.right),
        })),
      }));
    } else {
      const b = raw("frameBounds") as number[] | null;
      const corner = (x: number, y: number) => ({ anchor: [x, y], left: [x, y], right: [x, y] }) as never;
      out.paths = b
        ? [{ closed: true, anchors: [corner(b[1], b[0]), corner(b[1], b[2]), corner(b[3], b[2]), corner(b[3], b[0])] }]
        : null;
    }

    const fillRef = raw("frameFillColor") as string | null;
    out.fill = nameOf(fillRef);
    out.fillTint = Number(orDefault("fillTint", num("frameFillTint")));
    if (fillRef && fillRef.startsWith("Gradient/")) {
      const reply = await client.send({ kind: "requestGradientDetail", payload: { gradientId: fillRef } });
      const detail = reply.payload.result as
        | { kind: string; stops: { stopColorRef: string; locationPct: number }[] }
        | null;
      out.gradient = detail
        ? {
            type: enumName(detail.kind),
            stops: detail.stops.map((s) => ({ color: nameOf(s.stopColorRef), location: s.locationPct })),
          }
        : null;
      // The gradient AXIS: a kind whose property list does not carry
      // `frameGradientFillAngle` / `…Length` says so instead of reading
      // the absence as "unset" (until 0.66.0 a Polygon was one — C-83b).
      // An angle the model holds unset is InDesign's default; an unset
      // length is not a default (`gradientLengthDerived`).
      out.gradientAngle = has("frameGradientFillAngle")
        ? Number(orDefault("gradientAngle", num("frameGradientFillAngle")))
        : NO_READ_DOOR;
      out.gradientLength = has("frameGradientFillLength") ? num("frameGradientFillLength") : NO_READ_DOOR;
    }
    out.stroke = nameOf(raw("frameStrokeColor") as string | null);
    // The model has no stroke-tint property on a page item.
    out.strokeTint = Number(orDefault("strokeTint", null));
    out.strokeWeight = num("frameStrokeWeight");
    out.endCap = token("frameStrokeEndCap", "endCap");
    out.endJoin = token("frameStrokeJoin", "endJoin");
    out.miterLimit = Number(orDefault("miterLimit", num("frameStrokeMiterLimit")));
    out.strokeAlignment = token("frameStrokeAlignment", "strokeAlignment");
    const strokeType = text("frameStrokeType").replace(/^StrokeStyle\//, "");
    out.strokeType = String(orDefault("strokeType", strokeType === "" ? null : strokeType));
    out.dash = ((raw("frameStrokeDashArray") as number[] | null) ?? []).slice();
    out.lineEnds = {
      left: token("frameStrokeStartArrowhead", "lineEnd"),
      right: token("frameStrokeEndArrowhead", "lineEnd"),
    };
    if (has("frameCornerOptionTopLeft")) {
      const corners: Record<string, Corner> = {};
      for (const [key, suffix] of CORNERS) {
        const option = token(`frameCornerOption${suffix}`, "cornerOption");
        corners[key] = { option, radius: option === "NONE" ? null : num(`frameCornerRadius${suffix}`) };
      }
      out.corners = corners;
    } else {
      out.corners = Object.fromEntries(CORNERS.map(([key]) => [key, { option: "NONE", radius: null }]));
    }
    out.opacity = Number(orDefault("opacity", num("frameOpacity")));
    out.blendMode = token("frameBlendMode", "blendMode");

    const envelope = await doc.getMetadata(id);
    out.metadata = envelope ?? null;
    const tp = (envelope?.data as { textOnPath?: { story?: string } } | undefined)?.textOnPath;
    if (tp?.story) {
      const content = await doc.storyContent(tp.story);
      out.textPath = content
        ? content.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n")
        : null;
    } else {
      out.textPath = null;
    }
    return out;
  }

  async function visit(nodes: readonly SceneTreeNode[]): Promise<ViewNode[]> {
    const out: ViewNode[] = [];
    for (const node of nodes) {
      if (!node.id) {
        // Spread / Page rows: not elements, descend.
        out.push(...(await visit(node.children ?? [])));
      } else if (node.id.kind === "group") {
        out.push({
          kind: "group",
          ref: `group:${String(node.id.id)}`,
          children: await visit(node.children ?? []),
        });
      } else {
        out.push(await leaf(node));
      }
    }
    return out;
  }

  return visit(await doc.tree());
}

// ---------------------------------------------------------------------------
// INDESIGN's side: a recording
// ---------------------------------------------------------------------------

function swatchName(s: InDesignSwatch | undefined): string {
  if (!s) return "None";
  if (s.type === "Gradient") return `gradient:${s.name}`;
  return s.name;
}

function indesignNode(item: InDesignItem, all: readonly InDesignItem[]): ViewNode {
  const ref = `${item.kind}#${item.id}`;
  if (item.kind === "Group") {
    return { kind: "group", ref, children: childrenOf(ref, all) };
  }
  const out: ViewNode = { kind: lowerFirst(item.kind), ref };
  out.paths = item.paths ? item.paths.map((p) => ({ closed: p.closed, anchors: p.anchors })) : null;
  out.fill = swatchName(item.fill);
  out.fillTint = item.fillTint;
  if (item.fill?.type === "Gradient") {
    out.gradient = {
      type: item.fill.gradientType ?? "?",
      stops: (item.fill.stops ?? []).map((s) => ({ color: s.color.name, location: s.location })),
    };
    out.gradientAngle = item.gradientFillAngle ?? null;
    out.gradientLength = item.gradientFillLength ?? null;
  }
  out.stroke = swatchName(item.stroke);
  out.strokeTint = item.strokeTint;
  out.strokeWeight = item.strokeWeight ?? null;
  out.endCap = item.endCap;
  out.endJoin = item.endJoin;
  out.miterLimit = item.miterLimit;
  out.strokeAlignment = item.strokeAlignment;
  out.strokeType = item.strokeType?.key ?? item.strokeType?.name;
  // "Not applicable in the current state" = not a dashed stroke = no dash.
  out.dash = isUnreadable(item.strokeDashAndGap) ? [] : (item.strokeDashAndGap ?? []).slice();
  out.lineEnds = { left: item.leftLineEnd ?? "NONE", right: item.rightLineEnd ?? "NONE" };
  out.corners = Object.fromEntries(
    CORNERS.map(([key]) => {
      const c = item.corners?.[key];
      const option = c?.option ?? "NONE";
      return [key, { option, radius: option === "NONE" ? null : (c?.radius ?? null) }];
    }),
  );
  out.opacity = item.transparency?.opacity;
  out.blendMode = item.transparency?.blendMode;
  out.textPath = item.textPaths && item.textPaths.length > 0 ? item.textPaths[0].contents : null;
  const label = item.labels?.[DRAW_METADATA_KEY];
  out.metadata = label === undefined ? null : JSON.parse(label);
  return out;
}

function childrenOf(parent: string, all: readonly InDesignItem[]): ViewNode[] {
  return all
    .filter((i) => i.parent === parent)
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    .map((i) => indesignNode(i, all));
}

/** A recording as a `ViewNode` tree (the spread's items, back to front). */
export function indesignView(rec: InDesignRecording): ViewNode[] {
  return childrenOf("spread", rec.items);
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export interface Difference {
  /** Index path, back to front: "1" is the second item from the back on
   *  the page, "0/2" the third member of the backmost group. */
  at: string;
  field: string;
  ours: unknown;
  theirs: unknown;
  /** Who the item is on each side (`polygon:u1` / `Polygon#209`). */
  refs: [string, string];
}

/** A stable JSON spelling (sorted keys) for comparing structured values. */
export const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );

const numbersClose = (a: unknown, b: unknown, tol: number): boolean => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => numbersClose(x, b[i], tol));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      stable(ka) === stable(kb) &&
      ka.every((k) => numbersClose((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol))
    );
  }
  return a === b;
};

/** The largest coordinate deviation between two path lists of the same
 *  shape, or null when their STRUCTURE differs (count, open/closed,
 *  anchors per path). */
export function geometryDeviation(a: readonly OraclePath[], b: readonly OraclePath[]): number | null {
  if (a.length !== b.length) return null;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].closed !== b[i].closed || a[i].anchors.length !== b[i].anchors.length) return null;
    for (let j = 0; j < a[i].anchors.length; j++) {
      for (const k of ["anchor", "left", "right"] as const) {
        const p = a[i].anchors[j][k];
        const q = b[i].anchors[j][k];
        worst = Math.max(worst, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
      }
    }
  }
  return worst;
}

const shapeOf = (paths: readonly OraclePath[] | null | undefined) =>
  paths ? paths.map((p) => `${p.closed ? "closed" : "open"}:${p.anchors.length}`) : null;

const FIELDS = [
  "fill",
  "fillTint",
  "gradient",
  "gradientAngle",
  "gradientLength",
  "stroke",
  "strokeTint",
  "strokeWeight",
  "endCap",
  "endJoin",
  "miterLimit",
  "strokeAlignment",
  "strokeType",
  "dash",
  "lineEnds",
  "corners",
  "opacity",
  "blendMode",
  "textPath",
  "metadata",
] as const;

/** Every difference between two `ViewNode` trees. Children are paired by
 *  position, back to front; a count mismatch is ONE difference
 *  (`children`, with both kind lists) and the common prefix is still
 *  compared. */
export function compareViews(ours: readonly ViewNode[], theirs: readonly ViewNode[], at = ""): Difference[] {
  const out: Difference[] = [];
  const here = (i: number) => (at === "" ? String(i) : `${at}/${i}`);
  if (ours.length !== theirs.length) {
    out.push({
      at: at === "" ? "page" : at,
      field: "children",
      ours: ours.map((n) => n.kind),
      theirs: theirs.map((n) => n.kind),
      refs: [ours.map((n) => n.ref).join(","), theirs.map((n) => n.ref).join(",")],
    });
  }
  for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
    const a = ours[i];
    const b = theirs[i];
    const refs: [string, string] = [a.ref, b.ref];
    const push = (field: string, x: unknown, y: unknown) => out.push({ at: here(i), field, ours: x, theirs: y, refs });
    if (a.kind !== b.kind) push("kind", a.kind, b.kind);
    if (a.kind === "group" || b.kind === "group") {
      out.push(...compareViews(a.children ?? [], b.children ?? [], here(i)));
      continue;
    }
    // Geometry: structure first, then every coordinate.
    if (a.paths && b.paths) {
      const dev = geometryDeviation(a.paths, b.paths);
      if (dev === null) push("paths", shapeOf(a.paths), shapeOf(b.paths));
      else if (dev > GEOMETRY_TOL) push("geometry", `max deviation ${dev.toFixed(4)} pt`, `tolerance ${GEOMETRY_TOL} pt`);
    } else if (Boolean(a.paths) !== Boolean(b.paths)) {
      push("paths", shapeOf(a.paths), shapeOf(b.paths));
    }
    for (const f of FIELDS) {
      const x = a[f];
      const y = b[f];
      if (x === undefined && y === undefined) continue;
      if (f === "metadata") {
        if (stable(x ?? null) !== stable(y ?? null)) push(f, x ?? null, y ?? null);
      } else if (!numbersClose(x ?? null, y ?? null, NUMBER_TOL)) {
        push(f, x ?? null, y ?? null);
      }
    }
  }
  return out;
}
