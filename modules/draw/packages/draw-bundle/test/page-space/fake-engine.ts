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

// A FAKE ENGINE for the page-space specs: one spread whose pages need not
// start at its origin, holding what the real engine STORES, and answering
// the geometry reads in either of the two shapes a host can boot:
//
//   · "spread" — the published engine (canvas-wasm 0.71.x): `itemTransform`
//     is the stored, spread-space matrix and there is no `pageOrigin`;
//   · "page"   — core's page-space fix (paged-media/core#70): the page's
//     origin is folded into `itemTransform` and reported as `pageOrigin`.
//
// The writes do what core does with them, measured from its source
// (`paged-canvas` `InsertPath`: the page's `spread_origin` is ADDED to every
// anchor; `paged-mutate` `set_property`: `framePath`, `frameBounds` and
// `frameTransform` are stored VERBATIM). Assertions read where an item
// really is — its stored anchors through its stored transform, in spread
// space (`spreadOutline`), or in a page's own coordinates (`pageOutline`) —
// so a spec says what the user would see, not which ops were sent.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { ovalToPath, transformBounds, type Affine } from "@paged-media/draw-geometry";

export type EngineShape = "spread" | "page";
export const SHAPES: readonly EngineShape[] = ["spread", "page"];

type Vec = [number, number];
interface Triple {
  anchor: Vec;
  left: Vec;
  right: Vec;
}
type Box = [number, number, number, number];

export interface FakePage {
  id: string;
  /** The page's top-left in its spread. */
  origin: Vec;
  size: Vec;
}

interface Item {
  id: string;
  kind: "polygon" | "oval" | "rectangle";
  anchors: Triple[];
  starts: number[];
  open: boolean[];
  bounds: Box;
  transform: Affine | null;
}

interface Group {
  id: string;
  transform: Affine | null;
  members: string[];
}

const apply = (m: Affine | null, p: readonly number[]): Vec =>
  m ? [m[0] * p[0]! + m[2] * p[1]! + m[4], m[1] * p[0]! + m[3] * p[1]! + m[5]] : [p[0]!, p[1]!];

const compose = (o: Affine, i: Affine): Affine => [
  o[0] * i[0] + o[2] * i[1],
  o[1] * i[0] + o[3] * i[1],
  o[0] * i[2] + o[2] * i[3],
  o[1] * i[2] + o[3] * i[3],
  o[0] * i[4] + o[2] * i[5] + o[4],
  o[1] * i[4] + o[3] * i[5] + o[5],
];

const bboxOf = (triples: readonly Triple[]): Box => {
  let t = Infinity;
  let l = Infinity;
  let b = -Infinity;
  let r = -Infinity;
  for (const a of triples) {
    for (const p of [a.anchor, a.left, a.right]) {
      l = Math.min(l, p[0]);
      r = Math.max(r, p[0]);
      t = Math.min(t, p[1]);
      b = Math.max(b, p[1]);
    }
  }
  return [t, l, b, r];
};

const triple = (p: Vec): Triple => ({ anchor: [...p], left: [...p], right: [...p] });

/** A pure translation. */
export const T = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
/** A rotation by `deg` about the origin, then a translation. */
export const RT = (deg: number, x: number, y: number): Affine => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), x, y];
};

/** InDesign's facing spread of two 612 × 792 pages, centred on the spine:
 *  the verso at (-612, -396), the recto at (0, -396). */
export const VERSO: FakePage = { id: "pv", origin: [-612, -396], size: [612, 792] };
export const RECTO: FakePage = { id: "pr", origin: [0, -396], size: [612, 792] };

export class FakeEngine {
  readonly items = new Map<string, Item>();
  readonly groups = new Map<string, Group>();
  /** What `requestTextOutlines` answers per frame id (PAGE space, as
   *  core's door does), when a spec sets it. */
  readonly textOutlines = new Map<string, unknown>();
  /** What `planarRegions` answers (RAW space), when a spec sets it. */
  planarFaces: { id: string; signature: number[]; anchors: Triple[]; subpathStarts: number[] }[] | null = null;
  private seq = 0;

  constructor(
    readonly shape: EngineShape,
    readonly pages: readonly FakePage[] = [VERSO, RECTO],
  ) {}

  page(id: string): FakePage {
    const p = this.pages.find((x) => x.id === id);
    if (!p) throw new Error(`no page ${id}`);
    return p;
  }

  /** A path whose inner anchors are `contours` (corners; one contour or
   *  several), placed on `page` by `onPage` (page coordinates) — so it
   *  STORES `translate(origin) ∘ onPage`, the way an InDesign file carries
   *  it. */
  addPath(
    id: string,
    page: FakePage,
    contours: readonly Vec[] | readonly (readonly Vec[])[],
    onPage: Affine,
    open = false,
  ): void {
    const list = (typeof contours[0]![0] === "number" ? [contours] : contours) as readonly (readonly Vec[])[];
    const anchors: Triple[] = [];
    const starts: number[] = [];
    for (const c of list) {
      starts.push(anchors.length);
      anchors.push(...c.map(triple));
    }
    this.items.set(id, {
      id,
      kind: "polygon",
      anchors,
      starts,
      open: list.map(() => open),
      bounds: bboxOf(anchors),
      transform: compose(T(page.origin[0], page.origin[1]), onPage),
    });
  }

  /** An oval: a frame box and no path (core answers no anchors for one). */
  addOval(id: string, page: FakePage, bounds: Box, onPage: Affine): void {
    this.items.set(id, {
      id,
      kind: "oval",
      anchors: [],
      starts: [],
      open: [],
      bounds,
      transform: compose(T(page.origin[0], page.origin[1]), onPage),
    });
  }

  /** A group of existing items with its own stored transform. */
  addGroup(id: string, members: string[], transform: Affine | null = null): void {
    this.groups.set(id, { id, members, transform });
  }

  private groupOf(itemId: string): Group | null {
    for (const g of this.groups.values()) if (g.members.includes(itemId)) return g;
    return null;
  }

  /** An item's effective stored transform (its group's composed in). */
  private effective(item: Item): Affine | null {
    const g = this.groupOf(item.id);
    if (!g?.transform) return item.transform;
    return compose(g.transform, item.transform ?? [1, 0, 0, 1, 0, 0]);
  }

  /** The page holding an item's transformed centroid — core's
   *  `host_page` rule. Null = the pasteboard. */
  hostPage(item: Item): FakePage | null {
    const [t, l, b, r] = transformBounds(item.bounds, this.effective(item) ?? [1, 0, 0, 1, 0, 0]);
    const cx = (l + r) / 2;
    const cy = (t + b) / 2;
    return (
      this.pages.find(
        (p) => cx >= p.origin[0] && cx <= p.origin[0] + p.size[0] && cy >= p.origin[1] && cy <= p.origin[1] + p.size[1],
      ) ?? null
    );
  }

  /** What the geometry doors answer for the transform, in this shape. */
  private readTransform(item: Item): { itemTransform: Affine | null; pageOrigin?: Vec } {
    const stored = this.effective(item);
    const page = this.hostPage(item);
    if (this.shape === "spread" || !page) return { itemTransform: stored };
    const [ox, oy] = page.origin;
    const m = stored ?? [1, 0, 0, 1, 0, 0];
    return {
      itemTransform: ox === 0 && oy === 0 ? stored : [m[0], m[1], m[2], m[3], m[4] - ox, m[5] - oy],
      pageOrigin: [ox, oy],
    };
  }

  elementGeometry(ids: readonly ElementId[]) {
    return ids.flatMap((id) => {
      const item = this.items.get(String(id.id));
      if (!item) return [];
      return [
        {
          id,
          pageId: this.hostPage(item)?.id ?? null,
          spreadId: "s",
          bounds: [...item.bounds] as Box,
          ...this.readTransform(item),
          hasImage: false,
        },
      ];
    });
  }

  pathAnchors(id: ElementId) {
    const item = this.items.get(String(id.id));
    if (!item || item.kind === "oval") return null;
    return {
      id,
      pageId: this.hostPage(item)?.id ?? null,
      spreadId: "s",
      anchors: item.anchors.map((a) => ({ anchor: [...a.anchor], left: [...a.left], right: [...a.right] })),
      subpathStarts: item.starts.length > 1 ? [...item.starts] : [],
      subpathOpen: [...item.open],
      ...this.readTransform(item),
    };
  }

  /** A group answers `frameBounds` (its members' union, SPREAD space) and
   *  `frameTransform` (its own stored matrix) — core's Group arm. */
  elementProperties(id: ElementId) {
    const g = this.groups.get(String(id.id));
    if (!g) return null;
    let box: Box | null = null;
    for (const m of g.members) {
      const item = this.items.get(m)!;
      const b = transformBounds(item.bounds, this.effective(item) ?? [1, 0, 0, 1, 0, 0]);
      box = box
        ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]
        : [b[0], b[1], b[2], b[3]];
    }
    return {
      entries: [
        { path: "frameBounds", value: { type: "bounds", value: box } },
        { path: "frameTransform", value: { type: "transform", value: g.transform } },
      ],
    };
  }

  // ------------------------------------------------------------- writes

  /** Apply a mutation (a batch or one op). Answers what it minted. */
  mutate(m: unknown): { applied: boolean; minted: ElementId[]; error?: string } {
    const minted: ElementId[] = [];
    const handles = new Map<string, string>();
    const resolve = (raw: unknown): string => {
      const s = String(raw);
      if (s.startsWith("$h:")) {
        const id = handles.get(s.slice(3));
        if (!id) throw new Error(`unbound handle ${s}`);
        return id;
      }
      return s;
    };
    const idOf = (e: unknown): string => resolve((e as { id: unknown }).id);
    const one = (op: { op: string; args: Record<string, unknown> }): void => {
      const a = op.args;
      switch (op.op) {
        case "batch":
          for (const child of a.ops as { op: string; args: Record<string, unknown> }[]) one(child);
          return;
        case "insertPath": {
          const [ox, oy] = this.page(String(a.pageId)).origin;
          const shift = (p: number[]): Vec => [p[0]! + ox, p[1]! + oy];
          const anchors = (a.anchors as { anchor: number[]; left: number[]; right: number[] }[]).map((t) => ({
            anchor: shift(t.anchor),
            left: shift(t.left),
            right: shift(t.right),
          }));
          const id = `u${++this.seq}`;
          this.items.set(id, {
            id,
            kind: "polygon",
            anchors,
            starts: [0],
            open: [a.open === true],
            bounds: bboxOf(anchors),
            transform: null,
          });
          minted.push({ kind: "polygon", id } as ElementId);
          return;
        }
        case "bindCreated": {
          const last = minted[minted.length - 1];
          if (!last) throw new Error("bindCreated with nothing created");
          handles.set(String(a.handle), String(last.id));
          return;
        }
        case "setElementProperty": {
          const item = this.items.get(idOf(a.elementId));
          if (!item) {
            if (this.groups.has(idOf(a.elementId))) return;
            throw new Error(`no element ${idOf(a.elementId)}`);
          }
          const v = (a.value as { value: unknown }).value;
          if (a.path === "framePath") {
            const fp = v as { anchors: { anchor: number[]; left: number[]; right: number[] }[]; subpathStarts: number[] };
            item.anchors = fp.anchors.map((t) => ({
              anchor: [t.anchor[0]!, t.anchor[1]!],
              left: [t.left[0]!, t.left[1]!],
              right: [t.right[0]!, t.right[1]!],
            }));
            item.starts = fp.subpathStarts.length > 0 ? [...fp.subpathStarts] : [0];
          } else if (a.path === "frameBounds") {
            item.bounds = [...(v as Box)] as Box;
          } else if (a.path === "frameTransform") {
            item.transform = v ? ([...(v as number[])] as unknown as Affine) : null;
          }
          return;
        }
        case "setGroupTransform": {
          const g = this.groups.get(String(a.groupId));
          if (!g) throw new Error(`no group ${String(a.groupId)}`);
          g.transform = [...(a.transform as number[])] as unknown as Affine;
          return;
        }
        case "deleteFrame":
          this.items.delete(resolve(a.frameId));
          return;
        case "createGroup": {
          const id = `g${++this.seq}`;
          this.groups.set(id, { id, transform: null, members: (a.memberIds as unknown[]).map(idOf) });
          minted.push({ kind: "group", id } as ElementId);
          return;
        }
        case "dissolveGroup":
          this.groups.delete(resolve(a.groupId));
          return;
        default:
          // Paint, metadata, swatches: nothing here is about where an item is.
          return;
      }
    };
    try {
      one(m as { op: string; args: Record<string, unknown> });
      return { applied: true, minted };
    } catch (e) {
      return { applied: false, minted: [], error: String(e) };
    }
  }

  // --------------------------------------------------------- assertions

  /** Every contour of `id`, through its stored transform: SPREAD space. An
   *  oval answers its κ ellipse (the renderer's curve). */
  spreadOutline(id: string): Vec[][] {
    const item = this.items.get(id);
    if (!item) throw new Error(`no element ${id}`);
    const m = this.effective(item);
    if (item.kind === "oval") return [ovalToPath(item.bounds).anchors.map((a) => apply(m, a.anchor))];
    const starts = item.starts.length > 0 ? item.starts : [0];
    return starts.map((s, i) => item.anchors.slice(s, starts[i + 1] ?? item.anchors.length).map((a) => apply(m, a.anchor)));
  }

  /** `spreadOutline` in `page`'s own coordinates. */
  pageOutline(id: string, page: FakePage): Vec[][] {
    return this.spreadOutline(id).map((c) => c.map(([x, y]) => [x - page.origin[0], y - page.origin[1]] as Vec));
  }

  /** The stored transform (what `frameTransform` reads). */
  storedTransform(id: string): Affine | null {
    return this.items.get(id)?.transform ?? null;
  }
}

/** The smallest host the commands under test reach: the geometry reads,
 *  `mutate`, the pages collection, a settable selection and a log. */
export function fakeHost(engine: FakeEngine, selection: ElementId[] = []): BundleHost {
  let sel = [...selection];
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return {
    log,
    supports: () => false,
    bindings: { publish: () => {} },
    // The raw read hatch, for the one door these specs need through it.
    editor: {
      client: {
        send: async (req: { kind: string; payload?: { id?: ElementId } }) => {
          const hit = req.kind === "requestTextOutlines" ? engine.textOutlines.get(String(req.payload?.id?.id)) : undefined;
          return hit ? { kind: "textOutlines", payload: { result: hit } } : { kind: "error", payload: null };
        },
      },
    },
    selection: {
      get: () => [...sel],
      set: async (ids: ElementId[]) => {
        sel = [...ids];
      },
      onDidChange: () => ({ dispose() {} }),
    },
    document: {
      elementGeometry: async (ids: ElementId[]) => engine.elementGeometry(ids),
      pathAnchors: async (id: ElementId) => engine.pathAnchors(id),
      elementProperties: async (id: ElementId) => engine.elementProperties(id),
      collection: async (name: string) =>
        name === "pages" ? engine.pages.map((p) => ({ selfId: p.id, sizePt: [...p.size] })) : [],
      planarRegions: async () =>
        engine.planarFaces
          ? { found: true, complete: true, faces: engine.planarFaces }
          : { found: false, complete: false, faces: [], reason: "no arrangement in this spec" },
      mutate: async (m: unknown) => {
        const out = engine.mutate(m);
        return out.applied
          ? { applied: true, minted: out.minted.map((element) => ({ element, handle: null })) }
          : { applied: false, error: out.error };
      },
    },
  } as unknown as BundleHost;
}

/** `expect`-free closeness of two contour lists, for a readable message. */
export function outlineDelta(got: readonly Vec[][], want: readonly Vec[][]): number {
  if (got.length !== want.length) return Infinity;
  let worst = 0;
  got.forEach((c, i) => {
    if (c.length !== want[i]!.length) worst = Infinity;
    c.forEach((p, j) => {
      const q = want[i]![j]!;
      worst = Math.max(worst, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
    });
  });
  return worst;
}
