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

// The documents the perf budgets are measured ON.
//
// A budget over a three-shape fixture measures the tool's fixed cost and
// nothing else: every "walk the whole document" loop in this bundle is
// invisible at three leaves. These builders author documents with enough
// in them for those loops to show — deterministically (no `Math.random`,
// no clock), on top of a corpus fixture, through `host.document.mutate`
// in as few batches as the engine allows, and — for the linked records —
// through THE BUNDLE'S OWN COMMANDS, so a record is exactly what a user
// would have made and not a hand-written stamp that drifts from it.
//
// Three rules the builders keep:
//
//  1. NOTHING IS FAKED. A build step the engine or a command refuses is
//     recorded in `workload.refusals` with the sentence it was refused
//     with, and the caller sees a shorter list. A budget that needs the
//     missing piece asserts on the refusal instead of on a count.
//  2. EVERYTHING IS ON THE PAGE. `pathAnchors` / `elementGeometry` go
//     silent for an element far enough off the page rect (RFI C-23), and
//     a workload half of whose shapes are unmeasurable measures nothing.
//     The layout below keeps every shape inside the 612 × 792 pt page.
//  3. THE BUILDER IS NOT MEASURED. It runs against the unwrapped
//     `h.host`; a spec wraps the host with `countingHost` only around the
//     gesture or command it budgets.
//
// THE LAYOUT (page-local pt, y down):
//
//   y  16..251  x  20..255   the planar ARRANGEMENT (12 offset squares)
//   y  16..256  x 300..600   the PLAIN shapes (25 × 20 grid of squares)
//   y 264..296  x  20..592   the 1 000-anchor COMB
//   y 311..476  x  23..189   the 10 000-anchor SPIRAL
//   y 500..526  x  16..194   the FACE-CAP pair (a 200-anchor comb + a bar)
//   y 300..780  x 200..590   the LINKED records, one 39 × 16 pt cell each
//                            (10 per row, 5 rows per feature, 6 features)

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationInput,
} from "@paged-media/plugin-api";
import type { AnchorTriple } from "@paged-media/draw-geometry";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  applyDefineSymbol,
  applyFillLivePaintFace,
  applyMakeBlend,
  applyMakeLivePaintGroup,
  applyMakeObjectsOnPath,
  applyMakePattern,
  applyMakeRepeat,
  applyPlaceSymbolInstance,
  drawBundle,
  insertPathMutationFor,
  leafIdsOf,
  readBlendLibrary,
  readObjectsOnPathLibrary,
  readPatternLibrary,
  readRepeatLibrary,
  symbolInstanceOf,
} from "../../src";
import { openHost } from "../conformance/host";
import { F4_OVERLAP, type CorpusFixture } from "../fixtures/corpus";

// ------------------------------------------------------------- geometry

type Pt = [number, number];

/** One path to insert. */
export interface PathSpec {
  anchors: AnchorTriple[];
  open: boolean;
}

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

/** A closed axis-aligned rectangle, four corner anchors, clockwise. */
export function rectPath(x: number, y: number, w: number, h: number): PathSpec {
  return {
    anchors: [
      corner(x, y),
      corner(x + w, y),
      corner(x + w, y + h),
      corner(x, y + h),
    ],
    open: false,
  };
}

/** An open two-anchor line. */
export function linePath(from: Pt, to: Pt): PathSpec {
  return { anchors: [corner(from[0], from[1]), corner(to[0], to[1])], open: true };
}

/** A closed SAWTOOTH with exactly `anchors` anchors: two bottom corners
 *  and a zigzag of `anchors - 2` points along the top, alternating
 *  between `yValley` and `yTip`. A horizontal bar laid between the two
 *  heights cuts every tooth off — one planar face per tooth — which is
 *  how a TWO-input selection gets past the engine's 256-face cap. */
export function combPath(
  anchors: number,
  box: { x0: number; x1: number; yTip: number; yValley: number; yBottom: number },
): PathSpec {
  const zig = anchors - 2;
  const out: AnchorTriple[] = [corner(box.x0, box.yBottom)];
  for (let i = 0; i < zig; i++) {
    const x = box.x0 + ((box.x1 - box.x0) * i) / (zig - 1);
    out.push(corner(x, i % 2 === 0 ? box.yValley : box.yTip));
  }
  out.push(corner(box.x1, box.yBottom));
  return { anchors: out, open: false };
}

/** An open Archimedean spiral polyline with exactly `anchors` anchors. */
export function spiralPath(
  anchors: number,
  centre: Pt,
  radius: { from: number; to: number },
  turns: number,
): PathSpec {
  const out: AnchorTriple[] = [];
  for (let i = 0; i < anchors; i++) {
    const t = i / (anchors - 1);
    const a = t * turns * Math.PI * 2;
    const r = radius.from + (radius.to - radius.from) * t;
    out.push(corner(centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)));
  }
  return { anchors: out, open: true };
}

// ------------------------------------------------------------ the layout

/** The page every corpus fixture carries (`GeometricBounds="0 0 792 612"`). */
export const PAGE = { width: 612, height: 792 } as const;

/** The swatch the workload paints with — the one every fixture declares. */
export const WORKLOAD_FILL = "Color/Black";

const PLAIN = { x: 300, y: 16, columns: 25, pitch: 12, size: 8 } as const;
const ARRANGEMENT = { x: 20, y: 16, size: 180, step: 5 } as const;
const COMB = { x0: 20, x1: 592, yTip: 268, yValley: 290, yBottom: 296 } as const;
const FACE_CAP_COMB = { x0: 20, x1: 190, yTip: 500, yValley: 520, yBottom: 526 } as const;
const FACE_CAP_BAR = { x: 16, y: 506, w: 178, h: 8 } as const;
const SPIRAL = {
  centre: [105, 395] as Pt,
  radius: { from: 4, to: 84 },
  turns: 20,
} as const;
const CELLS = { x: 200, y: 300, w: 39, h: 16, perRow: 10, rowsPerFeature: 5 } as const;

/** The features whose records are LINKS — a `.paged` container part plus
 *  a metadata stamp on every participating leaf. */
export type LinkedFeature =
  | "blend"
  | "repeat"
  | "pattern"
  | "symbols"
  | "objectsOnPath"
  | "livePaint";

export const LINKED_FEATURES: readonly LinkedFeature[] = [
  "blend",
  "repeat",
  "pattern",
  "symbols",
  "objectsOnPath",
  "livePaint",
];

/** How many records one feature's band holds. */
export const MAX_LINKED_RECORDS = CELLS.perRow * CELLS.rowsPerFeature;

/** Top-left of record `index`'s cell in `feature`'s band. */
export function cellOrigin(feature: LinkedFeature, index: number): Pt {
  const band = LINKED_FEATURES.indexOf(feature);
  return [
    CELLS.x + (index % CELLS.perRow) * CELLS.w,
    CELLS.y +
      (band * CELLS.rowsPerFeature + Math.floor(index / CELLS.perRow)) * CELLS.h,
  ];
}

// ----------------------------------------------------------- the workload

/** One thing a build step could not do, in the refuser's own words. */
export interface WorkloadRefusal {
  /** Which build step (`"plain shapes"`, `"blend #7"`, …). */
  what: string;
  /** The engine's error or the command's own warning. */
  reason: string;
}

/** What one feature's builder made. */
export interface LinkedRecords {
  feature: LinkedFeature;
  /** How many records were asked for. */
  wanted: number;
  /** The library-local ids of the records that were actually built, in
   *  order, read back from each recipe part (for symbols: the INSTANCE
   *  ids, read off the instances' own links). */
  records: string[];
  /** Per built record: an element that carries its link — select it and
   *  the feature's commands resolve the record from the selection. */
  handles: ElementId[];
  /** Symbols only: the one definition every instance points at. */
  symbolId?: string;
}

export interface Workload {
  h: HeadlessHost;
  pageId: string;
  /** The fixture's own leaves, in tree order. */
  fixture: ElementId[];
  plain: ElementId[];
  arrangement: ElementId[];
  /** The 1 000-anchor closed comb. */
  comb: ElementId | null;
  /** The 10 000-anchor open spiral. */
  spiral: ElementId | null;
  /** The face-cap pair, in paint order: the bar, then the small comb in
   *  front of it. Empty until {@link addFaceCapPair} runs. */
  faceCap: ElementId[];
  linked: Partial<Record<LinkedFeature, LinkedRecords>>;
  refusals: WorkloadRefusal[];
  /** `document.mutate` calls the builders issued THEMSELVES (the
   *  commands' own batches are not counted here). */
  batches: number;
}

/** Boot a host, load `fixture` and the bundle. Nothing is authored yet. */
export async function openWorkload(
  fixture: CorpusFixture = F4_OVERLAP,
): Promise<Workload> {
  const h = await openHost();
  await h.load(fixture.bytes());
  h.loadBundle(drawBundle);
  return {
    h,
    pageId: fixture.pageId,
    fixture: await leafIds(h),
    plain: [],
    arrangement: [],
    comb: null,
    spiral: null,
    faceCap: [],
    linked: {},
    refusals: [],
    batches: 0,
  };
}

/** Every leaf id, in tree (= paint) order. */
export async function leafIds(h: HeadlessHost): Promise<ElementId[]> {
  return leafIdsOf(await h.host.document.tree());
}

const describeError = (error: unknown): string => {
  try {
    return typeof error === "string" ? error : (JSON.stringify(error) ?? "?");
  } catch {
    return String(error);
  }
};

/** Insert `paths` in ONE batch, painted with the workload fill, and
 *  answer the ids it minted, in insertion order.
 *
 *  A batch outcome carries one `createdId`, so the ids come from a tree
 *  diff — the same enumeration the bundle's own emitters use, and fine
 *  here because the builder is not what is being measured. The paint
 *  rides the document CREATION DEFAULTS inside the same batch (set,
 *  insert, restore), so the shapes are filled without a second step.
 *  (Measured: with no stroke named, an inserted path still comes back
 *  carrying a 1 pt `Color/Black` stroke — the engine's own default.) */
export async function insertPaths(
  w: Workload,
  what: string,
  paths: readonly PathSpec[],
): Promise<ElementId[]> {
  if (paths.length === 0) return [];
  const meta = await w.h.host.document.meta();
  const defaults = (
    fillColor: string | null,
    strokeColor: string | null,
    strokeWeight: number | null,
  ): Mutation => ({
    op: "setDocumentDefaults",
    args: { fillColor, strokeColor, strokeWeight },
  });
  const ops: Mutation[] = [
    defaults(WORKLOAD_FILL, null, null),
    ...paths.map((p) => insertPathMutationFor(w.pageId, p.anchors, p.open)),
    defaults(
      meta.defaultFillColor ?? null,
      meta.defaultStrokeColor ?? null,
      meta.defaultStrokeWeight ?? null,
    ),
  ];
  const before = new Set((await leafIds(w.h)).map((e) => String(e.id)));
  const batch: MutationInput = { op: "batch", args: { ops } };
  const outcome = await w.h.host.document.mutate(batch);
  w.batches += 1;
  if (!outcome.applied) {
    w.refusals.push({ what, reason: describeError(outcome.error) });
    return [];
  }
  const minted = (await leafIds(w.h)).filter((e) => !before.has(String(e.id)));
  if (minted.length !== paths.length) {
    w.refusals.push({
      what,
      reason: `asked for ${paths.length} paths, the tree shows ${minted.length} new leaves`,
    });
  }
  return minted;
}

/** `count` filled squares in a 25-column grid — the "~500 plain shapes"
 *  every walk-the-document loop has to step over. ONE batch. */
export async function addPlainShapes(
  w: Workload,
  count = 500,
): Promise<ElementId[]> {
  const paths: PathSpec[] = [];
  for (let i = 0; i < count; i++) {
    paths.push(
      rectPath(
        PLAIN.x + (i % PLAIN.columns) * PLAIN.pitch,
        PLAIN.y + Math.floor(i / PLAIN.columns) * PLAIN.pitch,
        PLAIN.size,
        PLAIN.size,
      ),
    );
  }
  const made = await insertPaths(w, `${count} plain shapes`, paths);
  w.plain.push(...made);
  return made;
}

/** The engine's planar-arrangement input cap. */
export const ARRANGEMENT_INPUTS = 12;

/** `inputs` mutually overlapping squares, each offset 5 pt down-right of
 *  the last: every pair of outlines crosses twice, so 12 of them divide
 *  into n(n-1)+1 = 133 faces — the largest arrangement the engine will
 *  ENUMERATE (12 inputs is its cap; 256 faces is the other one). ONE
 *  batch. */
export async function addArrangement(
  w: Workload,
  inputs = ARRANGEMENT_INPUTS,
): Promise<ElementId[]> {
  const paths: PathSpec[] = [];
  for (let i = 0; i < inputs; i++) {
    const o = i * ARRANGEMENT.step;
    paths.push(
      rectPath(ARRANGEMENT.x + o, ARRANGEMENT.y + o, ARRANGEMENT.size, ARRANGEMENT.size),
    );
  }
  const made = await insertPaths(w, `${inputs}-input arrangement`, paths);
  w.arrangement.push(...made);
  return made;
}

/** How many anchors the comb carries. */
export const COMB_ANCHORS = 1000;

/** A point INSIDE the comb's body (below every valley), for a tool that
 *  has to hit it. */
export const COMB_BODY_POINT: Pt = [306, 293];

/** The 1 000-anchor closed comb — the "long path" a real illustration
 *  has plenty of (a traced outline, a pencil stroke simplified too
 *  little). ONE batch. */
export async function addComb(w: Workload, anchors = COMB_ANCHORS): Promise<void> {
  const made = await insertPaths(w, `${anchors}-anchor comb`, [
    combPath(anchors, COMB),
  ]);
  w.comb = made[0] ?? null;
}

/** How many anchors the face-cap comb carries. */
export const FACE_CAP_ANCHORS = 200;

/** The segment a pointer sweeps to cross every tooth of the face-cap
 *  pair: along the middle of the bar. */
export const FACE_CAP_SWEEP: [Pt, Pt] = [
  [FACE_CAP_COMB.x0 + 2, FACE_CAP_BAR.y + FACE_CAP_BAR.h / 2],
  [FACE_CAP_COMB.x1 - 2, FACE_CAP_BAR.y + FACE_CAP_BAR.h / 2],
];

/** The FACE-CAP pair: a 200-anchor comb and a bar across its 99 teeth.
 *  TWO inputs — far under the 12-input cap — that divide into ~300
 *  faces, past the 256-face cap. The engine refuses to ENUMERATE the
 *  arrangement, and a region tool is left with the point query: one
 *  round trip for every pointer move the engine keeps up with.
 *
 *  Why 200 anchors and not the 1 000-anchor comb: the engine takes
 *  ~5 s to refuse that one and ~0.3 s per point query against it
 *  (measured while building this file, 2026-10-02) — a hover budget
 *  over it would spend a minute proving the same count.
 *
 *  The bar goes in FIRST, so the comb paints in front: a region tool
 *  orders its inputs top-to-bottom and reads the FRONTMOST one's anchor
 *  table for its transform, and the scenario wants that read to be the
 *  200-anchor one. ONE batch. */
export async function addFaceCapPair(w: Workload): Promise<ElementId[]> {
  const made = await insertPaths(w, "face-cap bar + comb", [
    rectPath(FACE_CAP_BAR.x, FACE_CAP_BAR.y, FACE_CAP_BAR.w, FACE_CAP_BAR.h),
    combPath(FACE_CAP_ANCHORS, FACE_CAP_COMB),
  ]);
  w.faceCap = made;
  return made;
}

/** How many anchors the spiral carries. */
export const SPIRAL_ANCHORS = 10000;

/** A point ON the spiral (its last anchor), for a tool that has to hit it. */
export function spiralEnd(anchors = SPIRAL_ANCHORS): Pt {
  const last = spiralPath(anchors, SPIRAL.centre, SPIRAL.radius, SPIRAL.turns)
    .anchors[anchors - 1]!;
  return [last.anchor[0], last.anchor[1]];
}

/** The 10 000-anchor open spiral. ONE batch. */
export async function addSpiral(w: Workload, anchors = SPIRAL_ANCHORS): Promise<void> {
  const made = await insertPaths(w, `${anchors}-anchor spiral`, [
    spiralPath(anchors, SPIRAL.centre, SPIRAL.radius, SPIRAL.turns),
  ]);
  w.spiral = made[0] ?? null;
}

// ------------------------------------------------------- linked records

/** `host`, with every WARN / ERROR line a command logs appended to
 *  `sink`. The commands here never throw — a refusal is a logged
 *  sentence and an empty return — so this is how a builder gets the
 *  sentence. */
function withRecordedLog(host: BundleHost, sink: string[]): BundleHost {
  const log: BundleHost["log"] = {
    ...host.log,
    warn: (...args: unknown[]) => void sink.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => void sink.push(args.map(String).join(" ")),
  };
  return new Proxy(host, {
    get: (target, prop, receiver) =>
      prop === "log" ? log : (Reflect.get(target, prop, receiver) as unknown),
  });
}

/** The id of the record a command just appended to its library — read
 *  back from the recipe part, never guessed from the id scheme. */
const lastOf = (records: readonly { id: string }[]): string =>
  records[records.length - 1]?.id ?? "?";

/** Build `count` records of `feature` with the bundle's own commands.
 *
 *  The SOURCE shapes of all `count` records go in as ONE batch; each
 *  record is then one command (two for Live Paint: make the group, fill
 *  a face). A command that returns nothing is a refusal: its last
 *  warning is recorded and the record is left out of `records`. */
export async function addLinkedRecords(
  w: Workload,
  feature: LinkedFeature,
  count = MAX_LINKED_RECORDS,
): Promise<LinkedRecords> {
  if (count > MAX_LINKED_RECORDS) {
    throw new Error(
      `${feature}: the band holds ${MAX_LINKED_RECORDS} records, asked for ${count}`,
    );
  }
  const out: LinkedRecords = { feature, wanted: count, records: [], handles: [] };
  w.linked[feature] = out;
  const warnings: string[] = [];
  const host = withRecordedLog(w.h.host, warnings);
  const refuse = (what: string): void => {
    w.refusals.push({
      what,
      reason: warnings[warnings.length - 1] ?? "the command returned nothing and logged no warning",
    });
  };
  const cells = Array.from({ length: count }, (_, i) => cellOrigin(feature, i));

  switch (feature) {
    case "blend": {
      // Two 6 pt key squares per record, 30 pt apart.
      const keys = await insertPaths(
        w,
        `${count} blend key pairs`,
        cells.flatMap(([x, y]) => [
          rectPath(x + 1, y + 3, 6, 6),
          rectPath(x + 31, y + 3, 6, 6),
        ]),
      );
      for (let i = 0; i + 1 < keys.length; i += 2) {
        await host.selection.set([keys[i]!, keys[i + 1]!]);
        const steps = await applyMakeBlend(host, { steps: 3 });
        if (steps.length === 0) refuse(`blend #${i / 2 + 1}`);
        else {
          out.records.push(lastOf((await readBlendLibrary(host)).blends));
          out.handles.push(keys[i]!);
        }
      }
      break;
    }
    case "repeat": {
      const sources = await insertPaths(
        w,
        `${count} repeat sources`,
        cells.map(([x, y]) => rectPath(x + 1, y + 3, 6, 6)),
      );
      for (const [i, source] of sources.entries()) {
        await host.selection.set([source]);
        const made = await applyMakeRepeat(host, "grid", {
          columns: 3,
          rows: 1,
          spacing: [4, 4],
        });
        if (made.length === 0) refuse(`repeat #${i + 1}`);
        else {
          out.records.push(lastOf((await readRepeatLibrary(host)).repeats));
          out.handles.push(source);
        }
      }
      break;
    }
    case "pattern": {
      const sources = await insertPaths(
        w,
        `${count} pattern sources`,
        cells.map(([x, y]) => rectPath(x + 1, y + 3, 6, 6)),
      );
      for (const [i, source] of sources.entries()) {
        await host.selection.set([source]);
        const made = await applyMakePattern(host, {
          columns: 3,
          rows: 1,
          spacing: [4, 4],
        });
        if (made.length === 0) refuse(`pattern #${i + 1}`);
        else {
          out.records.push(lastOf((await readPatternLibrary(host)).fields));
          out.handles.push(source);
        }
      }
      break;
    }
    case "symbols": {
      // ONE definition, `count` instances: an instance is the linked
      // record here (the definition lives only in the library part).
      const [x0, y0] = cells[0]!;
      const [source] = await insertPaths(w, "symbol source", [
        rectPath(x0 + 1, y0 + 3, 6, 6),
      ]);
      if (!source) break;
      await host.selection.set([source]);
      const symbol = await applyDefineSymbol(host, { name: "Perf symbol" });
      if (!symbol) {
        refuse("symbol definition");
        break;
      }
      out.symbolId = symbol.id;
      for (const [i, [x, y]] of cells.entries()) {
        const leaves = await applyPlaceSymbolInstance(host, symbol.id, {
          x: x + 24,
          y: y + 8,
          pageId: w.pageId,
        });
        const link = leaves[0]
          ? symbolInstanceOf(await host.document.getMetadata(leaves[0]))
          : null;
        if (!leaves[0] || !link) refuse(`symbol instance #${i + 1}`);
        else {
          out.records.push(link.instance);
          out.handles.push(leaves[0]);
        }
      }
      break;
    }
    case "objectsOnPath": {
      // Two 4 pt objects and a 30 pt line to put them on.
      const made = await insertPaths(
        w,
        `${count} objects-on-path triples`,
        cells.flatMap(([x, y]) => [
          rectPath(x + 2, y + 1, 4, 4),
          rectPath(x + 10, y + 1, 4, 4),
          linePath([x + 4, y + 11], [x + 34, y + 11]),
        ]),
      );
      for (let i = 0; i + 2 < made.length; i += 3) {
        await host.selection.set([made[i]!, made[i + 1]!, made[i + 2]!]);
        const moved = await applyMakeObjectsOnPath(host, {});
        if (moved.length === 0) refuse(`objects on path #${i / 3 + 1}`);
        else {
          out.records.push(
            lastOf((await readObjectsOnPathLibrary(host)).associations),
          );
          out.handles.push(made[i]!);
        }
      }
      break;
    }
    case "livePaint": {
      // Two overlapping 8 pt squares; the lens between them gets painted.
      const members = await insertPaths(
        w,
        `${count} live paint member pairs`,
        cells.flatMap(([x, y]) => [
          rectPath(x + 2, y + 2, 8, 8),
          rectPath(x + 6, y + 5, 8, 8),
        ]),
      );
      for (let i = 0; i + 1 < members.length; i += 2) {
        const [x, y] = cells[i / 2]!;
        await host.selection.set([members[i]!, members[i + 1]!]);
        const group = await applyMakeLivePaintGroup(host, {
          name: `Perf group ${i / 2 + 1}`,
        });
        if (!group) {
          refuse(`live paint group #${i / 2 + 1}`);
          continue;
        }
        const painted = await applyFillLivePaintFace(host, {
          groupId: group.id,
          x: x + 8,
          y: y + 7.5,
          fill: WORKLOAD_FILL,
        });
        if (painted.length === 0) {
          refuse(`live paint fill #${i / 2 + 1}`);
          continue;
        }
        out.records.push(group.id);
        out.handles.push(members[i]!);
      }
      break;
    }
  }
  await host.selection.set([]);
  return out;
}

/** The busy document: the fixture, `plain` plain shapes and `records`
 *  linked records of EVERY feature. The plain shapes go in LAST (so they
 *  paint in front): every command that builds a record walks the whole
 *  document, and building 300 records over 500 bystanders would spend
 *  the build walking shapes that have nothing to do with it. */
export async function buildLinkedWorkload(
  options: {
    fixture?: CorpusFixture;
    plain?: number;
    records?: number;
    features?: readonly LinkedFeature[];
  } = {},
): Promise<Workload> {
  const w = await openWorkload(options.fixture);
  for (const feature of options.features ?? LINKED_FEATURES) {
    await addLinkedRecords(w, feature, options.records ?? MAX_LINKED_RECORDS);
  }
  await addPlainShapes(w, options.plain ?? 500);
  await w.h.host.selection.set([]);
  return w;
}

/** The gesture document: the fixture, the plain shapes, the 12-input
 *  arrangement, the 1 000-anchor comb, the 10 000-anchor spiral and the
 *  face-cap pair. FIVE batches. */
export async function buildGestureWorkload(
  options: { fixture?: CorpusFixture; plain?: number } = {},
): Promise<Workload> {
  const w = await openWorkload(options.fixture);
  await addPlainShapes(w, options.plain ?? 500);
  await addArrangement(w);
  await addComb(w);
  await addSpiral(w);
  await addFaceCapPair(w);
  await w.h.host.selection.set([]);
  return w;
}

// ------------------------------------------------------ recipe snapshots

/** Every container part the bundle currently holds, by path. A recipe
 *  part is NOT on the undo stack, so a budget that runs a mutating
 *  command and then undoes it has to put the recipes back itself — or
 *  the next budget inherits a recipe naming elements that no longer
 *  exist. */
export async function snapshotParts(
  h: HeadlessHost,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const path of await h.host.parts.list()) {
    const bytes = await h.host.parts.read(path);
    if (bytes) out.set(path, new Uint8Array(bytes));
  }
  return out;
}

/** Write a {@link snapshotParts} back. */
export async function restoreParts(
  h: HeadlessHost,
  snapshot: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  for (const [path, bytes] of snapshot) {
    await h.host.parts.write(path, new Uint8Array(bytes));
  }
}

// ------------------------------------------------------------ undo steps
//
// AN UNDO STEP IS MEASURED, NEVER DERIVED FROM THE MUTATION COUNT. The
// two differ, and the difference was found here rather than assumed:
// `setDocumentDefaults` applies but never reaches the undo log (measured
// 2026-10-02, engine 0.64.0), so a commit that brackets its inserts with
// a defaults swap issues more mutations than it leaves undo steps.
//
// The measurement rides the raw client, because its replies carry what
// the facade drops: a `mutationApplied` names the `appliedSeq` it was
// logged under, and an `undoApplied` names the `undoneSeq` it reverted.
// So a MARK is one state-neutral, undoable mutation whose seq is kept;
// undo until that seq comes back, and every undo before it was a step
// the measured code left behind.

interface RawReply {
  kind: string;
  payload?: { appliedSeq?: number; undoneSeq?: number };
}

/** Put a mark on the undo stack and answer its seq. The mark re-writes
 *  the first fixture leaf's fill with the value it already has: nothing
 *  changes, no leaf is added (a marker ELEMENT would make every
 *  walk-the-document count one too high), and the engine logs it. */
export async function undoMark(w: Workload): Promise<number> {
  const carrier = w.fixture[0];
  if (!carrier) throw new Error("undoMark: the fixture has no leaf to mark");
  const props = await w.h.host.document.elementProperties(carrier);
  const fill = props?.entries.find((e) => e.path === "frameFillColor")?.value;
  if (!fill || fill.type !== "colorRef") {
    throw new Error("undoMark: the fixture leaf exposes no frameFillColor");
  }
  const reply = (await w.h.host.editor.client.mutate({
    op: "setElementProperty",
    args: {
      elementId: carrier,
      path: "frameFillColor",
      value: { type: "colorRef", value: fill.value },
    },
  })) as RawReply;
  const seq = reply.payload?.appliedSeq;
  if (reply.kind !== "mutationApplied" || typeof seq !== "number") {
    throw new Error(`undoMark: the mark was refused — ${describeError(reply)}`);
  }
  return seq;
}

/** How many undo steps the document gained since `mark` — and take them
 *  all back, the mark included, so the document is exactly as it was
 *  before {@link undoMark}. Throws rather than guessing when the mark
 *  never comes back within `limit` undos. */
export async function undoStepsSince(
  w: Workload,
  mark: number,
  limit = 1000,
): Promise<number> {
  for (let steps = 0; steps <= limit; steps++) {
    const reply = (await w.h.host.editor.client.undo()) as RawReply;
    if (reply.kind !== "undoApplied") {
      throw new Error(
        `undoStepsSince: undo #${steps + 1} was refused before the mark came back — ${describeError(reply)}`,
      );
    }
    const undone = reply.payload?.undoneSeq;
    if (undone === mark) return steps;
    if (typeof undone === "number" && undone < mark) {
      throw new Error(
        `undoStepsSince: undo #${steps + 1} reverted seq ${undone}, OLDER than the mark (${mark}) — the mark is gone`,
      );
    }
  }
  throw new Error(`undoStepsSince: the mark did not come back in ${limit} undos`);
}
