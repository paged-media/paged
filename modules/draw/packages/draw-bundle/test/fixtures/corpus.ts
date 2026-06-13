// The paged.draw conformance CORPUS — a small set of named, multi-shape
// IDML documents that exercise the bundle's REAL surfaces (geometry
// round-trips, anchor-edit plan replay, metadata persistence). Each
// entry is built by the pure-TS IDML builder (`build-idml.ts`) so the
// shapes are readable XML and the bytes are deterministic — no `zip`
// tool, no vendored base64 per document, no network.
//
// The B-13 RESOLVED entry named this as the foundation's next step:
// "a fixture CORPUS replay harness". These fixtures are that corpus.

import { packageWithSpread, pathItem } from "./build-idml";

export interface CorpusFixture {
  /** Stable id used in spec titles + the per-fixture assertions. */
  id: string;
  /** One-line description of what surface it exercises. */
  about: string;
  /** Build the IDML bytes (called once per spec file, in beforeAll). */
  bytes(): Uint8Array;
  /** The leaf page-item ids the corpus author placed, by kind. */
  ids: {
    rectangle?: string;
    polygon?: string;
    graphicLine?: string;
  };
  /** Page id the items live on (always one page in the corpus). */
  pageId: string;
}

/** F1 — a multi-shape document: a closed rectangle (the metadata
 *  carrier, since the v34 plugin-metadata door round-trips on
 *  rectangles), an OPEN 3-anchor polygon (the add/delete/convert
 *  replay target — pathAnchors exposes its anchor table), and a
 *  2-anchor open graphic line. The canonical fixture every anchor
 *  tool's plan shape is replayed against. */
export const F1_MULTI_SHAPE: CorpusFixture = {
  id: "multi-shape",
  about:
    "rectangle (metadata carrier) + open polygon (anchor-plan target) + graphic line",
  pageId: "usp",
  ids: { rectangle: "urect", polygon: "upoly", graphicLine: "uline" },
  bytes() {
    // The rectangle is authored inline (not via `pathItem`) because the
    // metadata door round-trips on the `<Rectangle>` element kind.
    const rectXml =
      `<Rectangle Self="urect" GeometricBounds="100 100 300 300" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black">` +
      `<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
      `<PathPointType Anchor="100 100" LeftDirection="100 100" RightDirection="100 100"/>` +
      `<PathPointType Anchor="100 300" LeftDirection="100 300" RightDirection="100 300"/>` +
      `<PathPointType Anchor="300 300" LeftDirection="300 300" RightDirection="300 300"/>` +
      `<PathPointType Anchor="300 100" LeftDirection="300 100" RightDirection="300 100"/>` +
      `</PathPointArray></GeometryPathType></PathGeometry></Properties></Rectangle>`;
    const poly = pathItem("Polygon", "upoly", "400 100 600 400", true, [
      { a: [100, 400] },
      { a: [250, 600] },
      { a: [400, 400] },
    ]);
    const line = pathItem("GraphicLine", "uline", "650 100 700 400", true, [
      { a: [100, 650] },
      { a: [400, 700] },
    ]);
    return packageWithSpread(rectXml + poly + line);
  },
};

/** F2 — a CLOSED quadrilateral polygon: exercises the add tool's
 *  closing-edge subpath bookkeeping (the wraparound segment that
 *  `segmentPairsOf` enumerates only for closed contours) and the
 *  delete tool's min-anchors refusal (a closed quad can lose one
 *  point; a triangle cannot drop below two). */
export const F2_CLOSED_QUAD: CorpusFixture = {
  id: "closed-quad",
  about: "closed 4-anchor polygon — closing-edge add + delete floor",
  pageId: "usp",
  ids: { polygon: "uquad" },
  bytes() {
    const quad = pathItem("Polygon", "uquad", "100 100 300 300", false, [
      { a: [100, 100] },
      { a: [300, 100] },
      { a: [300, 300] },
      { a: [100, 300] },
    ]);
    return packageWithSpread(quad);
  },
};

/** F3 — a CURVED open polygon (real Bezier handles, not collapsed
 *  corners): the add tool must split the cubic curve-preservingly, so
 *  the inserted anchor's handles are the de Casteljau midpoints, not a
 *  straight-line interpolation. Proves the geometry kernel feeds the
 *  engine the right control points. */
export const F3_CURVED_OPEN: CorpusFixture = {
  id: "curved-open",
  about: "open polygon with real Bezier handles — curve-preserving split",
  pageId: "usp",
  ids: { polygon: "ucurve" },
  bytes() {
    // A single cubic-ish run: anchor 0 with an outgoing handle, anchor
    // 1 with an incoming handle (a smooth S the add tool splits).
    const curve = pathItem("Polygon", "ucurve", "100 100 400 300", true, [
      { a: [100, 200], r: [160, 100] },
      { a: [400, 200], l: [340, 300] },
    ]);
    return packageWithSpread(curve);
  },
};

/** F4 — TWO OVERLAPPING closed quads (Phase 4c): the pathfinder
 *  conformance targets. `ua` (100..300)² overlaps `ub` (200..400)²;
 *  `ids.polygon` carries the KEPT element, `secondId` the consumed one. */
export const F4_OVERLAP: CorpusFixture & { secondId: string } = {
  id: "overlap-pair",
  about: "two overlapping closed polygons — pathfinder boolean targets",
  pageId: "usp",
  ids: { polygon: "ua" },
  secondId: "ub",
  bytes() {
    const a = pathItem("Polygon", "ua", "100 100 300 300", false, [
      { a: [100, 100] },
      { a: [300, 100] },
      { a: [300, 300] },
      { a: [100, 300] },
    ]);
    const b = pathItem("Polygon", "ub", "200 200 400 400", false, [
      { a: [200, 200] },
      { a: [400, 200] },
      { a: [400, 400] },
      { a: [200, 400] },
    ]);
    return packageWithSpread(a + b);
  },
};

export const CORPUS: readonly CorpusFixture[] = [
  F1_MULTI_SHAPE,
  F2_CLOSED_QUAD,
  F3_CURVED_OPEN,
];
