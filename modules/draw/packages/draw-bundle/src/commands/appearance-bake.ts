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
// MUTATION / UNDO SHAPE (measured against the booted engine, 0.64.0 —
// the RFI C-15 rule: assert the real count, never claim "one undo"):
//   · bake    = ONE batch ⇒ 1 undo step (DRW-5, ADR 360). The batch
//     inserts the N derived paths, names each with `bindCreated`, paints
//     and marks them by handle, clears the carrier, stamps its envelope
//     and wraps the group.
//
//     It used to be TWO: the bake record named its layers by element id
//     (`appearanceBake.layers`), an envelope is a JSON string, and a
//     `$h:` handle inside TEXT is content the engine never resolves
//     (pinned in `test/headless/minted.spec.ts`), so the record waited
//     for a first batch's ids. The record no longer names them: each
//     layer already carries a marker naming its carrier
//     (`appearanceLayer.of`, an id that exists before the batch), and the
//     layers are the carrier's group members carrying that marker
//     (`bakedLayersOf`). A record written before ADR 360 still lists
//     `layers`; release reads those too.
//   · release = ONE batch ⇒ 1 undo step (dissolve + delete + restore +
//     re-stamp all ride together; the group and the layers already
//     exist, so nothing is forward-referenced).
//   · an edit on an ALREADY-BAKED stack re-bakes = release + bake =
//     TWO undo steps.
//
// WHAT SURVIVES THE LOWERING — and what does not (probed, not assumed):
//   ✔ geometry: the derived paths carry the source's anchors + open
//     flag exactly (`insertPath`), and they export.
//   ✔ per-layer FILL colour, STROKE colour and STROKE WEIGHT: settable
//     on the derived Polygon and written by the IDML writer.
//   ✔ per-layer TINT and BLEND MODE (C-20): `FrameFillTint` and
//     `FrameBlendMode` grew Polygon + Oval arms in core's
//     `set_property`, and the IDML write-new lane emits both — the tint
//     as an attribute, the blend mode inside the `<TransparencySetting>`
//     C-19 taught that lane to write. So a tinted / multiplied layer
//     bakes, renders AND survives a save-back. The KIND boundary that
//     remains is deliberate, not a gap: `paged_model::GraphicLine` has
//     no `fill_tint` field (a line's paint is entirely stroke-side), so
//     a GraphicLine still refuses the tint; core 0.71.7's R-10 gave it
//     an object `opacity` / `blend_mode`, so it takes the blend now. The
//     bake never mints one — its layers are Polygons — so that boundary
//     does not bite here.
//   ✔ per-layer OPACITY: `FrameOpacity` always had a Polygon arm, and
//     since C-19 the write-new lane emits the `<TransparencySetting>`
//     that carries it, so opacity is canvas + PDF + IDML truth now.
//   ✘ COMPOUND (multi-subpath) sources: `insertPath` takes one contour
//     and one open flag, so a source with more than one subpath is
//     REFUSED with a diagnostic rather than silently flattened.
//   ✔ IDML SAVE-BACK of a baked group (C-19): core's IDML writer emits a
//     scene-created group as a real `<Group>` with its members nested and
//     re-based, and moves a source item that joined the group inside it.
//     The whole bake — wrapper, carrier and every derived layer — reaches
//     an IDML export and re-imports as the same group; the carrier's
//     `<Label>` (this plugin's envelope) rides the move, so a reopened
//     file still knows the stack and the bake record. Release is a
//     CHOICE now, not a prerequisite for saving.
//   ✔ PDF export: `paged-export-pdf` renders the composed scene, so
//     every baked layer paints into the PDF (asserted through the real
//     engine by counting the painted paths in the page content stream).
//
// RESIDUAL, still true after C-19 and NOT worked around here: an item the
// session INSERTED is emitted at the SPREAD'S CLOSE, so a baked group
// re-imports ABOVE every page item the source file already carried — its
// z-slot among unmodified siblings is not preserved by an IDML save (on
// the canvas the group does take the carrier's slot; the conformance spec
// pins both halves). Their ORDER within the insert lane is now correct:
// C-19 made the write-new lane follow the spread's z-table instead of the
// model's per-kind vecs, so three paths inserted u1,u2,u3 no longer
// export as u3,u2,u1 — which is what lets a stacked appearance re-import
// right side up.

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
import { labelKey } from "@paged-media/helpers";

import manifest from "../../manifest.json";
import {
  appearanceOf,
  bakeAppearanceMutations,
  withAppearance,
  type AppearanceStack,
  type FillLayer,
  type StrokeLayer,
} from "./appearance";
import { bindMinted, mutateMinting } from "./minted";
import { nativeAppearanceOn } from "./appearance-native";
import {
  bindCreatedMutationFor,
  handleElementId,
  oneBatchFor,
} from "./batch-handles";
import { leafIdsOf } from "./select-same";
import { parentGroupOf } from "./parentage";
import { linkIndex } from "../link-index";

import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";

/** Command titles, message keys `registerCommand` reads in the editor's locale. */
const M = defineMessages("draw.appearanceBake", {
  bake: "Appearance: Bake stack to a group",
  release: "Appearance: Release baked stack",
});
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
export const DRAW_METADATA_KEY = labelKey(manifest.id);

// ---------------------------------------------------------------- model

/** The bake RECORD stamped on the carrier alongside `data.appearance`.
 *  Its presence is what makes a baked object recognizable on reopen. */
export interface AppearanceBakeRecord {
  /** The derived layer element ids, BACK-TO-FRONT (paint order), as a
   *  record written before ADR 360 listed them; empty for a newer bake,
   *  whose layers are found by their markers ({@link bakedLayersOf}).
   *  Never written by a new bake. */
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
  // A record is its `restore` (ADR 360) or, written before it, its
  // `layers` list.
  const legacy = Array.isArray(r.layers);
  if (!legacy && (!r.restore || typeof r.restore !== "object")) return null;
  const restore = (r.restore ?? {}) as Partial<AppearanceBakeRecord["restore"]>;
  return {
    layers: legacy
      ? r.layers!.filter((id): id is string => typeof id === "string")
      : [],
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
    // A new record names no layer ids (ADR 360): only a legacy record
    // being carried forward keeps its list.
    const { layers, ...rest } = record;
    data.appearanceBake =
      Array.isArray(layers) && layers.length > 0 ? record : rest;
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
export type BakeRefusal =
  | "no-geometry"
  | "compound-path"
  | "empty-stack"
  // C-23 — the source sits on the PASTEBOARD. A bake stacks new
  // polygons via `insertPath(pageId, …)`, so with no page there is
  // nowhere to put them. NOT new behaviour: before C-23 the engine
  // omitted off-page elements from `pathAnchors` entirely, so this
  // flow already failed here — anonymously. Naming it is the change.
  | "pasteboard";

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
    if (!table.pageId) return { refusal: "pasteboard" };
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
  if (!item.pageId) return { refusal: "pasteboard" };
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
  path: "frameStrokeWeight" | "frameOpacity" | "frameFillTint",
  value: number,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "length", value } },
});

const text = (
  elementId: ElementId,
  path: "frameBlendMode",
  value: string,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "text", value } },
});

/** A RAW `setPluginMetadata` op carrying this plugin's envelope.
 *
 *  Exported because it is the ONE builder every module that needs its
 *  envelope write to ride INSIDE its own batch uses (the bake here, the
 *  graphic-style apply in `graphic-styles.ts`): the facade's
 *  `setMetadata` is its own mutation, i.e. its own undo step, so an
 *  in-batch stamp is the difference between one undo step and two. The
 *  SDK's namespace gate still checks the key on the way through — a
 *  foreign key is refused before the engine sees it. */
export const stampDrawMetadata = (
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

const stamp = stampDrawMetadata;

/** The batch handle the bake names its `i`-th derived layer by. */
export const bakeLayerHandle = (i: number): string => `bake-layer-${i}`;

/** The first half of the bake batch — `count` copies of the source
 *  contour, inserted bottom-to-top, each named by
 *  {@link bakeLayerHandle} right after it. Exported so the conformance
 *  spec asserts the EXACT wire shape. */
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
    ops.push(bindCreatedMutationFor(bakeLayerHandle(i)));
  }
  return { op: "batch", args: { ops } };
}

/** The per-layer paint ops for ONE derived element: exactly ONE paint (a
 *  fill layer clears its stroke and vice versa), plus the modifiers that
 *  paint carries — a fill's `tint`, and either kind's `opacity` and
 *  `blendMode`. Tint and blend used to be withheld because core's
 *  `set_property` had no Polygon arm for `FrameFillTint` /
 *  `FrameBlendMode`; C-20 added both (and C-19 taught the IDML
 *  write-new lane to emit them), so withholding them now would be the
 *  fiction. A layer that carries neither emits neither. */
export function bakeLayerPaintFor(
  elementId: ElementId,
  layer: BakeLayer,
): Mutation[] {
  const ops: Mutation[] = [];
  if (layer.kind === "fill") {
    ops.push(colorRef(elementId, "frameFillColor", layer.color));
    ops.push(colorRef(elementId, "frameStrokeColor", null));
    if (typeof layer.tint === "number") {
      ops.push(length(elementId, "frameFillTint", layer.tint));
    }
  } else {
    ops.push(colorRef(elementId, "frameFillColor", null));
    ops.push(colorRef(elementId, "frameStrokeColor", layer.color));
    ops.push(length(elementId, "frameStrokeWeight", layer.weight));
  }
  if (typeof layer.opacity === "number") {
    ops.push(length(elementId, "frameOpacity", layer.opacity));
  }
  if (typeof layer.blendMode === "string" && layer.blendMode.length > 0) {
    ops.push(text(elementId, "frameBlendMode", layer.blendMode));
  }
  return ops;
}

/** The second half of the bake batch — paint every derived layer, stamp
 *  its marker, clear the carrier's own paint, write the carrier's
 *  envelope (stack + bake record) and wrap the whole thing in a group.
 *  `created` is back-to-front, parallel to `layers`: the layers' batch
 *  handles inside the one bake batch ({@link bakeBatchFor}), or ids.
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

/** The whole bake as ONE batch, one undo step (DRW-5, ADR 360): insert
 *  and name the layers, then paint, mark and group them by handle. */
export function bakeBatchFor(args: {
  carrier: ElementId;
  geometry: BakeGeometry;
  layers: readonly BakeLayer[];
  carrierEnvelope: PluginMetadataEnvelope | null;
}): Mutation {
  return oneBatchFor([
    bakeInsertBatchFor(args.geometry, args.layers.length),
    bakePaintBatchFor({
      carrier: args.carrier,
      created: args.layers.map((_, i) => handleElementId(bakeLayerHandle(i))),
      layers: args.layers,
      carrierEnvelope: args.carrierEnvelope,
    }),
  ]);
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
      if (e.path === "frameFillColor" && v.type === "colorRef")
        out.fill = v.value;
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
  // Through the link index (`../link-index`): the tree and each envelope
  // are read once per document revision, so resolving a carrier and then
  // reading its stack — which every caller does — is one read, not two.
  const index = linkIndex(host);
  if (id.kind === "group") {
    const roots = await index.tree();
    for (const child of groupChildren(roots, id)) {
      const env = await index.envelopeOf(child);
      if (appearanceBakeOf(env)) return child;
    }
    return id;
  }
  const env = await index.envelopeOf(id);
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

/** The derived layers of the baked carrier `carrier`, back-to-front: the
 *  members of its group whose marker names it (ADR 360), then any id a
 *  record written before ADR 360 lists that is still alive and not among
 *  them. */
export async function bakedLayersOf(
  host: BundleHost,
  carrier: ElementId,
  record: AppearanceBakeRecord | null = null,
): Promise<string[]> {
  const index = linkIndex(host);
  const roots = await index.tree();
  const group = parentGroupOf(roots, carrier);
  const out: string[] = [];
  if (group) {
    for (const member of groupChildren(roots, group)) {
      if (typeof member.id !== "string" || member.id === carrier.id) continue;
      const marker = appearanceLayerOf(await index.envelopeOf(member));
      if (marker && marker.of.id === carrier.id) out.push(member.id);
    }
  }
  const alive = idsOf(leafIdsOf(roots));
  for (const id of record?.layers ?? []) {
    if (alive.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
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
    host.log.debug(
      `${label}: nothing to bake (empty appearance stack) — no-op`,
    );
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
  // The record names no layer ids (ADR 360), so the whole bake is one
  // batch: the layers are addressed by handle and found again by marker.
  const record: AppearanceBakeRecord = { layers: [], restore };
  const batch = bakeBatchFor({
    carrier: id,
    geometry: geometry.geometry,
    layers,
    carrierEnvelope: withAppearanceBake(withAppearance(prev, stack), record),
  });
  const baked = await mutateMinting(host, batch);
  if (!baked.outcome.applied) {
    host.log.warn(
      `${label}: bake batch rejected by engine: ${JSON.stringify(
        baked.outcome.error,
      )}`,
    );
    return [];
  }
  // What each handle minted, off the engine's reply (`commands/minted.ts`).
  // The batch has applied either way; a reply that does not match the
  // batch only leaves the ids unknown here.
  const bound = bindMinted(baked, batch);
  const created = layers
    .map((_, i) => bound?.byHandle.get(bakeLayerHandle(i)))
    .filter((e): e is ElementId => e !== undefined);
  if (created.length !== layers.length) {
    host.log.warn(
      `${label}: the engine's reply names ${created.length} of ` +
        `${layers.length} derived layers`,
    );
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
  // ONE tree read answers both questions (it used to be read twice, back
  // to back): which group holds the carrier, and which layers are alive.
  const roots = await linkIndex(host).tree();
  const group = parentGroupOf(roots, id);
  const layers = await bakedLayersOf(host, id, record);
  const stack = appearanceOf(prev);
  const outcome = await host.document.mutate(
    releaseBatchFor({
      carrier: id,
      group,
      layers,
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
 *  bake the NEW stack. TWO undo steps (1 + 1) — the panel's edit cost
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
  const roots = await linkIndex(host).tree();
  const group = parentGroupOf(roots, id);
  const layers = await bakedLayersOf(host, id, record);
  // Release carries the NEW stack straight into the carrier's envelope,
  // so the released state is already the edited one.
  const released = await host.document.mutate(
    releaseBatchFor({
      carrier: id,
      group,
      layers,
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
    registerCommand(host, {
      id: APPEARANCE_BAKE_COMMAND_ID,
      title: M.bake,
      category: "Appearance",
      handler: () =>
        forEachSelectedCarrier(
          host,
          APPEARANCE_BAKE_COMMAND_ID,
          async (carrier) => {
            // Draw ADR 367: on an engine with native appearance there is no
            // metadata stack to bake — the engine draws every fill and
            // stroke, and IDML export bakes them. A stack the migration has
            // not moved yet still bakes.
            if (nativeAppearanceOn(host)) {
              const env = await host.document
                .getMetadata(carrier)
                .catch(() => null);
              const stack = appearanceOf(env);
              if (stack.fills.length === 0 && stack.strokes.length === 0) {
                host.log.info(
                  `${APPEARANCE_BAKE_COMMAND_ID}: the appearance is native — the engine draws every fill and stroke and IDML export bakes them; Object ▸ Expand appearance makes live effects artwork`,
                );
                return;
              }
            }
            await bakeAppearance(host, carrier);
          },
        ),
    }),
    registerCommand(host, {
      id: APPEARANCE_RELEASE_COMMAND_ID,
      title: M.release,
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
