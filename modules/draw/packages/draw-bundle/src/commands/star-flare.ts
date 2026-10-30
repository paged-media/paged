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

// STAR and FLARE — the two Illustrator shape tools' inserts, as commands
// (`insertStar`, `insertFlare`) with their full parameters as the
// payload, the Path Options panel's two sections, and what the tools'
// drags and clicks commit. Geometry: draw-geometry `starPath` /
// `flareParts`.
//
// A STAR is one closed path, painted with the graphic default a drawing
// tool gives its shape (`../handlers/graphic-default.ts`) — one batch.
//
// A FLARE is Illustrator's four parts as separate paths, GROUPED, in one
// batch (each insert named by `bindCreated`, the group made of the
// handles): halo at the back, then the rays, the rings, and the centre in
// front. What the paint model gives it, and where it stops:
//   · every part is filled / stroked `Color/Paper` (white) — a flare
//     lightens what is under it;
//   · the HALO fades out with a RADIAL GRADIENT FEATHER (InDesign's
//     transparency effect: 100 % opaque at the centre, 0 % at the rim) —
//     a gradient's own stops carry no opacity in this model, so the
//     feather is how a fade-to-transparent is expressed;
//   · the rays and rings are partly transparent through `frameOpacity`;
//   · Illustrator's flare also BLENDS (its halo and rings use Screen-like
//     modes with colour tints); this one uses Normal blending and no
//     tints, because a flare made of white parts reads correctly without
//     them and no blend mode is assumed to be supported by every engine.
// It is ARTWORK, not a live flare object: there is no flare node to edit
// again (the same honesty as Repeats v0's "a recipe, not a live object").

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import {
  flareParts,
  regularPolygonPath,
  starPath,
  FLARE_MAX_RAYS,
  FLARE_MAX_RINGS,
  STAR_MAX_POINTS,
  STAR_MIN_POINTS,
  type AnchorTable,
} from "@paged-media/draw-geometry";

import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "./batch-handles";
import { groupMutationFor } from "./group";
import { resolveTargetPage } from "../target-page";
import { graphicPaintFor, withGraphicPaint } from "../handlers/graphic-default";
import { insertPathMutationFor } from "../handlers/insert-path";
import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";

const M = defineMessages("draw.starFlare", {
  star: "Insert: Star (last used values)",
  flare: "Insert: Flare (last used values)",
});

const C = "media.paged.draw.command";
export const INSERT_STAR_COMMAND_ID = `${C}.insertStar`;
export const INSERT_FLARE_COMMAND_ID = `${C}.insertFlare`;
export const STAR_FLARE_COMMAND_IDS = [
  INSERT_STAR_COMMAND_ID,
  INSERT_FLARE_COMMAND_ID,
] as const;

export interface StarParams {
  cx: number;
  cy: number;
  radius1: number;
  radius2: number;
  points: number;
  rotationDeg: number;
}

export interface FlareParams {
  cx: number;
  cy: number;
  /** pt — the centre disc's radius. */
  centreRadius: number;
  /** The halo's radius ÷ the centre's. */
  haloScale: number;
  rays: number;
  /** pt — the longest ray. */
  rayLength: number;
  rings: number;
  /** The rings run from the centre to (endX, endY), page pt. */
  endX: number;
  endY: number;
  /** pt — the largest ring. */
  ringRadius: number;
}

/** Illustrator's Star dialog defaults (Radius 1 50 pt, Radius 2 25 pt,
 *  5 points) at the insert commands' usual spot. */
export const STAR_PARAM_DEFAULTS: StarParams = {
  cx: 200,
  cy: 200,
  radius1: 50,
  radius2: 25,
  points: 5,
  rotationDeg: 0,
};

/** Illustrator's Flare dialog, scaled to a page: 15 rays, 10 rings. */
export const FLARE_PARAM_DEFAULTS: FlareParams = {
  cx: 200,
  cy: 200,
  centreRadius: 12,
  haloScale: 3,
  rays: 15,
  rayLength: 90,
  rings: 10,
  endX: 360,
  endY: 300,
  ringRadius: 18,
};

type Payload = Record<string, unknown> | undefined;

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const count = (v: unknown, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(num(v, fallback))));

export function starParamsFrom(payload?: Payload): StarParams {
  const d = STAR_PARAM_DEFAULTS;
  return {
    cx: num(payload?.cx, d.cx),
    cy: num(payload?.cy, d.cy),
    radius1: Math.abs(num(payload?.radius1, d.radius1)),
    radius2: Math.abs(num(payload?.radius2, d.radius2)),
    points: count(payload?.points, d.points, STAR_MIN_POINTS, STAR_MAX_POINTS),
    rotationDeg: num(payload?.rotationDeg, d.rotationDeg),
  };
}

export function flareParamsFrom(payload?: Payload): FlareParams {
  const d = FLARE_PARAM_DEFAULTS;
  return {
    cx: num(payload?.cx, d.cx),
    cy: num(payload?.cy, d.cy),
    centreRadius: Math.max(
      0.5,
      Math.abs(num(payload?.centreRadius, d.centreRadius)),
    ),
    haloScale: Math.max(1, num(payload?.haloScale, d.haloScale)),
    rays: count(payload?.rays, d.rays, 0, FLARE_MAX_RAYS),
    rayLength: Math.abs(num(payload?.rayLength, d.rayLength)),
    rings: count(payload?.rings, d.rings, 0, FLARE_MAX_RINGS),
    endX: num(payload?.endX, d.endX),
    endY: num(payload?.endY, d.endY),
    ringRadius: Math.abs(num(payload?.ringRadius, d.ringRadius)),
  };
}

/** The star's table. Pure. */
export function starTableFor(p: StarParams): AnchorTable {
  return starPath(p);
}

/** The engine's star-inset ceiling (engine ADR 1047, percent). */
const MAX_LIVE_STAR_INSET = 99;

/**
 * Engine ADR 1047 — the star as a LIVE shape, or null when the engine's
 * live star cannot be this one: the insert is the plain polygon on
 * Radius 1, and the engine draws the star from its points and inset
 * (`frameShapeSides`, `frameShapeStarInset`, written to `$created`), so
 * the Transform panel and the canvas widgets edit it later. Only an
 * upright star whose inner radius is the smaller one is a live star
 * (the engine's points start at twelve o'clock; its inset is
 * `1 − Radius 2 ÷ Radius 1`). Pure.
 */
export function liveStarMutationFor(
  pageId: string,
  p: StarParams,
): Mutation | null {
  const turned = ((p.rotationDeg % 360) + 360) % 360 !== 0;
  if (turned || !(p.radius1 > 0) || !(p.radius2 < p.radius1)) return null;
  const inset = Math.round((1 - p.radius2 / p.radius1) * 1e4) / 100;
  if (inset > MAX_LIVE_STAR_INSET) return null;
  const polygon = regularPolygonPath(p.cx, p.cy, p.radius1, p.points);
  const elementId = { kind: "polygon", id: "$created" } as ElementId;
  return {
    op: "batch",
    args: {
      ops: [
        insertPathMutationFor(pageId, polygon.anchors, false),
        prop(elementId, "frameShapeSides", { type: "length", value: p.points }),
        prop(elementId, "frameShapeStarInset", {
          type: "length",
          value: inset,
        }),
      ],
    },
  } as Mutation;
}

// ----------------------------------------------------------------- star

/** Insert a star on `pageId` (default: the active page). Answers the new
 *  path's id, or null. */
export async function applyInsertStar(
  host: BundleHost,
  payload?: Payload,
  pageId?: string,
): Promise<ElementId | null> {
  const page = pageId ?? (await resolveTargetPage(host));
  if (!page) return null;
  const params = starParamsFrom(payload);
  const table = starTableFor(params);
  if (table.anchors.length < 3) return null;
  const paint = await graphicPaintFor(host).catch(() => null);
  // A live star where the engine has live shapes; the plain path where
  // it has not, or where the star is not one the engine draws.
  const live = host.supports("document.liveShapes@1")
    ? liveStarMutationFor(page, params)
    : null;
  const outcome = await host.document.mutate(
    withGraphicPaint(
      live ?? insertPathMutationFor(page, table.anchors, false),
      paint,
    ),
  );
  if (!outcome.applied) {
    host.log.warn(
      `insertStar rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return null;
  }
  const id = outcome.createdId ?? null;
  if (id) await host.selection.set([id]);
  return id;
}

// ---------------------------------------------------------------- flare

export const FLARE_PAPER = "Color/Paper";
/** Opacity (%) of the rays and the rings. */
export const FLARE_RAY_OPACITY = 60;
export const FLARE_RING_OPACITY = 25;
/** The handles the parts are named by. */
export const flareHandle = (part: string, i = 0): string =>
  `flare-${part}-${i}`;

const prop = (elementId: ElementId, path: string, value: unknown): Mutation =>
  ({
    op: "setElementProperty",
    args: { elementId, path, value },
  }) as Mutation;

/** The ONE batch a flare is: every part inserted, named, painted, then
 *  grouped. Pure; exported so the spec asserts the wire. */
export function flareBatchFor(pageId: string, p: FlareParams): Mutation {
  const parts = flareParts({
    cx: p.cx,
    cy: p.cy,
    centreRadius: p.centreRadius,
    haloScale: p.haloScale,
    rays: p.rays,
    rayLength: p.rayLength,
    rings: p.rings,
    end: [p.endX, p.endY],
    ringRadius: p.ringRadius,
  });
  const ops: Mutation[] = [];
  const members: ElementId[] = [];
  const add = (
    table: AnchorTable,
    open: boolean,
    handle: string,
    paint: Mutation[] | ((id: ElementId) => Mutation[]),
  ) => {
    ops.push(
      insertPathMutationFor(pageId, table.anchors, open),
      bindCreatedMutationFor(handle),
    );
    const id = handleElementId(handle);
    ops.push(...(typeof paint === "function" ? paint(id) : paint));
    members.push(id);
  };
  const filled = (id: ElementId): Mutation[] => [
    prop(id, "frameFillColor", { type: "colorRef", value: FLARE_PAPER }),
    prop(id, "frameStrokeColor", { type: "colorRef", value: null }),
  ];
  add(parts.halo, false, flareHandle("halo"), (id) => [
    ...filled(id),
    prop(id, "frameGradientFeather", {
      type: "gradientFeather",
      value: {
        gradientType: "Radial",
        stops: [
          { locationPct: 0, alphaPct: 100 },
          { locationPct: 100, alphaPct: 0 },
        ],
      },
    }),
  ]);
  parts.rays.forEach((ray, i) =>
    add(ray, true, flareHandle("ray", i), (id) => [
      prop(id, "frameStrokeColor", { type: "colorRef", value: FLARE_PAPER }),
      prop(id, "frameStrokeWeight", { type: "length", value: 0.5 }),
      prop(id, "frameOpacity", { type: "length", value: FLARE_RAY_OPACITY }),
    ]),
  );
  parts.rings.forEach((ring, i) =>
    add(ring, false, flareHandle("ring", i), (id) => [
      ...filled(id),
      prop(id, "frameOpacity", { type: "length", value: FLARE_RING_OPACITY }),
    ]),
  );
  add(parts.centre, false, flareHandle("centre"), filled);
  ops.push(groupMutationFor(members));
  return batchMutationFor(ops);
}

/** Insert a flare on `pageId` (default: the active page). Answers how
 *  many parts it inserted (0 = nothing). */
export async function applyInsertFlare(
  host: BundleHost,
  payload?: Payload,
  pageId?: string,
): Promise<number> {
  const page = pageId ?? (await resolveTargetPage(host));
  if (!page) return 0;
  const p = flareParamsFrom(payload);
  const outcome = await host.document.mutate(flareBatchFor(page, p));
  if (!outcome.applied) {
    host.log.warn(
      `insertFlare rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return 0;
  }
  return 2 + p.rays + p.rings;
}

export interface StarFlareLastUsed {
  star?(): Payload;
  flare?(): Payload;
}

export function contributeStarFlareCommands(
  host: BundleHost,
  lastUsed: StarFlareLastUsed = {},
): Disposable {
  const page = (payload: unknown): string | undefined => {
    const v = (payload as Payload)?.page;
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const disposers = [
    registerCommand(host, {
      id: INSERT_STAR_COMMAND_ID,
      title: M.star,
      category: "Insert",
      handler: (_paged, payload) =>
        applyInsertStar(
          host,
          (payload as Payload) ?? lastUsed.star?.(),
          page(payload),
        ),
    }),
    registerCommand(host, {
      id: INSERT_FLARE_COMMAND_ID,
      title: M.flare,
      category: "Insert",
      handler: (_paged, payload) =>
        applyInsertFlare(
          host,
          (payload as Payload) ?? lastUsed.flare?.(),
          page(payload),
        ),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
