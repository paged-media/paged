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

// THE PERSPECTIVE GRID — the grid store, its overlay layer, the artwork
// link, and the commands (View ▸ Perspective grid, Object ▸ Perspective).
//
// THE GRID IS PER PAGE and lives in the EIGHTH `.paged` container part,
// `perspective-grid.json` (`{ v: 1, grids: { <pageId>: PerspectiveGrid } }`),
// through the recipe store's COMMAND lane (`recipe-store.ts`): a grid edit
// is a view setting, not artwork, so — like Illustrator, where moving a
// vanishing point is not an undoable document change — it stays OFF the
// undo stack. A host with no container writer keeps the grids for the
// session only, and says so once.
//
// THE GRID IS DRAWN in a RETAINED overlay layer of this bundle
// (`host.overlay.layer`), so it stays on the canvas whatever tool is
// active, exactly while the grid is VISIBLE: the active plane's lines
// solid, the other planes' dashed, the horizon dashed across the page.
// The handles and the plane widget are drawn by the two perspective
// tools, in the tool-preview slot, while one of them is active.
//
// ARTWORK ON A PLANE carries a link on its own metadata envelope (key
// `perspective`): the plane, the page and the FLAT geometry — the
// artwork in the plane's object frame. Moving it along the plane
// re-projects the flat geometry, so a hundred moves are as exact as one;
// Release drops the link and leaves the projected geometry. Every
// artwork write (attach, move, draw, release) is ONE batch: the geometry
// and the link together, one undo step.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  MutationInput,
  PluginMetadataEnvelope,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import {
  attachToPlane,
  defaultGrid,
  flatEllipse,
  flatRect,
  moveOnPlane,
  pageToPlane,
  parseGrid,
  planeGridLines,
  planeQuad,
  projectOntoPlane,
  tableBounds,
  PLANE_IDS,
  type AnchorTable,
  type GridKind,
  type PerspectiveGrid,
  type PlaneId,
} from "@paged-media/draw-geometry";
import { defineMessages } from "@paged-media/strings";

import { registerCommand } from "../command-registry";
import { announceRecipeChange } from "../link-index";
import { readRecipeBytes, writeRecipeBytes } from "../recipe-store";
import { resolveTargetPage } from "../io/svg";
import {
  graphicPaintFor,
  graphicPaintOps,
  type GraphicPaint,
} from "../handlers/graphic-default";
import { insertPathMutationFor } from "../handlers/insert-path";
import { polyShape } from "../handlers/preview-shapes";
import { stampDrawMetadata } from "./appearance-bake";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "./batch-handles";
import {
  failed,
  payloadOf,
  pointOf,
  readDistortTargets,
  rewriteFromPage,
  type DistortTarget,
  type Pt,
} from "./distort-shared";
import { EDITABLE_PATH_KINDS } from "./path-rewrite";

const M = defineMessages("draw.perspective", {
  show: "Show the perspective grid",
  hide: "Hide the perspective grid",
  lock: "Lock the perspective grid",
  unlock: "Unlock the perspective grid",
  onePoint: "One-point perspective grid",
  twoPoint: "Two-point perspective grid",
  threePoint: "Three-point perspective grid",
  setPlane: "Set the active perspective plane",
  attach: "Attach the selection to the active plane",
  release: "Release the selection from perspective",
  move: "Move the selection along its perspective plane",
  draw: "Draw a shape on the active perspective plane",
});

const C = "media.paged.draw.command";
export const PERSPECTIVE_COMMAND = {
  show: `${C}.perspectiveShowGrid`,
  hide: `${C}.perspectiveHideGrid`,
  lock: `${C}.perspectiveLockGrid`,
  unlock: `${C}.perspectiveUnlockGrid`,
  onePoint: `${C}.perspectiveOnePoint`,
  twoPoint: `${C}.perspectiveTwoPoint`,
  threePoint: `${C}.perspectiveThreePoint`,
  setPlane: `${C}.perspectiveSetPlane`,
  attach: `${C}.attachToPerspective`,
  release: `${C}.releaseFromPerspective`,
  move: `${C}.moveOnPerspective`,
  draw: `${C}.drawOnPerspective`,
} as const;
export const PERSPECTIVE_COMMAND_IDS = Object.values(PERSPECTIVE_COMMAND);

export const PERSPECTIVE_PART = "perspective-grid.json";
export const PERSPECTIVE_FEATURE = "storage.parts@1";
export const PERSPECTIVE_LAYER_ID = "perspective-grid";

// ------------------------------------------------------------ the store

export interface PerspectiveLibrary {
  v: 1;
  grids: Record<string, PerspectiveGrid>;
}

const empty = (): PerspectiveLibrary => ({ v: 1, grids: {} });

/** Parse the part (tolerant: a damaged grid is dropped, not fatal). */
export function parsePerspectiveLibrary(
  bytes: Uint8Array | null,
): PerspectiveLibrary {
  if (!bytes || bytes.byteLength === 0) return empty();
  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as {
      grids?: Record<string, unknown>;
    };
    const out = empty();
    for (const [page, g] of Object.entries(raw.grids ?? {})) {
      const grid = parseGrid(g);
      if (grid) out.grids[page] = grid;
    }
    return out;
  } catch {
    return empty();
  }
}

export const serializePerspectiveLibrary = (
  lib: PerspectiveLibrary,
): Uint8Array => new TextEncoder().encode(JSON.stringify(lib));

/** The session copy for hosts with no container writer. */
const sessionLibraries = new WeakMap<object, PerspectiveLibrary>();
const warned = new WeakSet<object>();

export async function readPerspectiveLibrary(
  host: BundleHost,
): Promise<PerspectiveLibrary> {
  if (!host.supports(PERSPECTIVE_FEATURE))
    return sessionLibraries.get(host) ?? empty();
  try {
    return parsePerspectiveLibrary(
      await readRecipeBytes(host, PERSPECTIVE_PART),
    );
  } catch (e) {
    host.log.warn(`perspective grid: read failed (${String(e)})`);
    return empty();
  }
}

export async function writePerspectiveLibrary(
  host: BundleHost,
  lib: PerspectiveLibrary,
): Promise<void> {
  if (!host.supports(PERSPECTIVE_FEATURE)) {
    sessionLibraries.set(host, lib);
    if (!warned.has(host)) {
      warned.add(host);
      host.log.warn(
        `perspective grid: this host wires no \`.paged\` container writer (supports("${PERSPECTIVE_FEATURE}") is false) — the grids last for this session only`,
      );
    }
  } else {
    try {
      await writeRecipeBytes(
        host,
        PERSPECTIVE_PART,
        serializePerspectiveLibrary(lib),
      );
      announceRecipeChange(host);
    } catch (e) {
      host.log.warn(`perspective grid: write failed (${String(e)})`);
    }
  }
  await renderPerspectiveLayer(host, lib);
}

/** A page's size (pt) from the `pages` collection; Letter when unknown. */
async function pageSize(
  host: BundleHost,
  pageId: string,
): Promise<[number, number]> {
  try {
    const pages = await host.document.collection<{
      selfId?: string;
      sizePt?: [number, number];
    }>("pages");
    const row = pages.find((p) => p?.selfId === pageId);
    if (row?.sizePt && row.sizePt[0] > 0 && row.sizePt[1] > 0)
      return [row.sizePt[0], row.sizePt[1]];
  } catch {
    /* fall through */
  }
  return [612, 792];
}

/** The page's grid; with `create`, a default two-point grid when it has
 *  none (written). */
export async function gridFor(
  host: BundleHost,
  pageId: string,
  create = false,
): Promise<PerspectiveGrid | null> {
  const lib = await readPerspectiveLibrary(host);
  const g = lib.grids[pageId];
  if (g || !create) return g ?? null;
  const [w, h] = await pageSize(host, pageId);
  const grid = defaultGrid(2, w, h);
  lib.grids[pageId] = grid;
  await writePerspectiveLibrary(host, lib);
  return grid;
}

/** Replace the page's grid. */
export async function saveGrid(
  host: BundleHost,
  pageId: string,
  grid: PerspectiveGrid,
): Promise<void> {
  const lib = await readPerspectiveLibrary(host);
  lib.grids[pageId] = grid;
  await writePerspectiveLibrary(host, lib);
}

// ------------------------------------------------------------ the layer

const layers = new WeakMap<
  object,
  ReturnType<BundleHost["overlay"]["layer"]>
>();

/** The shapes that draw one page's grid (pure). */
export function perspectiveGridShapes(
  pageId: string,
  grid: PerspectiveGrid,
  pageWidth = 612,
): ToolPreviewShape[] {
  if (!grid.visible) return [];
  const out: ToolPreviewShape[] = [];
  const x0 = Math.min(0, grid.vpLeft, grid.vpCenter, grid.origin[0]) - 20;
  const x1 =
    Math.max(pageWidth, grid.vpRight, grid.vpCenter, grid.origin[0]) + 20;
  out.push(
    polyShape(
      pageId,
      [
        [x0, grid.horizonY],
        [x1, grid.horizonY],
      ],
      { dashed: true },
    ),
  );
  for (const plane of PLANE_IDS) {
    const active = grid.activePlane === plane;
    for (const [a, b] of planeGridLines(grid, plane))
      out.push(polyShape(pageId, [a!, b!], { dashed: !active }));
    const quad = planeQuad(grid, plane);
    if (quad)
      out.push(polyShape(pageId, quad, { close: true, dashed: !active }));
  }
  return out;
}

/** Draw every visible grid in the bundle's retained layer. */
export async function renderPerspectiveLayer(
  host: BundleHost,
  lib?: PerspectiveLibrary,
): Promise<void> {
  const library = lib ?? (await readPerspectiveLibrary(host));
  let layer = layers.get(host);
  if (!layer) {
    try {
      layer = host.overlay.layer(PERSPECTIVE_LAYER_ID);
      layers.set(host, layer);
    } catch {
      return;
    }
  }
  const shapes: ToolPreviewShape[] = [];
  for (const [page, grid] of Object.entries(library.grids)) {
    const [w] = grid.visible ? await pageSize(host, page) : [612];
    shapes.push(...perspectiveGridShapes(page, grid, w));
  }
  layer.set(shapes);
}

/** Draw the stored grids now and whenever a document is opened (each
 *  brings its own grids). Not on every edit: the grid only changes
 *  through this bundle's own writes, which redraw it themselves — and a
 *  part read per document change would tax every other command. */
export function installPerspectiveLayer(host: BundleHost): Disposable {
  const redraw = () => void renderPerspectiveLayer(host).catch(() => {});
  redraw();
  let sub: Disposable | null = null;
  try {
    sub = host.document.onDidOpen(redraw);
  } catch {
    sub = null;
  }
  return {
    dispose() {
      sub?.dispose();
      const layer = layers.get(host);
      layer?.dispose();
      layers.delete(host);
    },
  };
}

// ------------------------------------------------------- the artwork link

export interface PerspectiveLink {
  plane: PlaneId;
  page: string;
  flat: AnchorTable;
}

export function perspectiveLinkOf(
  env: PluginMetadataEnvelope | null,
): PerspectiveLink | null {
  const raw = (env?.data as { perspective?: unknown } | undefined)?.perspective;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PerspectiveLink>;
  if (!r.plane || !PLANE_IDS.includes(r.plane) || typeof r.page !== "string")
    return null;
  const f = r.flat as AnchorTable | undefined;
  if (!f || !Array.isArray(f.anchors) || !Array.isArray(f.subpathStarts))
    return null;
  return { plane: r.plane, page: r.page, flat: f };
}

/** Merge (or, with null, drop) the perspective link, keeping every other
 *  draw key. Pure. */
export function withPerspectiveLink(
  prev: PluginMetadataEnvelope | null,
  link: PerspectiveLink | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (link === null) {
    delete data.perspective;
    if (Object.keys(data).length === 0) return null;
  } else data.perspective = link;
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

export async function readPerspectiveLink(
  host: BundleHost,
  id: ElementId,
): Promise<{
  link: PerspectiveLink | null;
  envelope: PluginMetadataEnvelope | null;
}> {
  const envelope = await host.document.getMetadata(id).catch(() => null);
  return { link: perspectiveLinkOf(envelope), envelope };
}

// ---------------------------------------------------- artwork writes

/** Write projected geometry and its link onto existing artwork — one
 *  batch for all of them. */
export async function writeOnPlane(
  host: BundleHost,
  label: string,
  edits: readonly {
    target: Pick<DistortTarget, "id" | "matrix">;
    page: AnchorTable;
    link: PerspectiveLink;
    envelope: PluginMetadataEnvelope | null;
  }[],
): Promise<boolean> {
  const ops: MutationInput[] = [];
  for (const e of edits) {
    const rw = rewriteFromPage(e.target, e.page);
    if (!rw) continue;
    ops.push(
      ...rw,
      stampDrawMetadata(e.target.id, withPerspectiveLink(e.envelope, e.link)),
    );
  }
  if (ops.length === 0) return false;
  const outcome = await host.document.mutate(
    batchMutationFor(ops as Mutation[]),
  );
  if (!outcome.applied)
    host.log.warn(
      `${label}: the engine refused: ${JSON.stringify(outcome.error)}`,
    );
  return outcome.applied;
}

/** Insert a shape drawn on a plane — path, paint, link: one batch.
 *  Answers the new id. */
export async function insertOnPlane(
  host: BundleHost,
  pageId: string,
  page: AnchorTable,
  link: PerspectiveLink,
): Promise<ElementId | null> {
  const paint: GraphicPaint | null = await graphicPaintFor(host).catch(
    () => null,
  );
  const handle = "perspective-shape";
  const id = handleElementId(handle);
  const ops: MutationInput[] = [
    insertPathMutationFor(pageId, page.anchors, false),
  ];
  if (paint) ops.push(...graphicPaintOps("insertPath", paint));
  ops.push(
    bindCreatedMutationFor(handle),
    stampDrawMetadata(id, withPerspectiveLink(null, link)),
  );
  const outcome = await host.document.mutate(
    batchMutationFor(ops as Mutation[]),
  );
  if (!outcome.applied) {
    host.log.warn(
      `perspective draw: the engine refused: ${JSON.stringify(outcome.error)}`,
    );
    return null;
  }
  const created = outcome.createdId ?? null;
  if (created) await host.selection.set([created]);
  return created;
}

// ------------------------------------------------------------ commands

async function pageOfPayload(
  host: BundleHost,
  p: Record<string, unknown>,
): Promise<string> {
  if (typeof p.page === "string" && p.page !== "") return p.page;
  const [first] = host.selection.get();
  if (first) {
    const read = await host.document.pathAnchors(first).catch(() => null);
    if (read?.pageId) return read.pageId;
  }
  let active: string | null = null;
  try {
    active = host.viewport.activePage();
  } catch {
    active = null;
  }
  return (
    active ??
    (await resolveTargetPage(host)) ??
    failed("the document has no page")
  );
}

async function editGrid(
  host: BundleHost,
  payload: unknown,
  edit: (g: PerspectiveGrid, size: [number, number]) => PerspectiveGrid,
): Promise<{ page: string; grid: PerspectiveGrid }> {
  const page = await pageOfPayload(host, payloadOf(payload));
  const lib = await readPerspectiveLibrary(host);
  const size = await pageSize(host, page);
  const grid = edit(lib.grids[page] ?? defaultGrid(2, size[0], size[1]), size);
  lib.grids[page] = grid;
  await writePerspectiveLibrary(host, lib);
  return { page, grid };
}

const presetOf =
  (kind: GridKind) => (g: PerspectiveGrid, size: [number, number]) => ({
    ...defaultGrid(kind, size[0], size[1]),
    activePlane: g.activePlane,
    locked: false,
    visible: true,
  });

const asPlane = (v: unknown): PlaneId | "none" =>
  v === "left" || v === "right" || v === "floor" || v === "none"
    ? v
    : failed("plane is left, right, floor or none");

/** The active plane of the page's grid, or a refusal. */
async function activePlaneOf(
  host: BundleHost,
  page: string,
): Promise<{ grid: PerspectiveGrid; plane: PlaneId }> {
  const grid =
    (await gridFor(host, page)) ??
    failed("the page has no perspective grid — show it first");
  if (grid.activePlane === "none")
    failed("no plane is active — pick one with the plane widget or keys 1–3");
  return { grid, plane: grid.activePlane as PlaneId };
}

/** The selection's editable paths, read. */
async function selectedPaths(host: BundleHost): Promise<DistortTarget[]> {
  const ids = host.selection
    .get()
    .filter((i) => EDITABLE_PATH_KINDS.has(i.kind));
  if (ids.length === 0) failed("select the paths");
  return readDistortTargets(host, ids);
}

export async function runAttachToPerspective(
  host: BundleHost,
  payload: unknown,
) {
  const targets = await selectedPaths(host);
  const page =
    targets[0]?.pageId ?? (await pageOfPayload(host, payloadOf(payload)));
  const { grid, plane } = await activePlaneOf(host, page);
  const edits = [];
  for (const t of targets) {
    if (t.pageId !== page) continue;
    const box = tableBounds(t.page);
    if (!box) continue;
    // Bounds are [top, left, bottom, right]: attach in place, the
    // artwork's centre staying where it is.
    const centre: Pt = [(box[1] + box[3]) / 2, (box[0] + box[2]) / 2];
    const r = attachToPlane(grid, plane, t.page, centre, centre);
    if (!r) continue;
    const { envelope } = await readPerspectiveLink(host, t.id);
    edits.push({
      target: t,
      page: r.page,
      link: { plane, page, flat: r.flat },
      envelope,
    });
  }
  if (edits.length === 0) failed("nothing could be put on the plane");
  if (!(await writeOnPlane(host, "attach to perspective", edits)))
    failed("the engine refused the attach");
  return { attached: edits.length, plane };
}

export async function runReleaseFromPerspective(host: BundleHost) {
  const ids = host.selection.get();
  const ops: MutationInput[] = [];
  for (const id of ids) {
    const { link, envelope } = await readPerspectiveLink(host, id);
    if (link)
      ops.push(stampDrawMetadata(id, withPerspectiveLink(envelope, null)));
  }
  if (ops.length === 0) return { released: 0 };
  const outcome = await host.document.mutate(
    batchMutationFor(ops as Mutation[]),
  );
  if (!outcome.applied)
    failed(`the engine refused: ${JSON.stringify(outcome.error)}`);
  return { released: ops.length };
}

export async function runMoveOnPerspective(host: BundleHost, payload: unknown) {
  const p = payloadOf(payload);
  const from = pointOf(p.from) ?? failed("a move needs from");
  const to = pointOf(p.to) ?? failed("a move needs to");
  const targets = await selectedPaths(host);
  const edits = [];
  for (const t of targets) {
    const { link, envelope } = await readPerspectiveLink(host, t.id);
    if (!link) continue;
    const grid = await gridFor(host, link.page);
    if (!grid) continue;
    const r = moveOnPlane(grid, link.plane, link.flat, from, to);
    if (!r) continue;
    edits.push({
      target: t,
      page: r.page,
      link: { ...link, flat: r.flat },
      envelope,
    });
  }
  if (edits.length === 0)
    failed("the selection holds nothing attached to a plane");
  if (!(await writeOnPlane(host, "move on perspective", edits)))
    failed("the engine refused the move");
  return { moved: edits.length };
}

export async function runDrawOnPerspective(host: BundleHost, payload: unknown) {
  const p = payloadOf(payload);
  const page = await pageOfPayload(host, p);
  const from = pointOf(p.from) ?? failed("a shape needs from");
  const to = pointOf(p.to) ?? failed("a shape needs to");
  const shape =
    p.shape === "ellipse"
      ? "ellipse"
      : p.shape === "rectangle"
        ? "rectangle"
        : failed("shape is rectangle or ellipse");
  const { grid, plane } = await activePlaneOf(host, page);
  const a = pageToPlane(grid, plane, from);
  const b = pageToPlane(grid, plane, to);
  if (!a || !b || a[0] === b[0] || a[1] === b[1])
    failed("the drag spans no area on the plane");
  const flat = shape === "rectangle" ? flatRect(a!, b!) : flatEllipse(a!, b!);
  const projected =
    projectOntoPlane(grid, plane, flat) ?? failed("the shape leaves the plane");
  const id = await insertOnPlane(host, page, projected, { plane, page, flat });
  if (!id) failed("the engine refused the shape");
  return { plane };
}

export function contributePerspectiveCommands(host: BundleHost): Disposable {
  const quiet =
    <T>(id: string, run: (payload: unknown) => Promise<T>) =>
    async (_paged: unknown, payload: unknown): Promise<T | null> => {
      if (payload !== undefined) return run(payload);
      try {
        return await run(payload);
      } catch (e) {
        host.log.info(`${id}: ${String(e)}`);
        return null;
      }
    };
  const P = PERSPECTIVE_COMMAND;
  const reg = (
    id: string,
    title: string,
    run: (payload: unknown) => Promise<unknown>,
  ) =>
    registerCommand(host, {
      id,
      title,
      category: "Perspective",
      handler: quiet(id, run),
    });
  const subs = [
    reg(P.show, M.show, (x) =>
      editGrid(host, x, (g) => ({ ...g, visible: true })).then((r) => ({
        page: r.page,
        visible: true,
      })),
    ),
    reg(P.hide, M.hide, (x) =>
      editGrid(host, x, (g) => ({ ...g, visible: false })).then((r) => ({
        page: r.page,
        visible: false,
      })),
    ),
    reg(P.lock, M.lock, (x) =>
      editGrid(host, x, (g) => ({ ...g, locked: true })).then((r) => ({
        page: r.page,
        locked: true,
      })),
    ),
    reg(P.unlock, M.unlock, (x) =>
      editGrid(host, x, (g) => ({ ...g, locked: false })).then((r) => ({
        page: r.page,
        locked: false,
      })),
    ),
    reg(P.onePoint, M.onePoint, (x) =>
      editGrid(host, x, presetOf(1)).then((r) => ({ page: r.page, kind: 1 })),
    ),
    reg(P.twoPoint, M.twoPoint, (x) =>
      editGrid(host, x, presetOf(2)).then((r) => ({ page: r.page, kind: 2 })),
    ),
    reg(P.threePoint, M.threePoint, (x) =>
      editGrid(host, x, presetOf(3)).then((r) => ({ page: r.page, kind: 3 })),
    ),
    reg(P.setPlane, M.setPlane, (x) => {
      const plane = asPlane(payloadOf(x).plane);
      return editGrid(host, x, (g) => ({ ...g, activePlane: plane })).then(
        (r) => ({ page: r.page, plane }),
      );
    }),
    reg(P.attach, M.attach, (x) => runAttachToPerspective(host, x)),
    reg(P.release, M.release, () => runReleaseFromPerspective(host)),
    reg(P.move, M.move, (x) => runMoveOnPerspective(host, x)),
    reg(P.draw, M.draw, (x) => runDrawOnPerspective(host, x)),
  ];
  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
