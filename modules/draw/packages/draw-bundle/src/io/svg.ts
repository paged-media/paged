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

// Phase 8 — paged.draw SVG interchange (the K-2 importer + exporter).
//
// The IMPORTER claims `.svg`: it parses the document (draw-geometry's
// host-free reader → flattened shapes with style), then lowers each shape
// through the SAME `insertPath` lane the pen/pencil tools use — one path
// per contour, with a fill/stroke swatch created + assigned when the shape
// carries a solid colour. No new platform door: it rides
// `host.document.mutate` only.
//
// ONE FILE IS ONE BATCH — one document rebuild and one undo step, however
// many shapes it holds. It used to be a loop of awaited single mutations:
// a swatch per colour PER SHAPE, a creation-defaults swap per shape and an
// insert per contour, each one a full rebuild and (swatches and inserts)
// its own undo step. Measured on a 50-shape file into a 500-shape
// document: 201 mutations and 150 undo steps. Now: 1 and 1.
//
// THE BATCH, per contour and in this order — every rule MEASURED against
// the booted engine (protocol 64), because each is a way to get it wrong:
//
//   createSwatch        once per DISTINCT colour of the file, with a
//                       client-chosen id a LATER child may point at;
//   insertPath          the contour;
//   bindCreated         names what that insert minted — its OWN op, and
//                       AFTER its creating child (the C-15 rules,
//                       `commands/v59-wire.ts`);
//   setElementProperty  ×3 on `"$h:<handle>"` — fill, stroke, weight.
//
// WHY THE PAINT IS WRITTEN ON THE HANDLE and not, as before, inherited
// from the document's creation defaults. `setDocumentDefaults` IS
// batchable now (RFI C-15 once said it was not), and a batch of
// `[defaults, insert, defaults, insert, …, restore]` lands the same paint.
// It was built first and thrown away, because of what that one child does
// to the batch: document defaults are app state with no operation form,
// so a batch carrying one takes the engine's PER-CHILD lane, where every
// child holds its own undo-log record until the batch collapses them —
// and the log's 10 000-entry cap is enforced per push, mid-batch.
// Measured:
//   · a 3 000-shape file (12 001 children): ONE undo leaves 500 shapes
//     and 1 001 swatches in the document that no further undo removes;
//   · a session whose undo log is already full: a five-child batch is
//     FIVE undo steps, with the user's creation defaults flipped in
//     between.
// A batch of only `createSwatch` / `insertPath` / `bindCreated` /
// `setElementProperty` children is ONE log entry at any size and any
// history depth (measured at 140 000 children, and against a full log).
// So the importer no longer touches the creation defaults at all — which
// also means there is nothing to restore.
//
// NO CHUNKING, and that is measured too. One batch of 20 000 contours
// (140 000 children) applies in 5.2 s; the same file as 40 batches of 500
// takes 7.9 s and 40 presses of undo. Splitting buys a rebuild per chunk
// and no time back. For scale: 3 000 shapes land in 0.3 s (the loop took
// 20.7 s), and the largest of the 476 real SVGs in the corpus is 1 261
// contours.
//
// TWO things the batch changed on purpose:
//   · swatches are per DISTINCT colour of the file, not per shape — a
//     hundred icons in one blue make one swatch, not a hundred;
//   · File ▸ Open no longer learns the ids it inserted, which it never
//     used. `importSvg` still answers them, and says what that costs.
// Everything else that lands in the document is identical to what the
// loop produced — compared element by element (geometry, every property,
// z-order) over all 457 corpus files that yield shapes.
//
// A REFUSAL IS BISECTED, NOT SWALLOWED. The old loop skipped a rejected
// mutation and kept going; an atomic batch would instead lose the whole
// file to one bad contour (the measured case: a non-finite coordinate,
// which the engine refuses as a malformed MESSAGE). So a refused batch is
// halved and retried until the refusing contour stands alone, and only
// that contour is warned and left out. The price is paid by the broken
// file alone: every half that applies is its own undo step.
//
// The EXPORTER claims `.svg`: it reads the selected shapes' geometry
// (`pathAnchors`, with the element transform applied so the exported
// coordinates match the visual layout) + fill/stroke (`elementProperties`
// → a colour ref resolved against the swatch collection by NAME), and
// serializes an `<svg>` document.
//
// HONEST DEFERRALS (documented, asserted by tests where they bite):
//   · Gradient / pattern / spot fills export as their first solid
//     approximation or are omitted — the SVG lane is sRGB-solid.
//   · A colour ref whose swatch name isn't itself a parseable CSS colour
//     (the convention the importer writes — name = the hex) can't be
//     resolved through the narrow facade, so it falls back (fill →
//     `#000000`, stroke → omitted). Engine-native swatches with opaque
//     ids degrade rather than throw.
//   · Text / images / clip-paths are not draw vector content → not in
//     scope for a vector-plugin importer.

import type {
  BundleHost,
  Disposable,
  ElementId,
  ImportRequest,
  ExportResult,
  Mutation,
  MutationInput,
  MutationOutcome,
} from "@paged-media/plugin-api";
import {
  parseSvgDocument,
  serializeSvgDocument,
  applyAffine,
  parseCssColor,
  rgbToHex,
  type DrawShape,
  type SvgStyle,
  type AnchorTable,
  type AnchorTriple,
  type Affine,
} from "@paged-media/draw-geometry";

import { mintedLeaves, mutateMinting } from "../commands/minted";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "../commands/v59-wire";

export const SVG_IMPORTER_ID = "media.paged.draw.importer.svg";
export const SVG_EXPORTER_ID = "media.paged.draw.exporter.svg";
export const SVG_MIME = "image/svg+xml";

// ---------------------------------------------------------- importer

/** Decode SVG bytes (UTF-8, BOM-stripped) and parse into draw shapes.
 *  Pure — exported so the conformance spec asserts the EXACT shapes the
 *  importer lowers (no second copy to drift from). */
export function shapesFromSvgBytes(bytes: Uint8Array): DrawShape[] {
  const text = decodeUtf8(bytes);
  const doc = parseSvgDocument(text);
  return doc ? doc.shapes : [];
}

function decodeUtf8(bytes: Uint8Array): string {
  // Strip a UTF-8 BOM if present.
  const view =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  return new TextDecoder("utf-8").decode(view);
}

/** A unique-enough swatch id nonce (the fill-gradient precedent — a
 *  per-call counter folded into a hex stamp so repeat imports don't
 *  collide). */
let swatchSeq = 0;
function mintSwatchId(): string {
  const n = `${Date.now().toString(16)}${(swatchSeq++).toString(16)}`;
  return `Color/udrawsvg${n}`;
}

/** The `insertPath` mutation for one shape's geometry (the EXACT shape
 *  the pen/pencil commit emits, compound-aware). A multi-subpath shape
 *  is split into one insertPath per contour — the engine's insertPath
 *  takes a single open/closed flag, so compound paths lower as a group
 *  of contours. Exported for the conformance spec. */
export function insertPathMutationsForShape(
  pageId: string,
  table: AnchorTable,
): Mutation[] {
  const starts = table.subpathStarts.length ? table.subpathStarts : [0];
  const open = table.subpathOpen ?? [];
  const out: Mutation[] = [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : table.anchors.length;
    if (end <= begin) continue;
    const anchors = table.anchors.slice(begin, end).map((a) => ({
      anchor: [a.anchor[0], a.anchor[1]] as [number, number],
      left: [a.left[0], a.left[1]] as [number, number],
      right: [a.right[0], a.right[1]] as [number, number],
    }));
    out.push({
      op: "insertPath",
      args: { pageId, anchors, open: open[s] ?? false },
    });
  }
  return out;
}

/** The paint one shape resolves to — fill / stroke swatch refs and a
 *  stroke weight. `null` = the SVG names none. (The name is the lane this
 *  used to travel by: the document's creation defaults.) */
export interface ShapeDefaults {
  fillColor?: string | null;
  strokeColor?: string | null;
  strokeWeight?: number | null;
}

/** The swatches of one import, keyed by the hex they are NAMED with: a
 *  colour the file has already created a swatch for is pointed at again,
 *  not created again. */
export type SvgSwatchPalette = Map<string, string>;

/** The swatch-create mutations + the resolved paint for one shape's
 *  style. The swatches are NAMED with their hex so the exporter resolves
 *  the refs back.
 *
 *  With a `palette`, a colour it already holds emits NO `createSwatch`
 *  and resolves to the id recorded there; a new colour is created and
 *  recorded. Without one, every call mints its own swatches (what a
 *  caller styling a single shape wants).
 *
 *  Pure — exported for the conformance spec. */
export function styleDefaultsForShape(
  style: SvgStyle,
  palette?: SvgSwatchPalette,
): {
  swatches: Mutation[];
  defaults: ShapeDefaults;
} {
  const swatches: Mutation[] = [];
  const defaults: ShapeDefaults = {};
  const swatchFor = (rgb: readonly [number, number, number]): string => {
    const hex = rgbToHex(rgb);
    const known = palette?.get(hex);
    if (known !== undefined) return known;
    const id = mintSwatchId();
    swatches.push(createRgbSwatch(id, rgb));
    palette?.set(hex, id);
    return id;
  };

  // Fill: a solid colour → a swatch ref; `none` → no fill.
  if (style.fill === null) {
    defaults.fillColor = null;
  } else if (style.fill !== undefined) {
    const rgb = parseCssColor(style.fill);
    if (rgb) {
      defaults.fillColor = swatchFor(rgb);
    } else {
      defaults.fillColor = null;
    }
  } else {
    // No fill declared: SVG paints fill black by default. Keep that
    // explicit so an exported re-import matches.
    defaults.fillColor = null;
  }

  // Stroke.
  if (style.stroke !== undefined && style.stroke !== null) {
    const rgb = parseCssColor(style.stroke);
    if (rgb) {
      defaults.strokeColor = swatchFor(rgb);
    } else {
      defaults.strokeColor = null;
    }
  } else {
    defaults.strokeColor = null;
  }
  defaults.strokeWeight =
    style.strokeWidth !== undefined && style.strokeWidth > 0
      ? style.strokeWidth
      : null;
  return { swatches, defaults };
}

function createRgbSwatch(
  selfId: string,
  rgb: readonly [number, number, number],
): Mutation {
  return {
    op: "createSwatch",
    args: {
      spec: {
        selfId,
        // Name = the hex so the exporter resolves the ref by name.
        name: rgbToHex(rgb),
        space: "RGB",
        value: [rgb[0], rgb[1], rgb[2]],
      },
    },
  };
}

/**
 * The stroke a shape gets when its SVG names NONE — and read this before
 * "fixing" it. It is the engine's own creation fallback: `insertPath`
 * gives a path the document's creation defaults and, where those name no
 * stroke, a 1 pt `Color/Black` one (the pen and pencil need a visible
 * line). The importer used to style THROUGH those defaults with the
 * stroke set to none, so every stroke-less shape it ever imported came
 * out with exactly this hairline.
 *
 * That is a FIDELITY GAP — an SVG shape with no stroke has no stroke —
 * and it is reproduced here ON PURPOSE: this lane was changed for what it
 * costs, not for what it draws, and what it draws is unchanged, element
 * for element. Making it `{ color: null }` is the fix, and it is a
 * decision about what imported artwork LOOKS like (it moves every
 * baseline that shows imported SVG), so it is not taken in passing.
 * `svg-io.spec.ts` pins the current value.
 */
export const SVG_IMPORT_UNSTROKED: { color: string | null; weight: number } =
  { color: "Color/Black", weight: 1 };

/** The three writes that paint `target` — ALL three, always: the insert
 *  inherited whatever creation defaults the user happens to have, and an
 *  imported shape's paint must not depend on them.
 *
 *  (The Phase 8 finding that sent the importer through the creation
 *  defaults in the first place — an `insertPath` Polygon REJECTED a direct
 *  `setElementProperty` write — has not been true since the engine was
 *  re-probed on 2026-08-04; the appearance group bake relies on the same
 *  writes.) */
function paintMutationsFor(
  target: ElementId,
  paint: ShapeDefaults,
): Mutation[] {
  const colorRef = (
    path: "frameFillColor" | "frameStrokeColor",
    value: string | null,
  ): Mutation => ({
    op: "setElementProperty",
    args: { elementId: target, path, value: { type: "colorRef", value } },
  });
  return [
    colorRef("frameFillColor", paint.fillColor ?? null),
    colorRef(
      "frameStrokeColor",
      paint.strokeColor ?? SVG_IMPORT_UNSTROKED.color,
    ),
    {
      op: "setElementProperty",
      args: {
        elementId: target,
        path: "frameStrokeWeight",
        value: {
          type: "length",
          value: paint.strokeWeight ?? SVG_IMPORT_UNSTROKED.weight,
        },
      },
    },
  ];
}

/** Resolve the page to insert onto: the document's active page when the
 *  host reports one, else the first page in the `pages` collection (the
 *  headless / no-focus fallback). Returns null when the document has no
 *  pages. Exported for the wave-2 insert-shape commands (the same
 *  no-second-copy rule as the mutation builders). */
export async function resolveTargetPage(host: BundleHost): Promise<string | null> {
  const meta = await host.document.meta();
  if (meta.activePage) return meta.activePage;
  try {
    const pages = await host.document.collection<{ selfId?: string }>("pages");
    for (const p of pages) {
      if (p && typeof p.selfId === "string") return p.selfId;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ------------------------------------------------- the one-batch plan

/** One shape, ready to commit: its paint, and one `insertPath` per
 *  contour (compound shapes → sibling paths, in contour order). */
export interface SvgImportUnit {
  style: SvgStyle;
  inserts: Mutation[];
}

/** The shapes of a file as commit units, in DOCUMENT order — which is the
 *  order they are inserted in, and insertion order is paint order. A shape
 *  with no contour to insert contributes nothing (no swatch either).
 *  Pure — exported for the conformance spec. */
export function svgImportUnitsFor(
  pageId: string,
  shapes: readonly DrawShape[],
): SvgImportUnit[] {
  const units: SvgImportUnit[] = [];
  for (const shape of shapes) {
    const inserts = insertPathMutationsForShape(pageId, shape.anchors);
    if (inserts.length > 0) units.push({ style: shape.style, inserts });
  }
  return units;
}

/** The batch-local handle of the Nth contour a batch inserts. */
export const svgImportHandle = (contour: number): string => `c${contour}`;

/**
 * The children of ONE batch that commits `units`, in the order the engine
 * must see them. Per unit: a `createSwatch` for each colour `palette` does
 * not hold yet; then per contour its `insertPath`, the `bindCreated` that
 * names it, and the three property writes that paint it through that
 * name. The module header says why the paint is not inherited instead.
 *
 * Self-contained: any run of units — or of one unit's contours — may be
 * committed alone, which is what the refusal bisection does.
 *
 * `palette` is WRITTEN — hand in a copy when the batch may be refused.
 * Pure otherwise — exported for the conformance spec.
 */
export function svgImportOpsFor(
  units: readonly SvgImportUnit[],
  palette: SvgSwatchPalette,
): MutationInput[] {
  const ops: MutationInput[] = [];
  let contour = 0;
  for (const unit of units) {
    const { swatches, defaults } = styleDefaultsForShape(unit.style, palette);
    for (const swatch of swatches) ops.push(swatch);
    for (const insert of unit.inserts) {
      const handle = svgImportHandle(contour++);
      ops.push(insert, bindCreatedMutationFor(handle));
      for (const write of paintMutationsFor(handleElementId(handle), defaults)) {
        ops.push(write);
      }
    }
  }
  return ops;
}

/** What one import put into the document. */
export interface SvgImportCommit {
  /** Shapes the file parsed into. */
  shapes: number;
  /** Elements inserted — one per contour. */
  elements: number;
  /** Swatches created — one per DISTINCT colour among the shapes that
   *  reached the document. */
  swatches: number;
  /** Batches the engine APPLIED. Each is one rebuild and one undo step:
   *  1 for a file the engine takes whole, more only when it refused
   *  something and the batch was bisected around it. */
  batches: number;
  /** Contours the engine refused, each warned and left out. */
  refused: number;
}

const nothingCommitted = (shapes: number): SvgImportCommit => ({
  shapes,
  elements: 0,
  swatches: 0,
  batches: 0,
  refused: 0,
});

/** Parse, or say why there is nothing to import. */
function shapesToImport(host: BundleHost, file: ImportRequest): DrawShape[] {
  const shapes = shapesFromSvgBytes(file.bytes);
  if (shapes.length === 0) {
    host.log.warn(`${SVG_IMPORTER_ID}: no shapes in ${file.name}`);
  }
  return shapes;
}

/** `minted` — when given, every APPLIED batch's created elements are
 *  appended to it, in insertion order (`commands/minted.ts`). Only the
 *  caller that wants the ids passes it: on a host whose reply lists
 *  nothing, finding them costs two scene-tree reads per batch. */
async function commitShapes(
  host: BundleHost,
  shapes: readonly DrawShape[],
  fileName: string,
  minted?: ElementId[],
): Promise<SvgImportCommit> {
  const done = nothingCommitted(shapes.length);
  const pageId = await resolveTargetPage(host);
  if (!pageId) {
    host.log.warn(`${SVG_IMPORTER_ID}: no target page — nothing inserted`);
    return done;
  }
  let palette: SvgSwatchPalette = new Map();

  // Commit a run of units as one batch. A refusal is atomic (measured: no
  // swatch and no path survives it), so the run is halved and each half
  // tried in order — z-order holds — until the refusing contour stands
  // alone. `palette` only ever records swatches a batch that APPLIED
  // created, so a later run never points at one that was rolled back.
  const commit = async (units: readonly SvgImportUnit[]): Promise<void> => {
    if (units.length === 0) return;
    const trial: SvgSwatchPalette = new Map(palette);
    const batch = batchMutationFor(svgImportOpsFor(units, trial));
    let outcome: MutationOutcome;
    if (minted) {
      // The batch inserts paths and swatches only, so what it minted is
      // exactly the contours it inserted, in order (swatches are not
      // elements and are not listed).
      const built = await mutateMinting(host, batch);
      outcome = built.outcome;
      minted.push(...mintedLeaves(built));
    } else {
      outcome = await host.document.mutate(batch);
    }
    if (outcome.applied) {
      done.swatches += trial.size - palette.size;
      palette = trial;
      done.batches += 1;
      for (const unit of units) done.elements += unit.inserts.length;
      return;
    }
    if (units.length > 1) {
      const mid = units.length >> 1;
      await commit(units.slice(0, mid));
      await commit(units.slice(mid));
      return;
    }
    const { style, inserts } = units[0];
    if (inserts.length > 1) {
      // One shape, several contours: the old loop kept the contours the
      // engine accepted, so narrow down to the contour as well.
      const mid = inserts.length >> 1;
      await commit([{ style, inserts: inserts.slice(0, mid) }]);
      await commit([{ style, inserts: inserts.slice(mid) }]);
      return;
    }
    done.refused += 1;
    host.log.warn(
      `${SVG_IMPORTER_ID}: insertPath rejected — ${JSON.stringify(
        outcome.error,
      )}`,
    );
  };
  await commit(svgImportUnitsFor(pageId, shapes));

  host.log.info(
    `${SVG_IMPORTER_ID}: imported ${shapes.length} shapes ` +
      `(${done.elements} elements, ${done.swatches} swatches) from ` +
      `${fileName} in ${done.batches} undo step(s)`,
  );
  return done;
}

/**
 * Commit an opened SVG file to the document — what File ▸ Open runs. Parse
 * → one batch: a swatch per distinct colour, and per shape its paint and
 * one path per contour (a compound shape's extra contours become sibling
 * paths). ONE mutation and ONE undo step for a file the engine takes
 * whole; a contour it refuses is warned and left out (never a throw — the
 * mutate-never-throws convention), at the cost of an undo step per half
 * the bisection had to commit.
 *
 * It does NOT answer the ids it inserted — File ▸ Open has no use for
 * them, and on a host whose reply does not list what a batch minted they
 * would cost two scene-tree reads. {@link importSvg} is the variant that
 * asks.
 */
export async function commitSvgImport(
  host: BundleHost,
  file: ImportRequest,
): Promise<SvgImportCommit> {
  const shapes = shapesToImport(host, file);
  if (shapes.length === 0) return nothingCommitted(0);
  return commitShapes(host, shapes, file.name);
}

/**
 * {@link commitSvgImport}, and the inserted element ids in INSERTION order
 * (= document order = paint order).
 *
 * The ids come off the engine's reply — `mutationApplied.minted`, every
 * element a batch created, in mint order — through `commands/minted.ts`.
 * They used to cost TWO `document.tree()` reads (the tree before and
 * after, diffed), because the published `MutationOutcome` carries only
 * the LAST `createdId` of a batch (RFI K-15). A host whose reply lists
 * nothing still gets the diff, per applied batch.
 */
export async function importSvg(
  host: BundleHost,
  file: ImportRequest,
): Promise<ElementId[]> {
  const shapes = shapesToImport(host, file);
  if (shapes.length === 0) return [];
  const minted: ElementId[] = [];
  const committed = await commitShapes(host, shapes, file.name, minted);
  if (committed.elements === 0) return [];
  return minted;
}

// ---------------------------------------------------------- exporter

/** Resolve a colour ref to a CSS colour string via the swatch
 *  collection: a swatch whose NAME parses as a CSS colour resolves to its
 *  hex (the importer's convention); anything else is unresolvable. */
function makeColorResolver(
  swatches: readonly { selfId: string; name: string }[],
): (ref: string | null | undefined) => string | null | undefined {
  const byId = new Map(swatches.map((s) => [s.selfId, s]));
  return (ref) => {
    if (ref === undefined) return undefined;
    if (ref === null) return null;
    const sw = byId.get(ref);
    if (!sw) return undefined;
    const rgb = parseCssColor(sw.name);
    return rgb ? rgbToHex(rgb) : undefined;
  };
}

/** Read one element's geometry (transform-applied) + style into a
 *  DrawShape. Returns null when the element has no path geometry. */
async function shapeFromElement(
  host: BundleHost,
  id: ElementId,
  resolve: (ref: string | null | undefined) => string | null | undefined,
): Promise<DrawShape | null> {
  const anchorsResult = await host.document.pathAnchors(id);
  if (!anchorsResult || anchorsResult.anchors.length === 0) return null;

  const m: Affine | null = anchorsResult.itemTransform ?? null;
  const apply = (p: readonly [number, number]): [number, number] =>
    m ? (applyAffine(m, p[0], p[1]) as [number, number]) : [p[0], p[1]];
  const anchors: AnchorTriple[] = anchorsResult.anchors.map((a) => ({
    anchor: apply(a.anchor),
    left: apply(a.left),
    right: apply(a.right),
  }));
  const table: AnchorTable = {
    anchors,
    subpathStarts: anchorsResult.subpathStarts ?? [],
    subpathOpen: anchorsResult.subpathOpen,
  };

  const style: SvgStyle = {};
  const props = await host.document.elementProperties(id);
  if (props) {
    for (const entry of props.entries) {
      const v = entry.value;
      if (!v) continue;
      if (entry.path === "frameFillColor" && v.type === "colorRef") {
        const c = resolve(v.value);
        style.fill = c === undefined ? "#000000" : c;
      } else if (entry.path === "frameStrokeColor" && v.type === "colorRef") {
        const c = resolve(v.value);
        if (c) style.stroke = c;
      } else if (entry.path === "frameStrokeWeight" && v.type === "length") {
        if (typeof v.value === "number" && v.value > 0) {
          style.strokeWidth = v.value;
        }
      }
    }
  }
  // A path with no resolved fill at all defaults to a visible black fill
  // (an SVG path with no `fill` attr renders black) — keep that explicit.
  if (style.fill === undefined && style.stroke === undefined) {
    style.fill = "#000000";
  }
  return { anchors: table, style };
}

/**
 * Export the current selection (or, when nothing is selected, return
 * null — there's nothing to export). Reads each selected element's
 * geometry + style and serializes an SVG document.
 */
export async function exportSvg(
  host: BundleHost,
): Promise<ExportResult | null> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${SVG_EXPORTER_ID}: empty selection — nothing to export`);
    return null;
  }
  let swatches: readonly { selfId: string; name: string }[] = [];
  try {
    swatches = await host.document.collection<{ selfId: string; name: string }>(
      "swatches",
    );
  } catch {
    swatches = [];
  }
  const resolve = makeColorResolver(swatches);

  const shapes: DrawShape[] = [];
  for (const id of selection) {
    const shape = await shapeFromElement(host, id, resolve);
    if (shape) shapes.push(shape);
  }
  if (shapes.length === 0) {
    host.log.warn(
      `${SVG_EXPORTER_ID}: selection has no vector geometry — nothing to export`,
    );
    return null;
  }
  const svg = serializeSvgDocument(shapes, { precision: 3 });
  const meta = await host.document.meta();
  const base = meta.documentName?.trim() || "drawing";
  return {
    bytes: new TextEncoder().encode(svg),
    fileName: `${base}.svg`,
  };
}

// ------------------------------------------------------- registration

/** Register both the SVG importer and exporter through the K-2 doors,
 *  capability-gated (degrades honestly when a host predates the door).
 *  Returns a Disposable dropping both. */
export function contributeSvgIo(host: BundleHost): Disposable {
  const disposers: Disposable[] = [];
  if (host.supports("contribute.importer@1")) {
    disposers.push(
      host.contribute.importer({
        id: SVG_IMPORTER_ID,
        title: "SVG (Scalable Vector Graphics)",
        extensions: [".svg"],
        mimeTypes: [SVG_MIME],
        // File ▸ Open has no use for the inserted ids, so it takes the
        // lane that does not read the tree twice to learn them.
        import: (file) => void commitSvgImport(host, file),
      }),
    );
  } else {
    host.log.warn(
      `${SVG_IMPORTER_ID}: host predates contribute.importer@1 — not registered`,
    );
  }
  if (host.supports("contribute.exporter@1")) {
    disposers.push(
      host.contribute.exporter({
        id: SVG_EXPORTER_ID,
        title: "SVG (selection)",
        extension: ".svg",
        mimeType: SVG_MIME,
        export: () => exportSvg(host),
      }),
    );
  } else {
    host.log.warn(
      `${SVG_EXPORTER_ID}: host predates contribute.exporter@1 — not registered`,
    );
  }
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
