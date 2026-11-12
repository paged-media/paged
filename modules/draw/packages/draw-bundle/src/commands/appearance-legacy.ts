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

// LEGACY GROUP BAKES (draw ADR 354): what a document saved before the
// engine's native appearance (draw ADR 367, engine ADR 1043) may hold. The
// bake that wrote them is gone: every host has `document.appearance@1`,
// the engine draws several fills and strokes itself and IDML export bakes
// them. What stays is the READ side of that old format, which the
// migration needs (`appearance-migrate.ts` releases a baked stack before it
// moves the stack onto `frameAppearance`): the bake record and the layer
// marker, the derived layers of a carrier, the release batch, and resolving
// a selected layer or group to its carrier.

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationOutcome,
  PluginMetadataEnvelope,
  SceneTreeNode,
} from "@paged-media/plugin-api";

import {
  bakeAppearanceMutations,
  withAppearance,
  type AppearanceStack,
} from "./appearance";
import { stampDrawMetadata as stamp } from "./draw-metadata";
import { leafIdsOf } from "./select-same";
import { parentGroupOf } from "./parentage";
import { linkIndex } from "../link-index";

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

// ------------------------------------------------------------- readers

const idsOf = (list: readonly ElementId[]): Set<string> =>
  new Set(
    list
      .map((e) => (typeof e.id === "string" ? e.id : null))
      .filter((s): s is string => s !== null),
  );

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

/** An edit of a stack a legacy bake still holds (a document the
 *  migration could not move): release the derived layers with the NEW
 *  stack in the carrier's envelope, one batch, one undo step. Answers the
 *  metadata outcome shape `commitAppearance` promises. */
export async function releaseBakedWithStack(
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
  // The release carries the NEW stack straight into the carrier's
  // envelope, so the released state is already the edited one.
  return host.document.mutate(
    releaseBatchFor({
      carrier: id,
      group,
      layers,
      record,
      stack,
      carrierEnvelope: withAppearanceBake(withAppearance(prev, stack), null),
    }),
  );
}
