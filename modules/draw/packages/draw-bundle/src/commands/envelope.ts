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

// ENVELOPE DISTORT and EXPAND APPEARANCE (draw ADR 367, plan WP6.3).
//
// An envelope is an entry of the item's object effect stack (engine ADR
// 1042), so it is LIVE: the engine draws the item bent, on both
// rasterizers and in PDF; the anchor tools keep editing the source; the
// host's Effects and Appearance panels list it; IDML bakes it and keeps
// the source in a label. Two kinds serve as envelopes:
//
//   · `warp` — Make with Warp: one of the fifteen styles (Arc 50 %, as
//     Illustrator's dialog opens), its options edited where every effect's
//     are (the host Appearance panel raised by the command);
//   · `envelope` — Make with Mesh and Make with Top Object: a mesh of
//     Bézier patches over the item's box (a new engine kind, this ADR),
//     edited on canvas with the Envelope Mesh tool.
//
// The verbs:
//
//   Make with Warp / Make with Mesh — append the entry to every selected
//     item that takes an object stack (rectangles, ovals, polygons, text
//     frames); one batch, one undo step.
//   Make with Top Object — the frontmost selected item's outline becomes
//     the envelope of the others: its outline is cut at its box corners
//     into four cubics and blended into one patch (`outlinePatch`); each
//     content item gets the part of that patch over its own box
//     (`restrictPatch`), so items made together map as ONE union box onto
//     the shape, as Illustrator's do. The top object is deleted, in the
//     same batch.
//   Edit Contents — switches to Direct Selection with the items
//     selected: their SOURCE paths are what that tool edits, while the
//     canvas keeps drawing the envelope (Illustrator's Edit Contents).
//   Expand — makes the envelope permanent: the envelope and every vector
//     entry before it (what draws INTO it) are expanded by the engine's
//     `expandAppearance`; vector entries after it stay live. One batch.
//   Object ▸ Expand Appearance — `expandAppearance` on every selected
//     item (or group with a Pathfinder entry) that has a vector effect.
//
// DIFFERENCES FROM ILLUSTRATOR, named: an envelope is per item (Make with
// Warp / Mesh on several items gives each its own; Illustrator wraps them
// in one envelope object); a group cannot take one (a group's stack holds
// only a Pathfinder-led compound shape, engine ADR 1042); and Expand
// Appearance expands live effects only — an item's several fills and
// strokes stay native (IDML export bakes them, engine ADR 1043).

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import {
  ellipseToPath,
  ENVELOPE_MAX_CELLS,
  flatNet,
  mapTable,
  outlinePatch,
  restrictPatch,
  runBox,
  type Affine,
  type AnchorTable,
  type EnvelopeBox,
  type EnvelopeNet,
  type Vec2,
} from "@paged-media/draw-geometry";
import { defineMessages } from "@paged-media/strings";

import { registerCommand } from "../command-registry";
import { batchMutationFor } from "./batch-handles";
import { paintOrderLeaves, orderTopToBottom } from "./pathfinder-region";
import { readDistortTargets } from "./distort-shared";
import { readEditablePath, tableOfRead } from "./path-rewrite";

const M = defineMessages("draw.envelope", {
  makeWithWarp: "Envelope distort: Make with warp",
  makeWithMesh: "Envelope distort: Make with mesh",
  makeWithTopObject: "Envelope distort: Make with top object",
  editContents: "Envelope distort: Edit contents",
  expand: "Envelope distort: Expand",
  expandAppearance: "Expand appearance",
  meshTool: "Envelope mesh",
});

const C = "media.paged.draw.command";
export const ENVELOPE_WARP_COMMAND_ID = `${C}.envelopeMakeWithWarp`;
export const ENVELOPE_MESH_COMMAND_ID = `${C}.envelopeMakeWithMesh`;
export const ENVELOPE_TOP_OBJECT_COMMAND_ID = `${C}.envelopeMakeWithTopObject`;
export const ENVELOPE_EDIT_CONTENTS_COMMAND_ID = `${C}.envelopeEditContents`;
export const ENVELOPE_EXPAND_COMMAND_ID = `${C}.envelopeExpand`;
export const EXPAND_APPEARANCE_COMMAND_ID = `${C}.expandAppearance`;
export const ENVELOPE_MESH_TOOL_COMMAND_ID = `${C}.envelopeMeshTool`;
export const ENVELOPE_MESH_TOOL_ID = "media.paged.draw.tool.envelopeMesh";
export const ENVELOPE_COMMAND_IDS = [
  ENVELOPE_WARP_COMMAND_ID,
  ENVELOPE_MESH_COMMAND_ID,
  ENVELOPE_TOP_OBJECT_COMMAND_ID,
  ENVELOPE_EDIT_CONTENTS_COMMAND_ID,
  ENVELOPE_EXPAND_COMMAND_ID,
  EXPAND_APPEARANCE_COMMAND_ID,
  ENVELOPE_MESH_TOOL_COMMAND_ID,
] as const;

/** The host's Direct Selection tool (Edit Contents switches to it). */
export const DIRECT_SELECT_TOOL_ID = "paged.tool.directSelect";
/** The host's Appearance panel (Make with Warp raises it). */
export const HOST_APPEARANCE_PANEL_ID = "paged.appearance";

/** The page items whose object stack takes a vector effect. */
export const ENVELOPE_KINDS: ReadonlySet<string> = new Set([
  "rectangle",
  "oval",
  "polygon",
  "textFrame",
]);

/** The entry kinds that are envelopes. */
export const ENVELOPE_ENTRY_KINDS: ReadonlySet<string> = new Set([
  "envelope",
  "warp",
]);

/** The vector effect kinds (engine ADR 1042, and the envelope). */
const VECTOR_KINDS: ReadonlySet<string> = new Set([
  "roughen",
  "zigZag",
  "puckerBloat",
  "twist",
  "tweak",
  "transformCopies",
  "freeDistort",
  "warp",
  "envelope",
  "offsetPath",
  "outlinePath",
  "roundCorners",
  "scribble",
  "convertToShape",
  "pathfinder",
]);

/** One entry of an effect stack on the wire (`EffectEntrySpec`). */
export interface StackEntry {
  kind: string;
  enabled?: boolean;
  [field: string]: unknown;
}

/** Illustrator's fifteen warp styles, as the engine spells them. */
export const WARP_STYLES = [
  "arc",
  "arcLower",
  "arcUpper",
  "arch",
  "bulge",
  "shellLower",
  "shellUpper",
  "flag",
  "wave",
  "fish",
  "rise",
  "fisheye",
  "inflate",
  "squeeze",
  "twist",
] as const;

/** Illustrator's Make with Warp dialog opens on Arc, 50 %, horizontal. */
export const DEFAULT_WARP: StackEntry = {
  kind: "warp",
  enabled: true,
  style: "arc",
  horizontal: true,
  bendPct: 50,
  distortHPct: 0,
  distortVPct: 0,
};

/** Illustrator's Make with Mesh dialog opens on 4 × 4. */
export const DEFAULT_MESH = { rows: 4, columns: 4 } as const;

/** A mesh envelope entry. */
export function meshEntry(
  rows: number,
  columns: number,
  mesh: EnvelopeNet = flatNet(rows, columns),
): StackEntry {
  return { kind: "envelope", enabled: true, rows, columns, mesh };
}

const stackPath = (id: ElementId) =>
  id.kind === "group" ? "groupEffectStack" : "frameEffectStack";

/** The entries of a read `effectStack` value, or null. */
export function entriesOfValue(value: unknown): StackEntry[] | null {
  if (Array.isArray(value)) return value as StackEntry[];
  if (!value || typeof value !== "object") return null;
  const v = value as { type?: string; value?: unknown; entries?: unknown };
  const inner = v.type === "effectStack" ? v.value : v;
  const entries = (inner as { entries?: unknown } | null)?.entries;
  return Array.isArray(entries) ? (entries as StackEntry[]) : null;
}

/** The object stack of `id` (empty when it has none, null when the item
 *  takes none). */
export async function readObjectStack(
  host: BundleHost,
  id: ElementId,
): Promise<StackEntry[] | null> {
  const props = await host.document.elementProperties(id).catch(() => null);
  const row = props?.entries.find((e) => e.path === stackPath(id));
  if (!row) return null;
  return entriesOfValue(row.value) ?? [];
}

/** The write of `entries` as `id`'s object stack. */
export function objectStackMutation(
  id: ElementId,
  entries: readonly StackEntry[],
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: id,
      path: stackPath(id),
      value: { type: "effectStack", value: { entries: [...entries] } },
    },
  } as Mutation;
}

/** The index of the item's envelope: its LAST `envelope` or `warp`
 *  entry, -1 when it has none. */
export function envelopeIndexOf(entries: readonly StackEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--)
    if (ENVELOPE_ENTRY_KINDS.has(entries[i]!.kind)) return i;
  return -1;
}

const isVector = (e: StackEntry) => VECTOR_KINDS.has(e.kind);

/** The ops that expand `id`'s envelope (at `index`) and the vector
 *  entries before it, keeping the ones after it live. */
export function expandEnvelopeOps(
  id: ElementId,
  entries: readonly StackEntry[],
  index: number,
): Mutation[] {
  const after = entries.filter((e, i) => i > index && isVector(e));
  const expand: Mutation = {
    op: "expandAppearance",
    args: { elementId: id },
  } as Mutation;
  if (after.length === 0) return [expand];
  const upTo = entries.filter((e, i) => i <= index || !isVector(e));
  // An oval comes back as a polygon of its id (engine ADR 1042).
  const expanded: ElementId =
    id.kind === "oval" ? ({ kind: "polygon", id: id.id } as ElementId) : id;
  // Keep the stack's order among what stays: the paint entries, then the
  // later vector entries in their places.
  const rest = entries.filter((e, i) => !isVector(e) || i > index);
  return [
    objectStackMutation(id, upTo),
    expand,
    objectStackMutation(expanded, rest),
  ];
}

/** What an envelope command acts on: an item, its box in its own space
 *  (the engine's source box), the transform to the page, its page. */
export interface EnvelopeTarget {
  id: ElementId;
  pageId: string;
  box: EnvelopeBox;
  matrix: Affine | null;
  entries: StackEntry[];
}

/** The item's tight source box in its own space: its path's when it has
 *  one, else its frame box (an oval's ellipse and a text frame's box). */
async function sourceBox(
  host: BundleHost,
  id: ElementId,
): Promise<{ box: EnvelopeBox; matrix: Affine | null; pageId: string } | null> {
  const read =
    id.kind === "textFrame"
      ? null
      : await readEditablePath(host, id).catch(() => null);
  if (read && read.anchors.length >= 2) {
    const { table, matrix } = tableOfRead(read);
    const starts = [...table.subpathStarts, table.anchors.length];
    let box: EnvelopeBox | null = null;
    for (let k = 0; k + 1 < starts.length; k++) {
      const run = table.anchors.slice(starts[k], starts[k + 1]);
      const open = table.subpathOpen?.[k] ?? false;
      const b = runBox(run, !open);
      if (!b) continue;
      box = box
        ? (() => {
            const x0 = Math.min(box!.x, b.x);
            const y0 = Math.min(box!.y, b.y);
            const x1 = Math.max(box!.x + box!.w, b.x + b.w);
            const y1 = Math.max(box!.y + box!.h, b.y + b.h);
            return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          })()
        : b;
    }
    if (box && read.pageId) return { box, matrix, pageId: read.pageId };
  }
  const [g] = await host.document.elementGeometry([id]).catch(() => []);
  if (!g?.pageId || !g.bounds) return null;
  const [top, left, bottom, right] = g.bounds;
  return {
    box: { x: left, y: top, w: right - left, h: bottom - top },
    matrix: (g.itemTransform ?? null) as Affine | null,
    pageId: g.pageId,
  };
}

/** Read `ids` that take an envelope (others are skipped). */
export async function readEnvelopeTargets(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<EnvelopeTarget[]> {
  const out: EnvelopeTarget[] = [];
  for (const id of ids) {
    if (!ENVELOPE_KINDS.has(id.kind)) continue;
    const entries = await readObjectStack(host, id);
    if (!entries) continue;
    const src = await sourceBox(host, id);
    if (!src || src.box.w <= 1e-9 || src.box.h <= 1e-9) continue;
    out.push({ id, ...src, entries });
  }
  return out;
}

/** A user-facing refusal: logged, and thrown so a typed caller sees it. */
function refuse(host: BundleHost, label: string, why: string): never {
  host.log.warn(`${label}: ${why}`);
  throw new Error(`${label}: ${why}`);
}

async function send(
  host: BundleHost,
  label: string,
  ops: readonly Mutation[],
): Promise<boolean> {
  if (ops.length === 0) return false;
  const out = await host.document.mutate(batchMutationFor(ops), { label });
  if (!out.applied)
    host.log.warn(
      `${label}: refused by the engine: ${JSON.stringify(out.error)}`,
    );
  return out.applied;
}

/** The editor's command registry, read structurally (puppet-warp.ts). */
function invokeDoorOf(
  paged: unknown,
): ((id: string) => Promise<unknown>) | null {
  const commands = (
    paged as { registries?: { commands?: { invoke?: unknown } } } | null
  )?.registries?.commands;
  const invoke = commands?.invoke;
  return typeof invoke === "function"
    ? (id: string) =>
        Promise.resolve((invoke as (id: string) => unknown).call(commands, id))
    : null;
}

async function runDoor(
  host: BundleHost,
  paged: unknown,
  id: string,
): Promise<boolean> {
  const invoke = invokeDoorOf(paged) ?? invokeDoorOf(host.editor);
  if (!invoke) return false;
  try {
    await invoke(id);
    return true;
  } catch (e) {
    host.log.warn(`${id}: ${String(e)}`);
    return false;
  }
}

const selectedTargets = async (host: BundleHost, label: string) => {
  const targets = await readEnvelopeTargets(host, host.selection.get());
  if (targets.length === 0)
    refuse(
      host,
      label,
      "select a rectangle, oval, polygon or text frame (a group takes no envelope)",
    );
  return targets;
};

/** Make with Warp: a `warp` entry on every selected item. */
export async function makeWithWarp(
  host: BundleHost,
  warp: Partial<StackEntry> = {},
): Promise<ElementId[]> {
  const label = "Make envelope with warp";
  const targets = await selectedTargets(host, label);
  const entry = { ...DEFAULT_WARP, ...warp, kind: "warp", enabled: true };
  const ok = await send(
    host,
    label,
    targets.map((t) => objectStackMutation(t.id, [...t.entries, entry])),
  );
  return ok ? targets.map((t) => t.id) : [];
}

const cells = (n: unknown, fallback: number) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.min(ENVELOPE_MAX_CELLS, Math.max(1, Math.round(n)))
    : fallback;

/** Make with Mesh: a flat `rows` × `columns` mesh on every selected item. */
export async function makeWithMesh(
  host: BundleHost,
  rows: number = DEFAULT_MESH.rows,
  columns: number = DEFAULT_MESH.columns,
): Promise<ElementId[]> {
  const label = "Make envelope with mesh";
  const targets = await selectedTargets(host, label);
  const r = cells(rows, DEFAULT_MESH.rows);
  const c = cells(columns, DEFAULT_MESH.columns);
  const ok = await send(
    host,
    label,
    targets.map((t) =>
      objectStackMutation(t.id, [...t.entries, meshEntry(r, c)]),
    ),
  );
  return ok ? targets.map((t) => t.id) : [];
}

const mapAffine = (m: Affine | null, p: Vec2): [number, number] =>
  m
    ? [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
    : [p[0], p[1]];

/** The page-space box of a target (its own box through its transform). */
function pageBox(t: EnvelopeTarget): EnvelopeBox {
  const { x, y, w, h } = t.box;
  const corners: Vec2[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const pts = corners.map((p) => mapAffine(t.matrix, p));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** The page-space outline of the item Make with Top Object bends into:
 *  its path, a box rectangle's frame box (distort-shared's reading), or
 *  an oval's ellipse in its frame box. */
async function topOutline(
  host: BundleHost,
  id: ElementId,
): Promise<AnchorTable | null> {
  const [t] = await readDistortTargets(host, [id]);
  if (t && t.page.anchors.length >= 3) return t.page;
  if (id.kind !== "oval") return null;
  const [g] = await host.document.elementGeometry([id]).catch(() => []);
  if (!g?.bounds) return null;
  const [top, left, bottom, right] = g.bounds;
  const table = ellipseToPath(
    (left + right) / 2,
    (top + bottom) / 2,
    (right - left) / 2,
    (bottom - top) / 2,
  );
  return mapTable(table, (g.itemTransform ?? [1, 0, 0, 1, 0, 0]) as Affine);
}

/** Make with Top Object: the frontmost selected item's outline becomes
 *  the envelope of the others, and goes. */
export async function makeWithTopObject(
  host: BundleHost,
): Promise<ElementId[]> {
  const label = "Make envelope with top object";
  const selection = host.selection.get();
  if (selection.length < 2)
    refuse(
      host,
      label,
      "select the contents and, in front of them, the envelope shape",
    );
  const roots = await host.document.tree().catch(() => []);
  const ordered = orderTopToBottom(selection, paintOrderLeaves(roots));
  const top = ordered[0]!;
  const outline = await topOutline(host, top);
  if (!outline)
    refuse(
      host,
      label,
      "the frontmost item has no closed outline to bend into",
    );
  if (outline.subpathStarts.length > 1 || outline.subpathOpen?.[0])
    refuse(host, label, "the frontmost item must be one closed path");
  const shape = outlinePatch(outline.anchors);
  if (!shape) refuse(host, label, "the frontmost item has no area");
  const contents = await readEnvelopeTargets(host, ordered.slice(1));
  if (contents.length === 0)
    refuse(host, label, "nothing behind the frontmost item takes an envelope");
  if (
    contents.some((t) => t.matrix && (t.matrix[1] !== 0 || t.matrix[2] !== 0))
  )
    host.log.info(
      `${label}: a rotated or sheared item is mapped by its own box, so the shape follows its turn`,
    );
  // The union box of the contents, on the page.
  const boxes = contents.map(pageBox);
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const ops: Mutation[] = [];
  contents.forEach((t, k) => {
    const b = boxes[k]!;
    // The part of the patch over this item's box…
    const part = restrictPatch(
      shape!,
      (b.x - x0) / (x1 - x0),
      (b.x + b.w - x0) / (x1 - x0),
      (b.y - y0) / (y1 - y0),
      (b.y + b.h - y0) / (y1 - y0),
    );
    // …in the item's box's unit square (page space → its own box).
    const net = part.map((p): [number, number] => [
      (p[0] - b.x) / b.w,
      (p[1] - b.y) / b.h,
    ]);
    ops.push(objectStackMutation(t.id, [...t.entries, meshEntry(1, 1, net)]));
  });
  ops.push({
    op: "deleteFrame",
    args: { frameId: String((top as { id: unknown }).id) },
  } as Mutation);
  const ok = await send(host, label, ops);
  return ok ? contents.map((t) => t.id) : [];
}

/** Expand the envelope of every selected item that has one. */
export async function expandEnvelope(host: BundleHost): Promise<ElementId[]> {
  const label = "Expand envelope";
  const targets = (
    await readEnvelopeTargets(host, host.selection.get())
  ).filter((t) => envelopeIndexOf(t.entries) >= 0);
  if (targets.length === 0)
    refuse(host, label, "the selection has no envelope to expand");
  const ok = await send(
    host,
    label,
    targets.flatMap((t) =>
      expandEnvelopeOps(t.id, t.entries, envelopeIndexOf(t.entries)),
    ),
  );
  return ok ? targets.map((t) => t.id) : [];
}

/** Expand Appearance: every selected item (or group) with a vector
 *  effect keeps its effected outline for good. */
export async function expandAppearance(host: BundleHost): Promise<ElementId[]> {
  const label = "Expand appearance";
  const ids: ElementId[] = [];
  for (const id of host.selection.get()) {
    const entries = await readObjectStack(host, id);
    if (entries?.some((e) => e.enabled !== false && isVector(e))) ids.push(id);
  }
  if (ids.length === 0)
    refuse(host, label, "the selection has no live effect to expand");
  const ok = await send(
    host,
    label,
    ids.map(
      (id) => ({ op: "expandAppearance", args: { elementId: id } }) as Mutation,
    ),
  );
  return ok ? ids : [];
}

/** A menu click (no payload) that is refused has been logged and settles
 *  quietly, as every menu row here does; a typed caller (a payload) gets
 *  the refusal thrown. */
async function quietFromMenu<T>(
  payload: unknown,
  run: () => Promise<T>,
): Promise<T | null> {
  if (payload !== undefined) return run();
  try {
    return await run();
  } catch {
    return null;
  }
}

export function contributeEnvelopeCommands(host: BundleHost): Disposable {
  const payloadOf = (p: unknown) =>
    (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const subs = [
    registerCommand(host, {
      id: ENVELOPE_WARP_COMMAND_ID,
      title: M.makeWithWarp,
      category: "Object",
      handler: (_paged, payload) =>
        quietFromMenu(payload, async () => {
          const p = payloadOf(payload);
          const warp: Partial<StackEntry> = {};
          for (const k of [
            "style",
            "horizontal",
            "bendPct",
            "distortHPct",
            "distortVPct",
          ])
            if (p[k] !== undefined) warp[k] = p[k];
          const ids = await makeWithWarp(host, warp);
          // The warp's options are edited where every effect's are.
          if (ids.length > 0 && payload === undefined)
            host.shell.openPanel(HOST_APPEARANCE_PANEL_ID);
          return ids;
        }),
    }),
    registerCommand(host, {
      id: ENVELOPE_MESH_COMMAND_ID,
      title: M.makeWithMesh,
      category: "Object",
      handler: (_paged, payload) =>
        quietFromMenu(payload, () => {
          const p = payloadOf(payload);
          return makeWithMesh(
            host,
            cells(p.rows, DEFAULT_MESH.rows),
            cells(p.columns, DEFAULT_MESH.columns),
          );
        }),
    }),
    registerCommand(host, {
      id: ENVELOPE_TOP_OBJECT_COMMAND_ID,
      title: M.makeWithTopObject,
      category: "Object",
      handler: (_paged, payload) =>
        quietFromMenu(payload, () => makeWithTopObject(host)),
    }),
    registerCommand(host, {
      id: ENVELOPE_EDIT_CONTENTS_COMMAND_ID,
      title: M.editContents,
      category: "Object",
      handler: (paged, payload) =>
        quietFromMenu(payload, async () => {
          const label = "Edit envelope contents";
          const targets = (
            await readEnvelopeTargets(host, host.selection.get())
          ).filter((t) => envelopeIndexOf(t.entries) >= 0);
          if (targets.length === 0)
            refuse(host, label, "the selection has no envelope");
          await host.selection.set(targets.map((t) => t.id));
          const switched = await runDoor(
            host,
            paged,
            `paged.tool.activate.${DIRECT_SELECT_TOOL_ID}`,
          );
          if (!switched)
            host.log.info(
              `${label}: pick Direct Selection — it edits the contents while the envelope keeps drawing`,
            );
          return { activated: switched };
        }),
    }),
    registerCommand(host, {
      id: ENVELOPE_EXPAND_COMMAND_ID,
      title: M.expand,
      category: "Object",
      handler: (_paged, payload) =>
        quietFromMenu(payload, () => expandEnvelope(host)),
    }),
    registerCommand(host, {
      id: EXPAND_APPEARANCE_COMMAND_ID,
      title: M.expandAppearance,
      category: "Object",
      handler: (_paged, payload) =>
        quietFromMenu(payload, () => expandAppearance(host)),
    }),
    registerCommand(host, {
      id: ENVELOPE_MESH_TOOL_COMMAND_ID,
      title: M.meshTool,
      category: "Object",
      handler: async (paged) => {
        const switched = await runDoor(
          host,
          paged,
          `paged.tool.activate.${ENVELOPE_MESH_TOOL_ID}`,
        );
        if (!switched)
          host.log.info(
            `${ENVELOPE_MESH_TOOL_COMMAND_ID}: this host cannot switch tools for a plugin — pick Envelope Mesh in the Free Transform flyout`,
          );
        return { activated: switched };
      },
    }),
  ];
  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
