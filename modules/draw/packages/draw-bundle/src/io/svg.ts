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
// through the SAME `insertPath` lane the pen/pencil tools use — ONE
// element per shape, with a fill/stroke swatch created + assigned when the
// shape carries a solid colour. No new platform door: it rides
// `host.document.mutate` only.
//
// A SHAPE OF SEVERAL CONTOURS IS ONE COMPOUND PATH — a ring is one
// element with a hole, not a disc under a disc. `insertPath` carries ONE
// contour, so the shape's first contour is inserted, named
// (`bindCreated`), and the whole table is written onto that name through
// the `framePath` door Make Compound Path and Image Trace use, its frame
// box with it (`frameBounds`: a `framePath` write does not recompute the
// box, and a later contour may lie outside the first). The table is
// written in SPREAD space — `insertPath` adds the page's origin,
// `framePath` stores verbatim (`../page-origin.ts`) — so the origin comes
// from the target page's row in the `pages` collection.
//
// THE FILL RULE. The shape's `fill-rule` says which region it means.
// An engine that carries the rule as a property (`frameFillRule`, engine
// ADR 1006; `host.supports("document.fillRule@1")`) is TOLD: an `evenodd`
// shape keeps its contours as authored and its element is written
// `frameFillRule: "EvenOdd"` — exact for every shape, a self-intersecting
// star (its middle empty) included, single contour or compound. `nonzero`,
// SVG's default, writes nothing: it is the engine's default.
//
// On an OLDER engine, which fills non-zero only, the rule is said with
// WINDING, and draw-geometry's `orientForFillRule` decides (winding is
// decided there and nowhere else): `nonzero` keeps the contours as
// authored — they already describe a non-zero region; `evenodd` re-winds
// them by NESTING DEPTH, which paints the even-odd region for contours
// that do not cross. Even-odd over CROSSING contours (the star) cannot be
// said with direction there and paints its non-zero region.
//
// THREE CASES STAY ONE ELEMENT PER CONTOUR, as every shape used to:
//   · an OPEN contour after the first — `framePath` carries no
//     `subpathOpen`, so a merged open contour would render CLOSED, and a
//     stroked polyline would gain a closing segment it never had;
//   · a target page whose row reports no `pageOrigin` (an engine before
//     core 0.71.13) — the spread-space table cannot be written without it;
//   · a compound the engine REFUSED, bisected down to its contours (below).
//
// ONE FILE IS ONE BATCH — one document rebuild and one undo step, however
// many shapes it holds. It used to be a loop of awaited single mutations:
// a swatch per colour PER SHAPE, a creation-defaults swap per shape and an
// insert per contour, each one a full rebuild and (swatches and inserts)
// its own undo step. Measured on a 50-shape file into a 500-shape
// document: 201 mutations and 150 undo steps. Now: 1 and 1.
//
// THE BATCH, per element and in this order — every rule MEASURED against
// the booted engine (protocol 64), because each is a way to get it wrong:
//
//   createSwatch        once per DISTINCT colour of the file, with a
//                       client-chosen id a LATER child may point at;
//   insertPath          the (first) contour;
//   bindCreated         names what that insert minted — its OWN op, and
//                       AFTER its creating child (the C-15 rules,
//                       `commands/batch-handles.ts`);
//   setElementProperty  ×2 on `"$h:<handle>"`, a compound only — the whole
//                       table (`framePath`), then its box (`frameBounds`);
//   setElementProperty  ×3 on `"$h:<handle>"` — fill, stroke, weight;
//   setElementProperty  ×1 more, `frameFillRule`, for an `evenodd` shape
//                       on an engine that carries the rule.
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
// FIXED in core 0.71.7 (RFI C-79): the mixed-batch lane now holds the cap
// while its children log and applies it once to the collapsed entry, so a
// batch WITH a defaults child is one undo step too (`svg-io.spec.ts` pins
// the fixed behaviour). The handle lane stays: it is right on every
// engine, including the ones before the fix that a host may still boot.
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
// file alone: every half that applies is its own undo step — and a
// compound shape split this way lands as one element per surviving
// contour, its holes painted, because the contour the engine refused is
// the one the hole needed it to agree with.
//
// The EXPORTER claims `.svg`: it reads the selected shapes' geometry
// (`pathAnchors`, with the element transform applied so the exported
// coordinates match the visual layout) + fill/stroke (`elementProperties`
// → a colour ref resolved against the swatch collection by NAME), and
// serializes an `<svg>` document.
//
// THE ENGINE LANE (engine ADR 1016). On a host with `document.importSvg@1`
// / `document.exportSvg@1` both halves delegate to the engine's paged-svg:
// the import is the engine's one batch (gradients, text, images, <use>,
// clip paths, masks and CSS included; what it approximates or leaves out is
// logged from its report), the export is the engine's SVG of what the
// selection draws. Everything below is the fallback for a host without the
// doors (an engine before protocol 77), kept as it was.
//
// HONEST DEFERRALS of the fallback (documented, asserted by tests where they bite):
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
  contourRanges,
  orientForFillRule,
  parseCssColor,
  rgbToHex,
  tableBounds,
  type DrawShape,
  type SvgStyle,
  type AnchorTable,
  type AnchorTriple,
  type Affine,
} from "@paged-media/draw-geometry";

import { defineMessages, t } from "@paged-media/strings";
import { framePathMutationFor } from "../commands/compound-path";
import { mintedLeaves, mutateMinting } from "../commands/minted";
import { pageOriginOf, spreadTableOf, type PageOrigin } from "../page-origin";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "../commands/batch-handles";

const M = defineMessages("draw.svg", {
  importerTitle: "SVG (Scalable Vector Graphics)",
  exporterTitle: "SVG (selection)",
});

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
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
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

/** One `insertPath` per contour of `table` (the EXACT shape the
 *  pen/pencil commit emits): the engine's `insertPath` takes a single
 *  contour and a single open/closed flag. This is the lowering of
 *  contours that are SEPARATE paths — the insert-shape grids, and the
 *  importer's one-element-per-contour cases; an imported compound shape
 *  inserts only its first contour this way and writes the rest through
 *  `framePath` ({@link svgImportOpsFor}). Exported for the conformance
 *  spec. */
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
export const SVG_IMPORT_UNSTROKED: { color: string | null; weight: number } = {
  color: "Color/Black",
  weight: 1,
};

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

/** The write that fills `target` by `rule` (engine ADR 1006). */
function fillRuleMutationFor(target: ElementId, rule: "EvenOdd"): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: target,
      path: "frameFillRule",
      value: { type: "text", value: rule },
    },
  };
}

/** Resolve the page to insert onto: the document's active page when the
 *  host reports one, else the first page in the `pages` collection (the
 *  headless / no-focus fallback). Returns null when the document has no
 *  pages. Exported for the wave-2 insert-shape commands (the same
 *  no-second-copy rule as the mutation builders). */
export async function resolveTargetPage(
  host: BundleHost,
): Promise<string | null> {
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

/** Where an import lands: the page, and that page's origin in its spread
 *  — `null` when the engine does not report one, which keeps every shape
 *  one element per contour (the module header says why). */
export interface SvgImportTarget {
  pageId: string;
  pageOrigin: PageOrigin | null;
  /** The engine fills by the element's own `frameFillRule`
   *  (`document.fillRule@1`): an `evenodd` shape is written that rule
   *  instead of being re-wound. Absent = it does not (fills non-zero). */
  nativeFillRule?: boolean;
}

/** The host feature that says the engine carries `frameFillRule`. */
export const FILL_RULE_FEATURE = "document.fillRule@1";

/** A `pages` row, as far as the importer reads it. */
interface PageRow {
  selfId?: string;
  pageOrigin?: unknown;
}

/** {@link resolveTargetPage}, and the page's origin when `withOrigin` —
 *  read off the same `pages` row, so a file with a compound shape costs
 *  at most that one collection read on top of the meta read. */
async function resolveImportTarget(
  host: BundleHost,
  withOrigin: boolean,
): Promise<SvgImportTarget | null> {
  const meta = await host.document.meta();
  const nativeFillRule = host.supports(FILL_RULE_FEATURE);
  if (meta.activePage && !withOrigin) {
    return { pageId: meta.activePage, pageOrigin: null, nativeFillRule };
  }
  let rows: readonly PageRow[] = [];
  try {
    rows = await host.document.collection<PageRow>("pages");
  } catch {
    rows = [];
  }
  const pageId =
    meta.activePage ??
    rows.find((p) => p && typeof p.selfId === "string")?.selfId ??
    null;
  if (!pageId) return null;
  const row = rows.find((p) => p?.selfId === pageId);
  return {
    pageId,
    pageOrigin:
      withOrigin && row && Array.isArray(row.pageOrigin)
        ? pageOriginOf(row)
        : null,
    nativeFillRule,
  };
}

// ------------------------------------------------- the one-batch plan

/** One contour of a unit, in PAGE space, in the direction it is written. */
export interface SvgImportContour {
  anchors: AnchorTriple[];
  open: boolean;
}

/** One unit of commit: a shape's paint and the contours it lands. With
 *  `pageOrigin` set the unit is ONE compound element (its first contour
 *  inserted, the whole table written by `framePath`); with `null` it is
 *  one element per contour. */
export interface SvgImportUnit {
  style: SvgStyle;
  pageId: string;
  contours: SvgImportContour[];
  /** The page's origin in its spread when the contours are ONE element;
   *  null = one element per contour. */
  pageOrigin: PageOrigin | null;
  /** `"EvenOdd"`: every element of the unit is written that
   *  `frameFillRule` (an `evenodd` shape on an engine that carries the
   *  rule; its contours are as authored). Absent: the engine's default,
   *  non-zero, and the contours are wound for it. */
  fillRule?: "EvenOdd";
}

/** Elements a unit puts into the document. */
const elementsOf = (unit: SvgImportUnit): number =>
  unit.pageOrigin !== null ? 1 : unit.contours.length;

/** The contours of `table` as written, empty ranges dropped, each with
 *  its own open flag — read at the contour's index in `subpathStarts`, so
 *  a dropped empty contour does not shift a later flag onto its
 *  neighbour. */
function contoursOfTable(table: AnchorTable): SvgImportContour[] {
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  const open = table.subpathOpen ?? [];
  const out: SvgImportContour[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : table.anchors.length;
    if (to <= from) continue;
    out.push({
      anchors: table.anchors.slice(from, to).map((a) => ({
        anchor: [a.anchor[0], a.anchor[1]] as [number, number],
        left: [a.left[0], a.left[1]] as [number, number],
        right: [a.right[0], a.right[1]] as [number, number],
      })),
      open: open[i] ?? false,
    });
  }
  return out;
}

/** Can a shape be ONE element? Two or more contours, and none past the
 *  first open: `framePath` carries no `subpathOpen`, so a later open
 *  contour would render closed (the first one's flag rides `insertPath`). */
const compoundable = (table: AnchorTable): boolean => {
  const contours = contoursOfTable(table);
  return contours.length >= 2 && contours.slice(1).every((c) => !c.open);
};

/** The shapes of a file as commit units, in DOCUMENT order — which is the
 *  order they are inserted in, and insertion order is paint order. A shape
 *  with no contour to insert contributes nothing (no swatch either). A
 *  shape of several contours is ONE compound unit when
 *  `target.pageOrigin` is known and no contour past the first is open.
 *  An `evenodd` shape on an engine that carries the fill rule
 *  (`target.nativeFillRule`) keeps its contours as authored and is marked
 *  `fillRule: "EvenOdd"`; otherwise a compound's contours are oriented
 *  for its `fill-rule` by draw-geometry's `orientForFillRule`.
 *  Pure — exported for the conformance spec. */
export function svgImportUnitsFor(
  target: SvgImportTarget,
  shapes: readonly DrawShape[],
): SvgImportUnit[] {
  const units: SvgImportUnit[] = [];
  for (const shape of shapes) {
    const compound = target.pageOrigin !== null && compoundable(shape.anchors);
    const evenOdd =
      target.nativeFillRule === true && shape.style.fillRule === "evenodd";
    const table =
      compound && !evenOdd
        ? orientForFillRule(shape.anchors, shape.style.fillRule)
        : shape.anchors;
    const contours = contoursOfTable(table);
    if (contours.length === 0) continue;
    units.push({
      style: shape.style,
      pageId: target.pageId,
      contours,
      pageOrigin: compound ? target.pageOrigin : null,
      ...(evenOdd ? { fillRule: "EvenOdd" as const } : {}),
    });
  }
  return units;
}

/** Halve a unit's contours — the refusal bisection's narrowing of ONE
 *  shape. Each half keeps the shape's orientation and lands as one
 *  element per contour: the hole relation was between contours the
 *  engine did not take together. */
function splitUnit(unit: SvgImportUnit): [SvgImportUnit, SvgImportUnit] {
  const mid = unit.contours.length >> 1;
  const half = (contours: SvgImportContour[]): SvgImportUnit => ({
    ...unit,
    contours,
    pageOrigin: null,
  });
  return [half(unit.contours.slice(0, mid)), half(unit.contours.slice(mid))];
}

/** The batch-local handle of the Nth element a batch inserts. */
export const svgImportHandle = (element: number): string => `c${element}`;

const insertOf = (pageId: string, c: SvgImportContour): Mutation => ({
  op: "insertPath",
  args: { pageId, anchors: c.anchors, open: c.open },
});

/** The writes that turn the element `target`, inserted with the unit's
 *  first contour, into the whole compound: the table (spread space —
 *  `framePath` stores verbatim where `insertPath` added the origin), then
 *  the frame box around it. */
function compoundWritesFor(
  target: ElementId,
  unit: SvgImportUnit,
  origin: PageOrigin,
): MutationInput[] {
  const anchors: AnchorTriple[] = [];
  const subpathStarts: number[] = [];
  for (const c of unit.contours) {
    subpathStarts.push(anchors.length);
    anchors.push(...c.anchors);
  }
  const spread = spreadTableOf({ anchors, subpathStarts }, origin);
  const ops: MutationInput[] = [framePathMutationFor(target, spread)];
  const box = tableBounds(spread);
  if (box) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: target,
        path: "frameBounds",
        value: { type: "bounds", value: box },
      },
    });
  }
  return ops;
}

/**
 * The children of ONE batch that commits `units`, in the order the engine
 * must see them. Per unit: a `createSwatch` for each colour `palette` does
 * not hold yet; then per element its `insertPath`, the `bindCreated` that
 * names it, for a compound the `framePath` + `frameBounds` writes that
 * make it the whole shape, and the three property writes that paint it
 * through that name. The module header says why the paint is not
 * inherited instead.
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
  let element = 0;
  for (const unit of units) {
    const { swatches, defaults } = styleDefaultsForShape(unit.style, palette);
    for (const swatch of swatches) ops.push(swatch);
    const elements =
      unit.pageOrigin !== null ? [unit.contours[0]!] : unit.contours;
    for (const contour of elements) {
      const handle = svgImportHandle(element++);
      const target = handleElementId(handle);
      ops.push(insertOf(unit.pageId, contour), bindCreatedMutationFor(handle));
      if (unit.pageOrigin !== null) {
        ops.push(...compoundWritesFor(target, unit, unit.pageOrigin));
      }
      ops.push(...paintMutationsFor(target, defaults));
      if (unit.fillRule) ops.push(fillRuleMutationFor(target, unit.fillRule));
    }
  }
  return ops;
}

/** The host features of the engine's SVG lane (engine ADR 1016). */
export const IMPORT_SVG_FEATURE = "document.importSvg@1";
export const EXPORT_SVG_FEATURE = "document.exportSvg@1";

/**
 * The engine's import (`host.document.importSvg`, paged-svg over usvg):
 * gradients, text, images, `<use>`/`<defs>`/`<symbol>`, clip paths, masks
 * and CSS come in as native items, and what it cannot say is in its
 * report, each row logged here. `null` when the host has no such door or
 * its engine predates it: the caller then takes this module's own reader.
 *
 * The drawing lands where it is drawn (the SVG's corner on the page's,
 * a user unit a point, as the TypeScript reader places it) and each
 * top-level shape stays its own element (`group: false`), as before.
 */
async function engineImport(
  host: BundleHost,
  file: ImportRequest,
): Promise<{ commit: SvgImportCommit; ids: ElementId[] } | null> {
  if (!host.supports(IMPORT_SVG_FEATURE)) return null;
  const pageId = await resolveTargetPage(host);
  if (!pageId) {
    host.log.warn(`${SVG_IMPORTER_ID}: no target page — nothing inserted`);
    return { commit: nothingCommitted(0), ids: [] };
  }
  const result = await host.document.importSvg(file.bytes, {
    pageId,
    origin: [0, 0],
    group: false,
  });
  for (const note of result.report.notes) {
    host.log.warn(
      `${SVG_IMPORTER_ID}: ${file.name}: ${note.message} (${note.count}×)`,
    );
  }
  if (!result.applied) {
    // An engine before protocol 77 never answered the plan: read the file
    // here instead. Any other refusal is the answer.
    if (/predates protocol 77/.test(result.error ?? "")) return null;
    host.log.warn(
      `${SVG_IMPORTER_ID}: ${file.name} not imported — ${result.error ?? "refused"}`,
    );
    return { commit: nothingCommitted(0), ids: [] };
  }
  const outcome = result.outcome;
  const ids =
    outcome && outcome.applied
      ? (outcome.minted ?? []).map((m) => m.element)
      : [];
  host.log.info(
    `${SVG_IMPORTER_ID}: imported ${file.name} through the engine ` +
      `(${result.report.items} items) in 1 undo step`,
  );
  return {
    commit: {
      shapes: result.report.items,
      elements: result.report.items,
      swatches: 0,
      batches: 1,
      refused: 0,
    },
    ids,
  };
}

/** What one import put into the document. */
export interface SvgImportCommit {
  /** Shapes the file parsed into. */
  shapes: number;
  /** Elements inserted — one per shape, one per contour where a shape
   *  stays split (the module header names the cases). */
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
  const wantsOrigin = shapes.some((s) => compoundable(s.anchors));
  const target = await resolveImportTarget(host, wantsOrigin);
  if (!target) {
    host.log.warn(`${SVG_IMPORTER_ID}: no target page — nothing inserted`);
    return done;
  }
  if (wantsOrigin && target.pageOrigin === null) {
    host.log.warn(
      `${SVG_IMPORTER_ID}: the engine reports no page origin — compound ` +
        `shapes in ${fileName} land as one path per contour, holes painted`,
    );
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
      // exactly the elements it inserted, in order (swatches are not
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
      for (const unit of units) done.elements += elementsOf(unit);
      return;
    }
    if (units.length > 1) {
      const mid = units.length >> 1;
      await commit(units.slice(0, mid));
      await commit(units.slice(mid));
      return;
    }
    if (units[0].contours.length > 1) {
      // One shape, several contours: keep the contours the engine
      // accepts, so narrow down to the contour as well.
      const [front, back] = splitUnit(units[0]);
      await commit([front]);
      await commit([back]);
      return;
    }
    done.refused += 1;
    host.log.warn(
      `${SVG_IMPORTER_ID}: insertPath rejected — ${JSON.stringify(
        outcome.error,
      )}`,
    );
  };
  await commit(svgImportUnitsFor(target, shapes));

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
 * ONE path — a shape of several contours is one compound path, wound for
 * its `fill-rule` (the module header names the cases that stay one path
 * per contour). ONE mutation and ONE undo step for a file the engine takes
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
  const engine = await engineImport(host, file);
  if (engine) return engine.commit;
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
  const engine = await engineImport(host, file);
  if (engine) return engine.ids;
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
  // A compound is ONE `<path>` of several subpaths, and the engine fills
  // it by the element's rule over the windings it stores — the importer
  // wound an even-odd source for non-zero on an engine without the rule —
  // so the file says which rule its geometry is meant for: the element's
  // `frameFillRule` (engine ADR 1006), non-zero when it has none.
  if (contourRanges(table.anchors.length, table.subpathStarts).length > 1) {
    style.fillRule = "nonzero";
  }
  const props = await host.document.elementProperties(id);
  if (props) {
    for (const entry of props.entries) {
      const v = entry.value;
      if (!v) continue;
      if (
        entry.path === "frameFillRule" &&
        v.type === "text" &&
        v.value === "EvenOdd"
      ) {
        // One contour too: a self-crossing star is even-odd on its own.
        style.fillRule = "evenodd";
      } else if (entry.path === "frameFillColor" && v.type === "colorRef") {
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
  if (host.supports(EXPORT_SVG_FEATURE)) {
    // The engine writes what the selection draws (engine ADR 1016):
    // gradients, opacity and blend, clips, masks, pictures, text.
    const result = await host.document.exportSvg({ elementIds: selection });
    for (const note of result.report.notes) {
      host.log.warn(`${SVG_EXPORTER_ID}: ${note.message} (${note.count}×)`);
    }
    if (result.svg !== null) {
      const meta = await host.document.meta();
      const base = meta.documentName?.trim() || "drawing";
      return {
        bytes: new TextEncoder().encode(result.svg),
        fileName: `${base}.svg`,
      };
    }
    host.log.warn(
      `${SVG_EXPORTER_ID}: the engine did not export (${result.error ?? "no answer"}) — writing the paths here`,
    );
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
        title: t(M.importerTitle),
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
        title: t(M.exporterTitle),
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
