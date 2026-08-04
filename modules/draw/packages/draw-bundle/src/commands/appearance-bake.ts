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

// GAP B-24, closed the honest way — the GROUP BAKE.
//
// WHY A GROUP AND NOT A CORE CHANGE. Core is an IDML engine, and IDML
// itself gives a page item exactly one `FillColor` and one
// `StrokeColor`. A multi-paint frame would be a paged-only extension
// that cannot round-trip the format the engine exists to speak. But a
// GROUP of stacked page items — each with ONE paint, all sharing the
// same path geometry — is ordinary IDML. So the appearance stack lowers
// to that: N derived paths, back-to-front, wrapped in a group with the
// source frame.
//
// THE DOCUMENT SHAPE a bake produces:
//
//   Group
//     ├── the SOURCE frame  ← the CARRIER: keeps its identity, its
//     │                        `x-paged:media.paged.draw` envelope (the
//     │                        editable stack + the bake record) and its
//     │                        geometry; its OWN fill/stroke are cleared
//     │                        so it paints nothing (every paint is a
//     │                        derived layer now).
//     ├── derived path #1   ← fills, bottom-to-top …
//     ├── …
//     └── derived path #N   ← … then strokes, bottom-to-top (a frame's
//                             own stroke draws over its own fill, so the
//                             stack generalizes the same way).
//
// The carrier is the reason `releaseAppearance` is exact: the object's
// identity, name, object style and every other draw metadata key
// survive a bake→release round-trip because the ORIGINAL element is
// still there.
//
// MUTATION / UNDO SHAPE (probed against the booted engine, protocol 56 —
// the RFI C-15 rule: assert the real count, never claim "one undo"):
//   · bake    = TWO batches ⇒ 2 undo steps. Batch 1 inserts the N
//     derived paths; batch 2 paints them, clears the carrier, stamps
//     every envelope and wraps the group. Two is the FLOOR, not a
//     shortcut: a batch op cannot reference an id minted EARLIER IN THE
//     SAME BATCH (the blend.ts finding), and `insertPath` mints the ids
//     batch 2 addresses.
//   · release = ONE batch ⇒ 1 undo step (dissolve + delete + restore +
//     re-stamp all ride together; the group and the layers already
//     exist, so nothing is forward-referenced).
//   · an edit on an ALREADY-BAKED stack re-bakes = release + bake =
//     THREE undo steps.
//
// WHAT SURVIVES THE LOWERING — and what does not (probed, not assumed):
//   ✔ geometry: the derived paths carry the source's anchors + open
//     flag exactly (`insertPath`), and they export.
//   ✔ per-layer FILL colour, STROKE colour and STROKE WEIGHT: settable
//     on the derived Polygon and written by the IDML writer.
//   ✔ per-layer OPACITY: settable on a Polygon (`FrameOpacity` has a
//     Polygon arm in core's set_property) and it RENDERS — but the IDML
//     writer does not emit it for an inserted item, so it is a canvas +
//     PDF truth only.
//   ✘ per-layer TINT and BLEND MODE: `FrameFillTint` / `FrameBlendMode`
//     have TextFrame + Rectangle arms only in core's set_property — a
//     derived Polygon REFUSES both. A tinted layer therefore bakes as
//     its untinted swatch. Named, not silently dropped.
//   ✘ COMPOUND (multi-subpath) sources: `insertPath` takes one contour
//     and one open flag, so a source with more than one subpath is
//     REFUSED with a diagnostic rather than silently flattened.
//   ✘ IDML SAVE-BACK of a baked group: core's IDML writer
//     (`idml-export::write_inserted_items`) skips any INSERTED page item
//     that lives inside a group — "a group's own insertion is a separate,
//     deferred lane" — so a baked group and its derived layers do not
//     reach an IDML export. Release before saving back to IDML; the
//     conformance spec pins this so a core fix fails the test loudly.
//   ✔ PDF export: `paged-export-pdf` renders the composed scene, so
//     every baked layer paints into the PDF (asserted through the real
//     engine by counting the painted paths in the page content stream).
//
// RESIDUAL, found while probing the export lane and NOT worked around
// here (it does not bite a GROUPED bake, which the writer drops whole,
// but it would bite any flat variant): items inserted in one session are
// emitted at the spread's close in the model's per-kind vec order, which
// came back REVERSED relative to their live z-order — three paths
// inserted u1,u2,u3 export as u3,u2,u1, i.e. a stacked appearance would
// reimport inverted. Belongs with the group-insert lane in the same
// core writer, not in this plugin.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  MutationOutcome,
  PathAnchorSpec,
  PluginMetadataEnvelope,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import { applyAffine } from "@paged-media/draw-geometry";

import manifest from "../../manifest.json";
import {
  appearanceOf,
  bakeAppearanceMutations,
  withAppearance,
  type AppearanceStack,
  type FillLayer,
  type StrokeLayer,
} from "./appearance";
import { leafIdsOf } from "./select-same";
import { parentGroupOf } from "./select-parent-group";

export const APPEARANCE_BAKE_COMMAND_ID =
  "media.paged.draw.command.bakeAppearance";
export const APPEARANCE_RELEASE_COMMAND_ID =
  "media.paged.draw.command.releaseAppearance";

/** The two bake commands, in registration order. */
export const APPEARANCE_BAKE_COMMAND_IDS = [
  APPEARANCE_BAKE_COMMAND_ID,
  APPEARANCE_RELEASE_COMMAND_ID,
];

/** This plugin's metadata key — the SAME derivation the SDK facade uses
 *  (`x-paged:<manifest id>`), spelled out here because the bake writes
 *  its envelopes through RAW `setPluginMetadata` ops so they ride in the
 *  same batch as the paints (the facade's `setMetadata` is its own
 *  mutation, i.e. its own undo step, and the bake would otherwise cost
 *  N+2 of them). The SDK's namespace gate still checks the key on the
 *  way through — a foreign key is refused before the engine sees it. */
export const DRAW_METADATA_KEY = `x-paged:${manifest.id}`;

// ---------------------------------------------------------------- model

/** The bake RECORD stamped on the carrier alongside `data.appearance`.
 *  Its presence is what makes a baked object recognizable on reopen. */
export interface AppearanceBakeRecord {
  /** The derived layer element ids, BACK-TO-FRONT (paint order). */
  layers: string[];
  /** The carrier's own paint BEFORE the bake — restored on release so a
   *  bake→release round-trip is exact even for an empty stack. */
  restore: {
    fill: string | null;
    stroke: string | null;
    weight: number | null;
  };
}

/** The marker stamped on every DERIVED layer element, so direct-selecting
 *  inside the group resolves back to the carrier. */
export interface AppearanceLayerMarker {
  of: ElementId;
  kind: "fill" | "stroke";
  /** Index within its half of the stack (bottom-to-top). */
  index: number;
}

/** Read the bake record out of an envelope, or null. Tolerant of
 *  partial/foreign shapes (the `appearanceOf` convention). */
export function appearanceBakeOf(
  env: PluginMetadataEnvelope | null,
): AppearanceBakeRecord | null {
  const raw = (env?.data as { appearanceBake?: unknown } | undefined)
    ?.appearanceBake;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AppearanceBakeRecord>;
  if (!Array.isArray(r.layers)) return null;
  const restore = (r.restore ?? {}) as Partial<AppearanceBakeRecord["restore"]>;
  return {
    layers: r.layers.filter((id): id is string => typeof id === "string"),
    restore: {
      fill: typeof restore.fill === "string" ? restore.fill : null,
      stroke: typeof restore.stroke === "string" ? restore.stroke : null,
      weight: typeof restore.weight === "number" ? restore.weight : null,
    },
  };
}

/** Read the derived-layer marker out of an envelope, or null. */
export function appearanceLayerOf(
  env: PluginMetadataEnvelope | null,
): AppearanceLayerMarker | null {
  const raw = (env?.data as { appearanceLayer?: unknown } | undefined)
    ?.appearanceLayer;
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<AppearanceLayerMarker>;
  const of = m.of as ElementId | undefined;
  if (!of || typeof of.id !== "string") return null;
  return {
    of,
    kind: m.kind === "stroke" ? "stroke" : "fill",
    index: typeof m.index === "number" ? m.index : 0,
  };
}

/** Merge (or, with `null`, drop) the bake record in an envelope,
 *  preserving every other draw metadata key. */
export function withAppearanceBake(
  prev: PluginMetadataEnvelope | null,
  record: AppearanceBakeRecord | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (record === null) {
    delete data.appearanceBake;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.appearanceBake = record;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

/** One paint the bake lowers to its own page item. */
export type BakeLayer =
  | ({ kind: "fill"; index: number } & FillLayer)
  | ({ kind: "stroke"; index: number } & StrokeLayer);

/** The stack flattened to PAINT ORDER (back-to-front): every fill
 *  bottom-to-top, then every stroke bottom-to-top — the generalization
 *  of a single frame's own "fill under stroke". Pure; exported so the
 *  conformance spec pins the order. */
export function appearanceBakeLayers(stack: AppearanceStack): BakeLayer[] {
  const out: BakeLayer[] = [];
  stack.fills.forEach((layer, index) =>
    out.push({ kind: "fill", index, ...layer }),
  );
  stack.strokes.forEach((layer, index) =>
    out.push({ kind: "stroke", index, ...layer }),
  );
  return out;
}

// ------------------------------------------------------------- geometry

/** The source geometry every derived layer copies: page-space anchors +
 *  the contour's open flag. */
export interface BakeGeometry {
  pageId: string;
  anchors: PathAnchorSpec[];
  open: boolean;
}

/** Why a bake refused (the honest diagnostic; null = it can proceed). */
export type BakeRefusal = "no-geometry" | "compound-path" | "empty-stack";

const affine = (
  m: [number, number, number, number, number, number] | null | undefined,
  p: readonly [number, number],
): [number, number] =>
  m ? (applyAffine(m, p[0], p[1]) as [number, number]) : [p[0], p[1]];

/** Read `id`'s geometry as page-space anchors. Path-bearing elements
 *  come through `pathAnchors` (anchors are inner-space + an item
 *  transform — the blend.ts normalization); a BOUNDS-ONLY element (an
 *  IDML `<Rectangle>` / `<Oval>` carries no anchor table) falls back to
 *  its four `elementGeometry` corners as a closed contour.
 *
 *  Refuses a COMPOUND source: `insertPath` carries ONE contour and ONE
 *  open flag, so a multi-subpath path cannot be copied faithfully —
 *  flattening it silently would be the fiction this repo refuses. */
export async function bakeGeometryOf(
  host: BundleHost,
  id: ElementId,
): Promise<{ geometry: BakeGeometry } | { refusal: BakeRefusal }> {
  const table = await host.document.pathAnchors(id).catch(() => null);
  if (table && table.anchors.length >= 2) {
    if (table.subpathStarts.length > 1) return { refusal: "compound-path" };
    return {
      geometry: {
        pageId: table.pageId,
        anchors: table.anchors.map((a) => ({
          anchor: affine(table.itemTransform, a.anchor),
          left: affine(table.itemTransform, a.left),
          right: affine(table.itemTransform, a.right),
        })),
        open: table.subpathOpen?.[0] ?? false,
      },
    };
  }
  const items = await host.document.elementGeometry([id]).catch(() => []);
  const item = items[0];
  if (!item) return { refusal: "no-geometry" };
  const [top, left, bottom, right] = item.bounds;
  const corners: [number, number][] = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  return {
    geometry: {
      pageId: item.pageId,
      anchors: corners.map((c) => {
        const p = affine(item.itemTransform, c);
        return { anchor: p, left: p, right: p };
      }),
      open: false,
    },
  };
}

// ------------------------------------------------------- wire builders

const colorRef = (
  elementId: ElementId,
  path: "frameFillColor" | "frameStrokeColor",
  value: string | null,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "colorRef", value } },
});

const length = (
  elementId: ElementId,
  path: "frameStrokeWeight" | "frameOpacity",
  value: number,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "length", value } },
});

const stamp = (
  elementId: ElementId,
  envelope: PluginMetadataEnvelope | null,
): Mutation => ({
  op: "setPluginMetadata",
  args: {
    elementId,
    key: DRAW_METADATA_KEY,
    value: envelope === null ? null : JSON.stringify(envelope),
    caller: manifest.id,
  },
});

/** BATCH 1 of the bake — `count` copies of the source contour, inserted
 *  bottom-to-top. One batch ⇒ one undo step for the whole geometry.
 *  Exported so the conformance spec asserts the EXACT wire shape. */
export function bakeInsertBatchFor(
  geometry: BakeGeometry,
  count: number,
): Mutation {
  const ops: Mutation[] = [];
  for (let i = 0; i < count; i++) {
    ops.push({
      op: "insertPath",
      args: {
        pageId: geometry.pageId,
        anchors: geometry.anchors.map((a) => ({
          anchor: [a.anchor[0], a.anchor[1]] as [number, number],
          left: [a.left[0], a.left[1]] as [number, number],
          right: [a.right[0], a.right[1]] as [number, number],
        })),
        open: geometry.open,
      },
    });
  }
  return { op: "batch", args: { ops } };
}

/** The per-layer paint ops for ONE derived element: exactly one paint
 *  (a fill layer clears its stroke and vice versa) plus the layer's
 *  optional opacity. `tint` is deliberately NOT emitted — the engine
 *  refuses `FrameFillTint` on a Polygon (see the header). */
export function bakeLayerPaintFor(
  elementId: ElementId,
  layer: BakeLayer,
): Mutation[] {
  const ops: Mutation[] = [];
  if (layer.kind === "fill") {
    ops.push(colorRef(elementId, "frameFillColor", layer.color));
    ops.push(colorRef(elementId, "frameStrokeColor", null));
  } else {
    ops.push(colorRef(elementId, "frameFillColor", null));
    ops.push(colorRef(elementId, "frameStrokeColor", layer.color));
    ops.push(length(elementId, "frameStrokeWeight", layer.weight));
  }
  if (typeof layer.opacity === "number") {
    ops.push(length(elementId, "frameOpacity", layer.opacity));
  }
  return ops;
}

/** BATCH 2 of the bake — paint every derived layer, stamp its marker,
 *  clear the carrier's own paint, write the carrier's envelope (stack +
 *  bake record) and wrap the whole thing in a group. One batch ⇒ one
 *  undo step. `created` is back-to-front, parallel to `layers`.
 *  Exported so the conformance spec asserts the EXACT wire shape. */
export function bakePaintBatchFor(args: {
  carrier: ElementId;
  created: readonly ElementId[];
  layers: readonly BakeLayer[];
  carrierEnvelope: PluginMetadataEnvelope | null;
}): Mutation {
  const ops: Mutation[] = [];
  args.created.forEach((elementId, i) => {
    const layer = args.layers[i];
    if (!layer) return;
    ops.push(...bakeLayerPaintFor(elementId, layer));
    ops.push(
      stamp(elementId, {
        v: 1,
        data: {
          appearanceLayer: {
            of: args.carrier,
            kind: layer.kind,
            index: layer.index,
          },
        },
      }),
    );
  });
  // The carrier paints nothing once its stack is real: every paint is a
  // derived layer now (leaving its own fill under the stack would tint
  // translucent layers from below).
  ops.push(colorRef(args.carrier, "frameFillColor", null));
  ops.push(colorRef(args.carrier, "frameStrokeColor", null));
  ops.push(stamp(args.carrier, args.carrierEnvelope));
  ops.push({
    op: "createGroup",
    args: { memberIds: [args.carrier, ...args.created] },
  });
  return { op: "batch", args: { ops } };
}

/** The RELEASE batch — dissolve the group, delete every derived layer,
 *  put the carrier's paint back (its pre-bake paint, then the
 *  front-most-layer bake on top: the pre-B-24 behaviour) and drop the
 *  bake record from its envelope. One batch ⇒ one undo step. Exported
 *  so the conformance spec asserts the EXACT wire shape. */
export function releaseBatchFor(args: {
  carrier: ElementId;
  group: ElementId | null;
  layers: readonly string[];
  record: AppearanceBakeRecord;
  stack: AppearanceStack;
  carrierEnvelope: PluginMetadataEnvelope | null;
}): Mutation {
  const ops: Mutation[] = [];
  if (args.group && typeof args.group.id === "string") {
    ops.push({ op: "dissolveGroup", args: { groupId: args.group.id } });
  }
  for (const frameId of args.layers) {
    ops.push({ op: "deleteFrame", args: { frameId } });
  }
  ops.push(colorRef(args.carrier, "frameFillColor", args.record.restore.fill));
  ops.push(
    colorRef(args.carrier, "frameStrokeColor", args.record.restore.stroke),
  );
  if (typeof args.record.restore.weight === "number") {
    ops.push(
      length(args.carrier, "frameStrokeWeight", args.record.restore.weight),
    );
  }
  // …then the front-most layer on top, so a released object looks
  // exactly like the pre-B-24 top-layer bake.
  ops.push(...bakeAppearanceMutations(args.carrier, args.stack));
  ops.push(stamp(args.carrier, args.carrierEnvelope));
  return { op: "batch", args: { ops } };
}

// ------------------------------------------------------------- appliers

const idsOf = (list: readonly ElementId[]): Set<string> =>
  new Set(
    list
      .map((e) => (typeof e.id === "string" ? e.id : null))
      .filter((s): s is string => s !== null),
  );

async function leafElements(host: BundleHost): Promise<ElementId[]> {
  return leafIdsOf(await host.document.tree());
}

/** Read the carrier's current frame paint (the release-restore seed). */
async function carrierPaint(
  host: BundleHost,
  id: ElementId,
): Promise<AppearanceBakeRecord["restore"]> {
  const out: AppearanceBakeRecord["restore"] = {
    fill: null,
    stroke: null,
    weight: null,
  };
  try {
    const props = await host.document.elementProperties(id);
    for (const e of props?.entries ?? []) {
      const v = e.value;
      if (!v) continue;
      if (e.path === "frameFillColor" && v.type === "colorRef") out.fill = v.value;
      else if (e.path === "frameStrokeColor" && v.type === "colorRef") {
        out.stroke = v.value;
      } else if (e.path === "frameStrokeWeight" && v.type === "length") {
        out.weight = v.value;
      }
    }
  } catch {
    /* defaults stand */
  }
  return out;
}

/** Resolve whatever the author selected to the element that OWNS the
 *  appearance stack: a derived layer resolves to its carrier, a baked
 *  GROUP resolves to the member carrying the bake record, anything else
 *  is its own carrier. (Groups cannot hold plugin metadata at all —
 *  `setPluginMetadata` answers `notImplemented` for a group id — which
 *  is exactly why the carrier leaf exists.) */
export async function resolveAppearanceCarrier(
  host: BundleHost,
  id: ElementId,
): Promise<ElementId> {
  if (id.kind === "group") {
    const roots = await host.document.tree().catch(() => [] as SceneTreeNode[]);
    for (const child of groupChildren(roots, id)) {
      const env = await host.document.getMetadata(child).catch(() => null);
      if (appearanceBakeOf(env)) return child;
    }
    return id;
  }
  const env = await host.document.getMetadata(id).catch(() => null);
  const marker = appearanceLayerOf(env);
  return marker ? marker.of : id;
}

/** Direct children of the group node `group` in the scene tree. Pure —
 *  exported for the conformance spec. */
export function groupChildren(
  roots: readonly SceneTreeNode[],
  group: ElementId,
): ElementId[] {
  const stack: SceneTreeNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id && node.id.kind === "group" && node.id.id === group.id) {
      return (node.children ?? [])
        .map((c) => c.id)
        .filter((c): c is ElementId => c != null);
    }
    if (node.children) stack.push(...node.children);
  }
  return [];
}

/** Lower `id`'s metadata stack onto a real group of derived paths.
 *  Returns the created layer ids (empty on a refusal — always logged,
 *  never thrown: the dash-command convention). */
export async function bakeAppearance(
  host: BundleHost,
  id: ElementId,
  options: { label?: string } = {},
): Promise<ElementId[]> {
  const label = options.label ?? APPEARANCE_BAKE_COMMAND_ID;
  const prev = await host.document.getMetadata(id).catch(() => null);
  const stack = appearanceOf(prev);
  const layers = appearanceBakeLayers(stack);
  if (layers.length === 0) {
    host.log.debug(`${label}: nothing to bake (empty appearance stack) — no-op`);
    return [];
  }
  if (appearanceBakeOf(prev)) {
    host.log.debug(`${label}: already baked — no-op (release first)`);
    return [];
  }
  const geometry = await bakeGeometryOf(host, id);
  if ("refusal" in geometry) {
    host.log.warn(
      `${label}: ${
        geometry.refusal === "compound-path"
          ? "the source is a COMPOUND path (more than one subpath) and " +
            "insertPath carries one contour with one open flag — a faithful " +
            "copy is not expressible"
          : "the element exposes no readable geometry"
      } — no-op`,
    );
    return [];
  }

  const restore = await carrierPaint(host, id);
  const before = idsOf(await leafElements(host));
  const inserted = await host.document.mutate(
    bakeInsertBatchFor(geometry.geometry, layers.length),
  );
  if (!inserted.applied) {
    host.log.warn(
      `${label}: derived-layer insert rejected by engine: ${JSON.stringify(
        inserted.error,
      )}`,
    );
    return [];
  }
  // A batch outcome reports ONE createdId, so the leaf diff is the
  // honest enumeration (the blend.ts precedent). Tree order == insertion
  // order == paint order.
  const created = (await leafElements(host)).filter(
    (e) => typeof e.id === "string" && !before.has(e.id),
  );
  if (created.length !== layers.length) {
    host.log.warn(
      `${label}: expected ${layers.length} derived layers, found ` +
        `${created.length} — leaving the insert in place, not grouping`,
    );
    return [];
  }
  const record: AppearanceBakeRecord = {
    layers: created.map((e) => e.id as string),
    restore,
  };
  const painted = await host.document.mutate(
    bakePaintBatchFor({
      carrier: id,
      created,
      layers,
      carrierEnvelope: withAppearanceBake(withAppearance(prev, stack), record),
    }),
  );
  if (!painted.applied) {
    host.log.warn(
      `${label}: layer paint/group batch rejected by engine: ${JSON.stringify(
        painted.error,
      )}`,
    );
    return [];
  }
  return created;
}

/** The inverse: dissolve the bake back to the single carrier frame with
 *  the stack in metadata and the front-most layer on its attributes. */
export async function releaseAppearance(
  host: BundleHost,
  id: ElementId,
  options: { label?: string } = {},
): Promise<boolean> {
  const label = options.label ?? APPEARANCE_RELEASE_COMMAND_ID;
  const prev = await host.document.getMetadata(id).catch(() => null);
  const record = appearanceBakeOf(prev);
  if (!record) {
    host.log.debug(`${label}: not a baked appearance — no-op`);
    return false;
  }
  const roots = await host.document.tree().catch(() => [] as SceneTreeNode[]);
  const group = parentGroupOf(roots, id);
  const alive = idsOf(await leafElements(host));
  const stack = appearanceOf(prev);
  const outcome = await host.document.mutate(
    releaseBatchFor({
      carrier: id,
      group,
      layers: record.layers.filter((layerId) => alive.has(layerId)),
      record,
      stack,
      carrierEnvelope: withAppearanceBake(withAppearance(prev, stack), null),
    }),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: release rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return false;
  }
  return true;
}

/** Re-bake an already-baked object after a stack edit: release, then
 *  bake the NEW stack. THREE undo steps (1 + 2) — the panel's edit cost
 *  on a baked object, named rather than hidden. Returns the metadata
 *  outcome shape `commitAppearance` promises. */
export async function rebakeAppearance(
  host: BundleHost,
  id: ElementId,
  stack: AppearanceStack,
  prev: PluginMetadataEnvelope | null,
): Promise<MutationOutcome> {
  const record = appearanceBakeOf(prev);
  if (!record) {
    return { applied: false, error: "not baked" };
  }
  const roots = await host.document.tree().catch(() => [] as SceneTreeNode[]);
  const group = parentGroupOf(roots, id);
  const alive = idsOf(await leafElements(host));
  // Release carries the NEW stack straight into the carrier's envelope,
  // so the released state is already the edited one.
  const released = await host.document.mutate(
    releaseBatchFor({
      carrier: id,
      group,
      layers: record.layers.filter((layerId) => alive.has(layerId)),
      record,
      stack,
      carrierEnvelope: withAppearanceBake(withAppearance(prev, stack), null),
    }),
  );
  if (!released.applied) return released;
  await bakeAppearance(host, id, { label: "appearance re-bake" });
  return released;
}

// ------------------------------------------------------------- commands

async function forEachSelectedCarrier(
  host: BundleHost,
  label: string,
  work: (carrier: ElementId) => Promise<unknown>,
): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${label}: no selection — no-op`);
    return;
  }
  const seen = new Set<string>();
  for (const id of selection) {
    const carrier = await resolveAppearanceCarrier(host, id);
    const key = `${carrier.kind}:${String(carrier.id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await work(carrier);
  }
}

/** Register `Appearance: Bake to group` + `Appearance: Release`. */
export function contributeAppearanceBakeCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: APPEARANCE_BAKE_COMMAND_ID,
      title: "Appearance: Bake stack to a group",
      category: "Appearance",
      handler: () =>
        forEachSelectedCarrier(host, APPEARANCE_BAKE_COMMAND_ID, (carrier) =>
          bakeAppearance(host, carrier),
        ),
    }),
    host.contribute.command({
      id: APPEARANCE_RELEASE_COMMAND_ID,
      title: "Appearance: Release baked stack",
      category: "Appearance",
      handler: () =>
        forEachSelectedCarrier(host, APPEARANCE_RELEASE_COMMAND_ID, (carrier) =>
          releaseAppearance(host, carrier),
        ),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
