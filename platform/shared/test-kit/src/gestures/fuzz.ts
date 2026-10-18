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

// The GESTURE FUZZER (gestures.md FZ-01, at the engine channel): seeded
// random sequences of begin / update / commit / cancel, with undo and
// redo between them and the odd deliberately wrong message, driven
// through an engine's message channel (the headless host's, or the
// editor's client), with the invariants checked after every step:
//
//   no-panic   the engine never throws (a wasm trap surfaces as a throw);
//   no-error   no `warning`, and a gesture is refused only for a reason
//              the wire names as a user condition (locked, rotated
//              frame unsupported, empty selection, unsupported gesture);
//   finite     every element's bounds and transform stay finite numbers;
//   INV-2      a cancelled gesture leaves the model byte-identical;
//   INV-4      one undo after a commit restores the model exactly, one
//              redo re-applies it exactly;
//   round-trip the document survives IDML save → load: the same
//              elements, each with the same page-space corners.
//
// Everything is a pure function of the seed, so a failure reproduces
// from its seed alone; the report carries the trace too.

import type {
  ElementId,
  MainToWorkerKind,
  WorkerToMain,
} from "@paged-media/plugin-api";
import { engineModelChannel, firstDifference } from "@paged-media/plugin-sdk";

type Send = (message: MainToWorkerKind) => Promise<WorkerToMain>;

/** mulberry32: a small, fast, seedable PRNG (uniform in [0, 1)). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FuzzGestureKind =
  "translate" | "resize" | "rotate" | "scale" | "shear";
const RESIZE_HANDLES = [
  "north",
  "south",
  "east",
  "west",
  "northEast",
  "northWest",
  "southEast",
  "southWest",
] as const;

export type FuzzStep =
  | {
      op: "gesture";
      kind: FuzzGestureKind;
      handle?: (typeof RESIZE_HANDLES)[number];
      nodes: ElementId[];
      anchor: { pageId: string; pointInPage: [number, number] } | null;
      updates: Array<{
        delta: [number, number];
        mods: { shift: boolean; alt: boolean; disableSnap: boolean };
      }>;
      end: "commit" | "cancel";
    }
  | { op: "undo" }
  | { op: "redo" }
  /** An update on a handle that is not open: must be refused, not trap. */
  | { op: "staleUpdate"; handle: number };

export interface FuzzFailure {
  seed: number;
  step: number;
  invariant:
    | "no-panic"
    | "no-error"
    | "finite"
    | "INV-1"
    | "INV-2"
    | "INV-4"
    | "round-trip";
  message: string;
  /** The id of the known finding this failure is an instance of. */
  known?: string;
}

/** A finding already on record: failures whose message matches are
 *  reported under `known`, not `failures`, so the fuzzer keeps hunting
 *  for NEW breakage while a regression test owns the known one. */
export interface KnownFinding {
  id: string;
  invariant: FuzzFailure["invariant"];
  match: RegExp;
}

export interface FuzzReport {
  seed: number;
  trace: FuzzStep[];
  failures: FuzzFailure[];
  /** Instances of known findings (see {@link KnownFinding}). */
  known: FuzzFailure[];
  stats: {
    gestures: number;
    commits: number;
    cancels: number;
    refused: Record<string, number>;
    undos: number;
    redos: number;
  };
}

/** Every element's page-space corners, keyed `kind:id`, with the
 *  magnitude of its stored numbers (Σ|bounds| + |tx| + |ty|), which
 *  bounds what printing them to 4 decimals can move. */
export type GeometryDigest = Map<
  string,
  { corners: Array<[number, number]>; magnitude: number }
>;

export interface GestureFuzzOptions {
  send: Send;
  seed: number;
  /** Steps per sequence (default 8). */
  length?: number;
  /** IDML round trip: export the document, load it in a fresh engine,
   *  and return that engine's geometry. Omit to skip the check. */
  roundTrip?: (idml: Uint8Array) => Promise<GeometryDigest>;
  /** Findings on record, reported apart (see {@link KnownFinding}). */
  known?: readonly KnownFinding[];
}

/** Refusals the wire describes as the user's situation, not a bug. */
const EXPECTED_REFUSALS = new Set([
  "locked",
  "rotatedFrameUnsupported",
  "emptySelection",
  "unsupportedGesture",
]);

const isFinitePoint = (p: readonly number[]) =>
  p.every((n) => typeof n === "number" && Number.isFinite(n));

interface TreeNode {
  id?: ElementId | null;
  kind?: string;
  label?: string;
  children?: TreeNode[];
}

/** The page ids, in document order (the scene tree's Page nodes). */
export async function scenePageIds(send: Send): Promise<string[]> {
  const reply = await send({ kind: "requestSceneTree" });
  if (reply.kind !== "sceneTree")
    throw new Error(`requestSceneTree answered ${reply.kind}`);
  const ids: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.kind === "Page" && n.label) ids.push(n.label);
    for (const c of n.children ?? []) walk(c);
  };
  (reply.payload as { roots: TreeNode[] }).roots.forEach(walk);
  return ids;
}

/** Every element id in the scene tree, in document order. */
export async function sceneElementIds(send: Send): Promise<ElementId[]> {
  const reply = await send({ kind: "requestSceneTree" });
  if (reply.kind !== "sceneTree")
    throw new Error(`requestSceneTree answered ${reply.kind}`);
  const ids: ElementId[] = [];
  const walk = (n: TreeNode) => {
    if (n.id) ids.push(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  (reply.payload as { roots: TreeNode[] }).roots.forEach(walk);
  return ids;
}

interface GeometryItem {
  id: ElementId;
  pageId?: string | null;
  bounds: [number, number, number, number];
  itemTransform?: [number, number, number, number, number, number] | null;
}

async function geometryOf(
  send: Send,
  ids: ElementId[],
): Promise<GeometryItem[]> {
  if (ids.length === 0) return [];
  const reply = await send({
    kind: "requestElementGeometry",
    payload: { ids },
  });
  if (reply.kind !== "elementGeometry")
    throw new Error(`requestElementGeometry answered ${reply.kind}`);
  return (reply.payload as { items: GeometryItem[] }).items;
}

/** The geometry digest of a document: page-space corners per element. */
export async function geometryDigest(send: Send): Promise<GeometryDigest> {
  const items = await geometryOf(send, await sceneElementIds(send));
  const out: GeometryDigest = new Map();
  for (const g of items) {
    const [t, l, b, r] = g.bounds;
    const [a, bb, c, d, tx, ty] = g.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const corner = (x: number, y: number): [number, number] => [
      a * x + c * y + tx,
      bb * x + d * y + ty,
    ];
    out.set(`${g.id.kind}:${JSON.stringify(g.id.id)}`, {
      corners: [corner(l, t), corner(r, t), corner(r, b), corner(l, b)],
      magnitude:
        Math.abs(t) +
        Math.abs(l) +
        Math.abs(b) +
        Math.abs(r) +
        Math.abs(tx) +
        Math.abs(ty),
    });
  }
  return out;
}

/**
 * Compare two digests. Corners compare as a SET (a frame resized past
 * its opposite edge keeps inverted bounds, and a save may write the same
 * rectangle starting from another corner).
 *
 * The verdict separates a PRECISION drift from a move: the IDML writer
 * prints coordinates and transform coefficients to 4 decimals, so a
 * turned item drifts by up to ~1e-4 × its stored numbers per save. A
 * difference within `1e-4 · magnitude + 1e-3` pt is `precision`;
 * anything larger is `moved`. Null when the digests agree to `exact` pt.
 */
export function compareDigests(
  a: GeometryDigest,
  b: GeometryDigest,
  exact = 1e-6,
): { verdict: "missing" | "moved" | "precision"; message: string } | null {
  for (const key of a.keys()) {
    if (!b.has(key))
      return {
        verdict: "missing",
        message: `missing: ${key} is gone after the round trip`,
      };
  }
  for (const key of b.keys()) {
    if (!a.has(key))
      return {
        verdict: "missing",
        message: `missing: ${key} appeared after the round trip`,
      };
  }
  let worst: {
    verdict: "moved" | "precision";
    message: string;
    error: number;
  } | null = null;
  for (const [key, mine] of a) {
    const other = b.get(key)!.corners;
    for (const c of mine.corners) {
      let best = Infinity;
      for (const o of other)
        best = Math.min(
          best,
          Math.max(Math.abs(c[0] - o[0]), Math.abs(c[1] - o[1])),
        );
      if (best <= exact) continue;
      const bound = 1e-4 * mine.magnitude + 1e-3;
      const verdict = best <= bound ? "precision" : "moved";
      if (
        !worst ||
        (verdict === "moved" && worst.verdict === "precision") ||
        (verdict === worst.verdict && best > worst.error)
      ) {
        worst = {
          verdict,
          error: best,
          message: `${verdict}: ${key} corner ${c.join(",")} is ${best.toPrecision(3)} pt from its nearest corner after the round trip${verdict === "precision" ? ` (within the 4-decimal bound ${bound.toPrecision(3)})` : ""}`,
        };
      }
    }
  }
  return worst ? { verdict: worst.verdict, message: worst.message } : null;
}

/** Generate and run one seeded sequence; never throws on a finding (it
 *  is in `failures`), only on a broken harness. */
export async function runGestureFuzz(
  options: GestureFuzzOptions,
): Promise<FuzzReport> {
  const { send, seed } = options;
  const rnd = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const chance = (p: number) => rnd() < p;
  const channel = engineModelChannel(send);
  const report: FuzzReport = {
    seed,
    trace: [],
    failures: [],
    known: [],
    stats: {
      gestures: 0,
      commits: 0,
      cancels: 0,
      refused: {},
      undos: 0,
      redos: 0,
    },
  };
  const fail = (
    step: number,
    invariant: FuzzFailure["invariant"],
    message: string,
  ) => {
    const known = options.known?.find(
      (k) => k.invariant === invariant && k.match.test(message),
    );
    if (known)
      report.known.push({ seed, step, invariant, message, known: known.id });
    else report.failures.push({ seed, step, invariant, message });
  };

  const targets = await sceneElementIds(send);
  if (targets.length === 0)
    throw new Error("fuzz: the document has no elements to gesture on");
  const pages = await scenePageIds(send);

  /** One delta, from a distribution heavy on ordinary drags with tails of
   *  tiny, zero, large and extreme values. */
  const delta = (): [number, number] => {
    const r = rnd();
    const span =
      r < 0.6 ? 80 : r < 0.75 ? 0.001 : r < 0.85 ? 0 : r < 0.95 ? 3000 : 1e5;
    return [(rnd() * 2 - 1) * span, (rnd() * 2 - 1) * span];
  };

  const call = async (
    step: number,
    message: MainToWorkerKind,
  ): Promise<WorkerToMain | null> => {
    try {
      const reply = await send(message);
      if (reply.kind === "warning") {
        fail(
          step,
          "no-error",
          `${message.kind} answered a warning: ${JSON.stringify(reply.payload)}`,
        );
      }
      return reply;
    } catch (err) {
      fail(step, "no-panic", `${message.kind} threw: ${String(err)}`);
      return null;
    }
  };

  const checkFinite = async (step: number) => {
    const items = await geometryOf(send, await sceneElementIds(send));
    for (const g of items) {
      if (
        !isFinitePoint(g.bounds) ||
        (g.itemTransform && !isFinitePoint(g.itemTransform))
      ) {
        fail(
          step,
          "finite",
          `${g.id.kind}:${JSON.stringify(g.id.id)} has bounds ${JSON.stringify(g.bounds)} transform ${JSON.stringify(g.itemTransform)}`,
        );
      }
    }
  };

  const length = options.length ?? 8;
  for (
    let i = 0;
    i < length && !report.failures.some((f) => f.invariant === "no-panic");
    i++
  ) {
    const r = rnd();
    if (r < 0.1) {
      report.trace.push({ op: "undo" });
      report.stats.undos++;
      await call(i, { kind: "undo" });
      continue;
    }
    if (r < 0.18) {
      report.trace.push({ op: "redo" });
      report.stats.redos++;
      await call(i, { kind: "redo" });
      continue;
    }
    if (r < 0.22) {
      const handle = 900_000 + Math.floor(rnd() * 1000);
      report.trace.push({ op: "staleUpdate", handle });
      const reply = await call(i, {
        kind: "updateGesture",
        payload: {
          handle,
          delta: [1, 1],
          modifiers: { shift: false, alt: false },
        },
      });
      if (reply && reply.kind !== "gestureFailed") {
        fail(
          i,
          "no-error",
          `an update on a closed handle answered ${reply.kind}, not gestureFailed`,
        );
      }
      continue;
    }

    const kind = pick<FuzzGestureKind>([
      "translate",
      "translate",
      "resize",
      "resize",
      "rotate",
      "scale",
      "shear",
    ]);
    const nodes = chance(0.2)
      ? [pick(targets), pick(targets)]
      : [pick(targets)];
    const [geo] = await geometryOf(send, [nodes[0]]);
    // Rotate, scale and shear need an anchor; an element pushed onto the
    // pasteboard has no page, so its anchor goes on the first page.
    let anchor: { pageId: string; pointInPage: [number, number] } | null = null;
    if (kind !== "translate" || chance(0.5)) {
      const [t, l, b, rr] = geo?.bounds ?? [0, 0, 100, 100];
      const pageId = geo?.pageId ?? pages[0];
      if (pageId) {
        anchor = {
          pageId,
          pointInPage: [
            l + (rr - l) * (rnd() * 1.4 - 0.2),
            t + (b - t) * (rnd() * 1.4 - 0.2),
          ],
        };
      }
    }
    const updates = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({
      delta: delta(),
      mods: { shift: chance(0.3), alt: chance(0.2), disableSnap: chance(0.5) },
    }));
    const step: FuzzStep = {
      op: "gesture",
      kind,
      ...(kind === "resize" ? { handle: pick(RESIZE_HANDLES) } : {}),
      nodes,
      anchor,
      updates,
      end: chance(0.7) ? "commit" : "cancel",
    };
    report.trace.push(step);
    report.stats.gestures++;

    const before = await channel.dump();
    const gesture =
      kind === "resize" ? { kind, handle: step.handle! } : { kind };
    const begun = await call(i, {
      kind: "beginGesture",
      payload: { nodes, gesture, anchor, cameraScale: 1 },
    } as MainToWorkerKind);
    if (!begun) break;
    if (begun.kind === "gestureFailed") {
      const why = (begun.payload as { error: { kind: string } }).error.kind;
      report.stats.refused[why] = (report.stats.refused[why] ?? 0) + 1;
      if (!EXPECTED_REFUSALS.has(why))
        fail(
          i,
          "no-error",
          `beginGesture refused: ${JSON.stringify(begun.payload)}`,
        );
      const after = await channel.dump();
      if (after !== before)
        fail(
          i,
          "INV-2",
          `a refused begin changed the model ${firstDifference(before, after)}`,
        );
      continue;
    }
    if (begun.kind !== "gestureBegun") {
      fail(i, "no-error", `beginGesture answered ${begun.kind}`);
      continue;
    }
    const handle = (begun.payload as { handle: number }).handle;
    for (const u of updates) {
      const up = await call(i, {
        kind: "updateGesture",
        payload: { handle, delta: u.delta, modifiers: u.mods },
      });
      if (up && up.kind !== "gestureUpdated")
        fail(
          i,
          "no-error",
          `updateGesture answered ${up.kind}: ${JSON.stringify(up.payload)}`,
        );
    }
    if (step.end === "cancel") {
      report.stats.cancels++;
      const done = await call(i, {
        kind: "cancelGesture",
        payload: { handle },
      });
      if (done && done.kind !== "gestureCancelled")
        fail(i, "no-error", `cancelGesture answered ${done.kind}`);
      const after = await channel.dump();
      if (after !== before)
        fail(
          i,
          "INV-2",
          `the cancelled ${kind} changed the model ${firstDifference(before, after)}`,
        );
      continue;
    }
    const done = await call(i, { kind: "commitGesture", payload: { handle } });
    if (!done) break;
    if (done.kind !== "gestureCommitted") {
      fail(
        i,
        "no-error",
        `commitGesture answered ${done.kind}: ${JSON.stringify(done.payload)}`,
      );
      // A commit that fails must commit NOTHING (no partial mutation).
      const after = await channel.dump();
      if (after !== before)
        fail(
          i,
          "INV-1",
          `the failed ${kind} commit changed the model ${firstDifference(before, after)}`,
        );
      continue;
    }
    report.stats.commits++;
    await checkFinite(i);
    const after = await channel.dump();
    if (after === before) continue; // a zero-delta commit: nothing to undo
    try {
      await channel.undo();
      const undone = await channel.dump();
      if (undone !== before)
        fail(
          i,
          "INV-4",
          `one undo did not restore the ${kind} ${firstDifference(before, undone)}`,
        );
      await channel.redo();
      const redone = await channel.dump();
      if (redone !== after)
        fail(
          i,
          "INV-4",
          `redo did not re-apply the ${kind} ${firstDifference(after, redone)}`,
        );
    } catch (err) {
      fail(i, "INV-4", `undo/redo after the ${kind}: ${String(err)}`);
    }
  }

  if (
    options.roundTrip &&
    !report.failures.some((f) => f.invariant === "no-panic")
  ) {
    const reply = await call(length, {
      kind: "exportIdml",
      payload: { linkBase: null },
    });
    if (reply?.kind === "idmlExported") {
      const bytes = Uint8Array.from(
        (reply.payload as { idmlBytes: number[] }).idmlBytes,
      );
      try {
        const diff = compareDigests(
          await geometryDigest(send),
          await options.roundTrip(bytes),
        );
        if (diff) fail(length, "round-trip", diff.message);
      } catch (err) {
        fail(
          length,
          "round-trip",
          `the exported IDML did not load: ${String(err)}`,
        );
      }
    } else if (reply) {
      fail(
        length,
        "round-trip",
        `exportIdml answered ${reply.kind}: ${JSON.stringify(reply.payload).slice(0, 300)}`,
      );
    }
  }
  return report;
}

/** How many sequences per fixture: `PAGED_GESTURE_FUZZ_N`, else `ci`. */
export function fuzzSequenceCount(
  env: Record<string, string | undefined>,
  ci = 25,
): number {
  const n = Number(env.PAGED_GESTURE_FUZZ_N);
  return Number.isInteger(n) && n > 0 ? n : ci;
}
