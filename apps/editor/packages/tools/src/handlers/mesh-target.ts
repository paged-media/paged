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

// What the Mesh tool and the Gradient tool's freeform modes share: the
// frame a click is about (its inner box, its inner → page map and the
// mesh fill it holds now), its fill colour as a mesh colour, the one
// whole-value `frameFillMesh` write every gesture commits (engine ADR
// 1048: one write, one undo step), the overlay markers, and the Color
// panel's paint target (`PAINT_TARGET`, shell `tools/paint-target.ts`).

import type { ElementId, Mutation } from "@paged-media/client";
import {
  PAINT_TARGET,
  scopeOf,
  type PagedEditor,
  type PaintColor,
  type PaintTarget,
} from "@paged-media/shell";

import {
  applyAffine,
  invertAffine,
  MID_GREY,
  normalizeFill,
  type Affine,
  type InnerBox,
  type MeshColorSpec,
  type MeshFillSpec,
  type Vec2,
} from "../mesh/types";

/** The element kinds that take a mesh fill (a line has no inside). */
export const MESH_FILLABLE = new Set([
  "rectangle",
  "oval",
  "polygon",
  "textFrame",
]);

export const FILL_MESH_PATH = "frameFillMesh";

/** A frame as the mesh editors see it. */
export interface MeshTarget {
  id: ElementId;
  pageId: string;
  /** The inner box `[top, left, bottom, right]`. */
  box: InnerBox;
  /** Inner → page-local pt (null = identity). */
  toPage: Affine | null;
  /** Page-local → inner. */
  toInner: Affine;
  /** The mesh fill it holds now, or null. */
  fill: MeshFillSpec | null;
  /** The fill swatch ref (`Color/…`), when it has one. */
  fillRef: string | null;
}

type Client = PagedEditor["client"];
type Entries = ReadonlyArray<{ path: string; value?: unknown }>;

export function sameElement(a: ElementId | null, b: ElementId | null) {
  return (
    !!a &&
    !!b &&
    a.kind === b.kind &&
    JSON.stringify(a.id) === JSON.stringify(b.id)
  );
}

/** The `frameFillMesh` entry of an element's properties. */
export function fillMeshOf(entries: Entries): MeshFillSpec | null {
  const v = entries.find((e) => e.path === FILL_MESH_PATH)?.value as
    { type?: string; value?: unknown } | null | undefined;
  return v?.type === "fillMesh" ? normalizeFill(v.value) : null;
}

function fillRefOf(entries: Entries): string | null {
  const v = entries.find((e) => e.path === "frameFillColor")?.value as
    { type?: string; value?: string | null } | null | undefined;
  return v?.type === "colorRef" ? (v.value ?? null) : null;
}

/** Read a frame: its geometry and its fill. Null for an element that
 *  takes no mesh, sits on the pasteboard or does not resolve. */
export async function readMeshTarget(
  client: Client,
  id: ElementId,
): Promise<MeshTarget | null> {
  if (!MESH_FILLABLE.has(id.kind)) return null;
  const [geometry, props] = await Promise.all([
    client.elementGeometry([id]).catch(() => []),
    client.elementProperties(id).catch(() => null),
  ]);
  const geom = geometry[0];
  if (!geom?.pageId || !props) return null;
  const toPage = (geom.itemTransform ?? null) as Affine | null;
  const toInner = invertAffine(toPage);
  if (!toInner) return null;
  const entries = props.entries as Entries;
  return {
    id,
    pageId: geom.pageId,
    box: geom.bounds as InnerBox,
    toPage,
    toInner,
    fill: fillMeshOf(entries),
    fillRef: fillRefOf(entries),
  };
}

export function toInner(target: MeshTarget, pagePoint: Vec2): Vec2 {
  return applyAffine(target.toInner, pagePoint);
}

export function toPage(target: MeshTarget, inner: Vec2): Vec2 {
  return applyAffine(target.toPage, inner);
}

/** True when an inner point lies in the frame's inner box. */
export function inBox(target: MeshTarget, p: Vec2): boolean {
  const [top, left, bottom, right] = target.box;
  return p[0] >= left && p[0] <= right && p[1] >= top && p[1] <= bottom;
}

/** The element under a page point: the engine's hit test, else the one
 *  selected element. */
export async function elementUnder(
  paged: PagedEditor,
  pageId: string,
  pagePoint: Vec2,
): Promise<ElementId | null> {
  try {
    const reply = await paged.client.send({
      kind: "hitTest",
      payload: { pageId, docPoint: pagePoint, filter: "any" },
    });
    if (reply.kind === "hitResult" && reply.payload.element)
      return reply.payload.element;
  } catch {
    /* fall through to the selection */
  }
  const selection = paged.selection.elementSelection;
  return selection.length === 1 ? selection[0]! : null;
}

/** Make `id` the editor's selection (the frame a mesh edit is about
 *  carries the selection chrome, as with every other tool). */
export async function selectOnly(
  paged: PagedEditor,
  id: ElementId,
): Promise<void> {
  const current = paged.selection.elementSelection;
  if (current.length === 1 && sameElement(current[0]!, id)) return;
  try {
    const ids = await paged.client.setElementSelection([id], "replace");
    paged.selection.setElementSelection(ids);
    const items = await paged.client.elementGeometry(ids);
    paged.selection.setElementGeometry(items);
  } catch {
    /* the edit goes ahead; the chrome follows the next selection */
  }
}

const SPACES: Record<string, MeshColorSpec["space"]> = {
  RGB: "RGB",
  CMYK: "CMYK",
  LAB: "LAB",
  GRAY: "Gray",
};
const CHANNELS: Record<MeshColorSpec["space"], number> = {
  RGB: 3,
  CMYK: 4,
  LAB: 3,
  Gray: 1,
};

/** A swatch read (`colorPreview`) as a mesh colour: its authored space
 *  and channels, else its display RGB. Null when unreadable. */
export function previewToMeshColor(
  preview: {
    space?: string | null;
    value?: number[] | null;
    rgbHex?: string;
  } | null,
): MeshColorSpec | null {
  if (!preview) return null;
  const space = SPACES[(preview.space ?? "").toUpperCase()];
  if (space && preview.value && preview.value.length === CHANNELS[space]) {
    return { space, value: [...preview.value] };
  }
  const hex = /^#?([0-9a-f]{6})$/i.exec(preview.rgbHex ?? "")?.[1];
  if (!hex) return null;
  const n = parseInt(hex, 16);
  return { space: "RGB", value: [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
}

/** The frame's fill as a mesh colour; mid grey when it has none or it
 *  cannot be read (a gradient swatch, [None]). */
export async function fillColorOf(
  client: Client,
  target: MeshTarget,
): Promise<MeshColorSpec> {
  if (!target.fillRef || target.fillRef.endsWith("[None]")) return MID_GREY;
  const preview = await client.colorPreview(target.fillRef).catch(() => null);
  return previewToMeshColor(preview) ?? MID_GREY;
}

/** The Color panel's colour as a mesh colour. */
export function paintToMeshColor(color: PaintColor): MeshColorSpec {
  return { space: color.space, value: [...color.value] };
}

/** The one write every mesh gesture commits (`null` clears the mesh). */
export function fillMeshMutation(
  id: ElementId,
  spec: MeshFillSpec | null,
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: id,
      path: FILL_MESH_PATH,
      value: { type: "fillMesh", value: spec },
    },
  };
}

/** Commit `spec` on `id`; resolves true when the engine applied it. */
export async function commitFillMesh(
  paged: PagedEditor,
  id: ElementId,
  spec: MeshFillSpec | null,
  label: string,
): Promise<boolean> {
  try {
    const reply = await paged.client.mutate(fillMeshMutation(id, spec));
    if (reply.kind === "mutationFailed") {
      // eslint-disable-next-line no-console
      console.warn(
        `${label} rejected by engine:`,
        JSON.stringify((reply as { payload?: unknown }).payload),
      );
      return false;
    }
    return reply.kind === "mutationApplied";
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`${label} failed:`, err);
    return false;
  }
}

/** A square marker of half-size `r` around `p` (page-local pt). */
export function squareMarker(pageId: string, p: Vec2, r: number) {
  return {
    pageId,
    points: [
      [p[0] - r, p[1] - r],
      [p[0] + r, p[1] - r],
      [p[0] + r, p[1] + r],
      [p[0] - r, p[1] + r],
    ] as Array<[number, number]>,
    close: true,
  };
}

/** A diamond marker of half-diagonal `r` around `p` (page-local pt). */
export function diamondMarker(pageId: string, p: Vec2, r: number) {
  return {
    pageId,
    points: [
      [p[0], p[1] - r],
      [p[0] + r, p[1]],
      [p[0], p[1] + r],
      [p[0] - r, p[1]],
    ] as Array<[number, number]>,
    close: true,
  };
}

/** Hand the Color panel a target, or take ours back (`null`). */
export function setPaintTarget(
  paged: PagedEditor,
  owner: string,
  target: Omit<PaintTarget, "owner"> | null,
): void {
  const store = scopeOf(paged).get(PAINT_TARGET);
  if (target) store.set({ owner, ...target });
  else store.clear(owner);
}
