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

// The work counter the perf budgets stand on.
//
// A draw tool's cost is not its geometry — the path algebra lives in the
// engine. It is the DOORS it goes through: every `host.document.*` call
// is a request/reply to the engine worker in the editor, and every
// `mutate` is a document rebuild. So the budgets count door calls, not
// milliseconds: a count is the same on a laptop and a CI runner, and a
// fix that halves it halves it everywhere.
//
// `countingHost(h.host)` wraps a real `BundleHost` in a Proxy that counts
// every function call by its dotted door name (`document.hitTest`,
// `overlay.setToolPreview`, …) and forwards it untouched. Nothing is
// mocked: the engine still answers, so a budget and a behaviour
// assertion can share one gesture.
//
// Hand the WRAPPED host to the handler / command under test. A bundle
// activated through `h.loadBundle` holds the unwrapped host, so its own
// background work is deliberately not counted.

import type { BundleHost } from "@paged-media/plugin-api";

/** One `document.mutate` as the engine saw it. */
export interface CountedMutation {
  /** The op name; `"batch"` for a batch. */
  op: string;
  /** How many ops it carried — 1 unless it is a batch. */
  ops: number;
}

export interface WorkLog {
  /** Calls per door, keyed by dotted path from the host root. */
  readonly calls: Readonly<Record<string, number>>;
  /** Every `document.mutate`, in order. Each one is a rebuild and, unless
   *  the host coalesces, an undo step. */
  readonly mutations: readonly CountedMutation[];
  /** Total points/anchors handed to the overlay across every preview
   *  publish. A handler that re-sends the whole stroke per sample shows
   *  up here as a number growing with the SQUARE of the stroke length. */
  readonly previewPoints: number;
  /** Total anchors the engine handed BACK across every
   *  `document.pathAnchors` reply. A call count cannot tell a 4-anchor
   *  read from a 10 000-anchor one; this can — a tool that re-reads a
   *  long path per move, or reads a whole table to learn one matrix,
   *  shows up here. Counted when the reply lands, so `settle()` first. */
  readonly anchorsRead: number;
  /** Total element ids ASKED of `document.elementGeometry` across every
   *  call — the same idea for the door that takes a list. */
  readonly geometryIdsAsked: number;
  /** Calls to one door (0 when it was never called). */
  count(door: string): number;
  /** Every `document.*` call that is not a write, a history step or a
   *  subscription — i.e. the engine round trips spent READING. */
  reads(): number;
  /** Preview publishes through either overlay door. */
  previews(): number;
  /** Forget everything counted so far (the handler keeps its state). */
  reset(): void;
  /** A frozen copy of the counts as they stand — take it before teardown
   *  (a tool's deactivate clears its preview, which is a publish). */
  snapshot(): WorkLog;
}

const NOT_A_READ = new Set([
  "document.mutate",
  "document.undo",
  "document.redo",
  "document.onDidChange",
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Points in one preview shape: a polyline's `points`, a path's
 *  `anchors`, anything else counts as one. */
const pointsIn = (shape: unknown): number => {
  if (!isPlainObject(shape)) return 0;
  if (Array.isArray(shape.points)) return shape.points.length;
  if (Array.isArray(shape.anchors)) return shape.anchors.length;
  return 1;
};

export function countingHost(host: BundleHost): {
  host: BundleHost;
  work: WorkLog;
} {
  let calls: Record<string, number> = {};
  let mutations: CountedMutation[] = [];
  let previewPoints = 0;
  let anchorsRead = 0;
  let geometryIdsAsked = 0;
  const wrapped = new WeakMap<object, object>();

  /** Count what a reply CARRIED, without touching what the caller sees:
   *  the observer hangs off the same promise the caller awaits. */
  const observe = (door: string, result: unknown): void => {
    if (door !== "document.pathAnchors") return;
    if (!result || typeof (result as PromiseLike<unknown>).then !== "function") {
      return;
    }
    (result as PromiseLike<unknown>).then(
      (table) => {
        const anchors = (table as { anchors?: unknown } | null)?.anchors;
        if (Array.isArray(anchors)) anchorsRead += anchors.length;
      },
      () => {
        /* a refused read carried nothing */
      },
    );
  };

  const note = (door: string, args: unknown[]): void => {
    calls[door] = (calls[door] ?? 0) + 1;
    if (door === "document.elementGeometry") {
      if (Array.isArray(args[0])) geometryIdsAsked += args[0].length;
    } else if (door === "document.mutate") {
      const m = args[0] as { op?: string; args?: { ops?: unknown[] } };
      mutations.push({
        op: m?.op ?? "?",
        ops: m?.op === "batch" ? (m.args?.ops?.length ?? 0) : 1,
      });
    } else if (door === "overlay.setToolPreview") {
      previewPoints += pointsIn(args[0]);
    } else if (door === "overlay.setToolPreviews") {
      const list = Array.isArray(args[0]) ? args[0] : [];
      for (const shape of list) previewPoints += pointsIn(shape);
    } else if (door === "editor.client.send") {
      // The raw escape hatch: also count it per message kind, so a
      // budget can name the request rather than the hatch.
      const kind = (args[0] as { kind?: string })?.kind ?? "?";
      const key = `editor.client.send:${kind}`;
      calls[key] = (calls[key] ?? 0) + 1;
    }
  };

  const wrap = <T extends object>(target: T, path: string): T => {
    const hit = wrapped.get(target);
    if (hit) return hit as T;
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver) as unknown;
        if (typeof prop !== "string") return value;
        const door = path ? `${path}.${prop}` : prop;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            note(door, args);
            const result = Reflect.apply(value, obj, args) as unknown;
            observe(door, result);
            return result;
          };
        }
        return isPlainObject(value) ? wrap(value, door) : value;
      },
    });
    wrapped.set(target, proxy);
    return proxy;
  };

  const logOver = (state: {
    calls: () => Record<string, number>;
    mutations: () => CountedMutation[];
    previewPoints: () => number;
    anchorsRead: () => number;
    geometryIdsAsked: () => number;
    reset: () => void;
  }): WorkLog => ({
    get calls() {
      return state.calls();
    },
    get mutations() {
      return state.mutations();
    },
    get previewPoints() {
      return state.previewPoints();
    },
    get anchorsRead() {
      return state.anchorsRead();
    },
    get geometryIdsAsked() {
      return state.geometryIdsAsked();
    },
    count: (door) => state.calls()[door] ?? 0,
    reads: () =>
      Object.entries(state.calls())
        .filter(([k]) => k.startsWith("document.") && !NOT_A_READ.has(k))
        .reduce((n, [, v]) => n + v, 0),
    previews: () =>
      (state.calls()["overlay.setToolPreview"] ?? 0) +
      (state.calls()["overlay.setToolPreviews"] ?? 0),
    reset: state.reset,
    snapshot: () => {
      const frozen = {
        calls: { ...state.calls() },
        mutations: [...state.mutations()],
        previewPoints: state.previewPoints(),
        anchorsRead: state.anchorsRead(),
        geometryIdsAsked: state.geometryIdsAsked(),
      };
      return logOver({
        calls: () => frozen.calls,
        mutations: () => frozen.mutations,
        previewPoints: () => frozen.previewPoints,
        anchorsRead: () => frozen.anchorsRead,
        geometryIdsAsked: () => frozen.geometryIdsAsked,
        reset: () => {
          /* a snapshot is frozen */
        },
      });
    },
  });

  const work = logOver({
    calls: () => calls,
    mutations: () => mutations,
    previewPoints: () => previewPoints,
    anchorsRead: () => anchorsRead,
    geometryIdsAsked: () => geometryIdsAsked,
    reset: () => {
      calls = {};
      mutations = [];
      previewPoints = 0;
      anchorsRead = 0;
      geometryIdsAsked = 0;
    },
  });

  return { host: wrap(host as unknown as object, "") as BundleHost, work };
}

/** The per-test timeout the budget specs set (`vi.setConfig`). A count
 *  does not get slower on a loaded CI runner; the wall clock around it
 *  does, and the slowest scenario here is ~2.5 s on a quiet laptop —
 *  half of vitest's 5 s default. No budget is a duration, so a generous
 *  timeout hides nothing. */
export const BUDGET_TIMEOUT_MS = 60_000;

/** The whole log as one plain object — every door, not only the ones a
 *  budget names. */
export function workSummary(work: WorkLog): Record<string, unknown> {
  const calls: Record<string, number> = {};
  for (const door of Object.keys(work.calls).sort()) {
    calls[door] = work.calls[door]!;
  }
  return {
    calls,
    reads: work.reads(),
    previews: work.previews(),
    previewPoints: work.previewPoints,
    anchorsRead: work.anchorsRead,
    geometryIdsAsked: work.geometryIdsAsked,
    mutations: work.mutations.map((m) =>
      m.op === "batch" ? `batch(${m.ops})` : m.op,
    ),
  };
}

/** HOW TO RE-MEASURE. Run the perf specs with `PERF_SHOW=1` and every
 *  scenario prints its full work log on one `PERF` line — the numbers a
 *  budget is pinned from, and the place to look when one moves. Silent
 *  otherwise. `extra` carries what a scenario measured beside the log
 *  (its undo steps, the document's leaf count). Returns `work` so a
 *  scenario can report and hand back in one expression. */
export function report(
  scenario: string,
  work: WorkLog,
  extra: Record<string, unknown> = {},
): WorkLog {
  if (process.env.PERF_SHOW) {
    // eslint-disable-next-line no-console
    console.log(
      `PERF ${scenario} ${JSON.stringify({ ...workSummary(work), ...extra })}`,
    );
  }
  return work;
}
