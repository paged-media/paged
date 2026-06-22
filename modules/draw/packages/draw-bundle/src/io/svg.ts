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
// per shape, with a fill/stroke swatch created + assigned when the shape
// carries a solid colour. No new platform door: it rides
// `host.document.mutate` only.
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

/** The document defaults (fill / stroke ref + stroke weight) a newly
 *  inserted path inherits. `null` = none; `undefined` = leave as-is. */
export interface ShapeDefaults {
  fillColor?: string | null;
  strokeColor?: string | null;
  strokeWeight?: number | null;
}

/** The swatch-create mutations + the resolved document defaults for one
 *  shape's style. An inserted `insertPath` polygon does NOT accept a
 *  direct `setElementProperty{ frameFillColor }` write (the engine rejects
 *  frame-property writes on a Polygon — FINDING, Phase 8); instead a new
 *  path inherits the document defaults at creation. So the importer
 *  creates the colour swatches (NAMED with their hex so the exporter
 *  resolves them back) and sets the document defaults to point at them
 *  BEFORE the insert. Pure — exported for the conformance spec. */
export function styleDefaultsForShape(style: SvgStyle): {
  swatches: Mutation[];
  defaults: ShapeDefaults;
} {
  const swatches: Mutation[] = [];
  const defaults: ShapeDefaults = {};

  // Fill: a solid colour → a swatch ref; `none` → no fill.
  if (style.fill === null) {
    defaults.fillColor = null;
  } else if (style.fill !== undefined) {
    const rgb = parseCssColor(style.fill);
    if (rgb) {
      const id = mintSwatchId();
      swatches.push(createRgbSwatch(id, rgb));
      defaults.fillColor = id;
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
      const id = mintSwatchId();
      swatches.push(createRgbSwatch(id, rgb));
      defaults.strokeColor = id;
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

function setDocumentDefaultsMutation(d: ShapeDefaults): Mutation {
  return {
    op: "setDocumentDefaults",
    args: {
      fillColor: d.fillColor ?? null,
      strokeColor: d.strokeColor ?? null,
      strokeWeight: d.strokeWeight ?? null,
    },
  };
}

/** Resolve the page to insert onto: the document's active page when the
 *  host reports one, else the first page in the `pages` collection (the
 *  headless / no-focus fallback). Returns null when the document has no
 *  pages. */
async function resolveTargetPage(host: BundleHost): Promise<string | null> {
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

/**
 * Import an opened SVG file: parse → for each shape, insert its path(s)
 * and assign fill/stroke. Each shape is one inserted element (a compound
 * shape's extra contours become sibling paths). A rejected mutation is
 * warned and skipped (never a throw — the mutate-never-throws
 * convention). Returns the inserted element ids.
 */
export async function importSvg(
  host: BundleHost,
  file: ImportRequest,
): Promise<ElementId[]> {
  const shapes = shapesFromSvgBytes(file.bytes);
  if (shapes.length === 0) {
    host.log.warn(`${SVG_IMPORTER_ID}: no shapes in ${file.name}`);
    return [];
  }
  const pageId = await resolveTargetPage(host);
  if (!pageId) {
    host.log.warn(`${SVG_IMPORTER_ID}: no target page — nothing inserted`);
    return [];
  }

  // Save the document's current creation defaults so the import doesn't
  // leave them clobbered (a new path inherits the defaults at creation —
  // the engine rejects a direct frame-property write on the inserted
  // Polygon, so style flows through the defaults). Restored at the end.
  const meta0 = await host.document.meta();
  const original: ShapeDefaults = {
    fillColor: meta0.defaultFillColor ?? null,
    strokeColor: meta0.defaultStrokeColor ?? null,
    strokeWeight: meta0.defaultStrokeWeight ?? null,
  };

  const inserted: ElementId[] = [];
  const mutate = async (m: Mutation, what: string): Promise<boolean> => {
    const outcome = await host.document.mutate(m);
    if (!outcome.applied) {
      host.log.warn(
        `${SVG_IMPORTER_ID}: ${what} rejected — ${JSON.stringify(
          outcome.error,
        )}`,
      );
    }
    return outcome.applied;
  };

  for (const shape of shapes) {
    // 1) Create this shape's colour swatches + resolve the defaults.
    const { swatches, defaults } = styleDefaultsForShape(shape.style);
    for (const sw of swatches) await mutate(sw, "createSwatch");
    // 2) Point the document defaults at them (the inserted path inherits).
    await mutate(setDocumentDefaultsMutation(defaults), "setDocumentDefaults");
    // 3) Insert one path per contour (compound shapes → sibling paths).
    for (const mutation of insertPathMutationsForShape(pageId, shape.anchors)) {
      const outcome = await host.document.mutate(mutation);
      if (!outcome.applied) {
        host.log.warn(
          `${SVG_IMPORTER_ID}: insertPath rejected — ${JSON.stringify(
            outcome.error,
          )}`,
        );
        continue;
      }
      if (outcome.createdId) inserted.push(outcome.createdId);
    }
  }

  // Restore the original creation defaults.
  await mutate(setDocumentDefaultsMutation(original), "restore defaults");

  host.log.info(
    `${SVG_IMPORTER_ID}: imported ${shapes.length} shapes ` +
      `(${inserted.length} elements) from ${file.name}`,
  );
  return inserted;
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
        import: (file) => void importSvg(host, file),
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
