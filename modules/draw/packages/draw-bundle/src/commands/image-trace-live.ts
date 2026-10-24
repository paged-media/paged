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

// LIVE RE-TRACE (WP6.6) — a trace made with `live: true` follows its
// image: when the source frame's LINK changes (relinked, its bytes
// replaced, its placement refitted), the trace is re-run with the options
// its record keeps and the result replaced INSIDE the edit's undo step.
//
// It rides the recipe auto-update's machinery (engine ADR 1004, the step
// amend: `recipe-auto-update.ts`'s `runInStep`), so the same rules hold:
//   · one undo reverts the relink AND the re-trace; an undo or redo is
//     never followed by a re-trace (the step already restored both);
//   · the re-trace's own commits never start another;
//   · when the edit is no longer the last step by the time the trace has
//     run (a trace takes time — it decodes and traces the new pixels), the
//     engine refuses the amend, nothing is written, and the log says to
//     run Re-trace by hand;
//   · it is off with the recipe auto-update (`recipes.autoUpdate`), and
//     absent on a host without `document.mutate.amend@1`.
//
// WHAT IS WATCHED, and what it costs. A document with no placed image
// pays one `links` collection read per committed change and nothing
// else. With images, the LIVE traces are found in the shared link index
// (one walk per revision, shared with every panel), and each live
// source is printed: its `links` row (uri, placement, status) AND a
// fingerprint of its bytes (length + FNV-1a over a sample), because
// replacing an image's bytes in place (`replaceImageBytes`) leaves the
// row exactly as it was — measured. Only a live source whose print moved
// is traced again; a source that is not live is never read.

import type {
  BundleHost,
  Disposable,
  DocumentChangeEvent,
  ElementId,
} from "@paged-media/plugin-api";

import { applyRetraceImage, imageTraceOf } from "./image-trace";
import {
  RECIPE_AUTO_UPDATE_FEATURE,
  recipeAutoUpdateEnabled,
  runInStep,
} from "./recipe-auto-update";
import { leafIdsOf, linkIndex } from "../link-index";

/** The `links` row fields the watch compares (the contract's
 *  `LinkSummary`; any field that changes counts). */
export interface WatchedLinkRow {
  hostSelfId: string;
  uri?: string;
  [field: string]: unknown;
}

/** Each frame's link row, printed. Pure. */
export function linkPrintsOf(
  rows: readonly WatchedLinkRow[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (typeof row?.hostSelfId !== "string") continue;
    out.set(row.hostSelfId, JSON.stringify(row));
  }
  return out;
}

/** A cheap fingerprint of encoded image bytes: the length and FNV-1a
 *  over at most 64 KiB sampled evenly. Pure. */
export function bytesPrint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  const n = bytes.length;
  const step = Math.max(1, Math.floor(n / 65536));
  for (let i = 0; i < n; i += step) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${n}:${hash.toString(16)}`;
}

/** The frames whose row changed between two prints (a frame that
 *  appeared or vanished is not a change of ITS link). Pure. */
export function changedLinks(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const [id, print] of after) {
    const was = before.get(id);
    if (was !== undefined && was !== print) out.push(id);
  }
  return out;
}

export interface LiveRetrace extends Disposable {
  /** Resolves once every change reported so far has been handled. */
  idle(): Promise<void>;
  /** The frames the last automatic re-trace rebuilt (element ids). */
  lastRetraced(): readonly string[];
}

const handles = new WeakMap<object, LiveRetrace>();

/** The live re-trace running for `host` (a test awaits its `idle`). */
export function liveRetraceOf(host: BundleHost): LiveRetrace | undefined {
  return handles.get(host);
}

export function contributeLiveRetrace(host: BundleHost): LiveRetrace {
  let retraced: readonly string[] = [];
  if (!host.supports(RECIPE_AUTO_UPDATE_FEATURE)) {
    return {
      dispose() {},
      idle: () => Promise.resolve(),
      lastRetraced: () => retraced,
    };
  }
  let prints: Map<string, string> | null = null;
  const own = new Set<number>();
  let running: Promise<void> = Promise.resolve();
  let disposed = false;

  /** The LIVE trace sources, by element id (`selfId` → id). */
  const liveSources = async (): Promise<Map<string, ElementId>> => {
    const out = new Map<string, ElementId>();
    const { linked } = await linkIndex(host).snapshot();
    for (const { id, envelope } of linked) {
      if (imageTraceOf(envelope)?.live) out.set(String(id.id), id);
    }
    return out;
  };

  /** Each live source's print: its link row and its bytes. */
  const readPrints = async (): Promise<Map<string, string> | null> => {
    let rows: readonly WatchedLinkRow[];
    try {
      rows = await host.document.collection<WatchedLinkRow>("links");
    } catch {
      return null;
    }
    const out = new Map<string, string>();
    if (rows.length === 0) return out;
    const sources = await liveSources();
    if (sources.size === 0) return out;
    const byRow = linkPrintsOf(rows);
    for (const selfId of sources.keys()) {
      const asset = await host.assets.getPlacedImage(selfId).catch(() => null);
      out.set(
        selfId,
        `${byRow.get(selfId) ?? ""}|${asset ? bytesPrint(asset.bytes) : "-"}`,
      );
    }
    return out;
  };

  const elementOf = async (selfId: string): Promise<ElementId | null> => {
    const sources = await liveSources();
    if (sources.has(selfId)) return sources.get(selfId)!;
    const tree = await linkIndex(host).tree();
    return leafIdsOf(tree).find((l) => String(l.id) === selfId) ?? null;
  };

  const handle = async (change: DocumentChangeEvent): Promise<void> => {
    if (!recipeAutoUpdateEnabled(host)) {
      prints = null;
      return;
    }
    const now = await readPrints();
    if (!now) return;
    const seq =
      change.kind === "undoApplied" || change.kind === "redoApplied"
        ? null
        : (change.appliedSeq ?? null);
    const before = prints;
    prints = now;
    if (before === null || seq === null) return;
    const changed = changedLinks(before, now);
    if (changed.length === 0) return;
    const done: string[] = [];
    let step = seq;
    for (const selfId of changed) {
      const id = await elementOf(selfId);
      if (!id) continue;
      const record = imageTraceOf(
        await host.document.getMetadata(id).catch(() => null),
      );
      if (!record?.live) continue;
      const run = await runInStep(
        host,
        step,
        (view) => applyRetraceImage(view, { sourceId: id }),
        own,
      );
      step = run.appliedSeq;
      if (run.refused !== null) {
        host.log.info(
          "image trace: the edit is no longer the last step, so the live " +
            "trace was not re-run with it — run Re-trace",
        );
        break;
      }
      if (run.result.length > 0) done.push(selfId);
    }
    retraced = done;
    prints = (await readPrints()) ?? prints;
  };

  const sub = host.document.onDidChange((change) => {
    if (disposed) return;
    if (typeof change.appliedSeq === "number" && own.has(change.appliedSeq)) {
      return;
    }
    running = running.then(
      () =>
        new Promise<void>((resolve) => {
          // After the commit's own reply has resolved.
          setTimeout(() => {
            handle(change).then(resolve, (e) => {
              host.log.debug(
                `image trace: live re-trace skipped (${String(e)})`,
              );
              resolve();
            });
          }, 0);
        }),
    );
  });
  const opened = host.document.onDidOpen(() => {
    prints = null;
  });
  // The first prints, so the first relink already has something to compare.
  running = running.then(async () => {
    prints = await readPrints();
  });

  const live: LiveRetrace = {
    dispose() {
      disposed = true;
      handles.delete(host);
      sub.dispose();
      opened.dispose();
    },
    idle: () => running,
    lastRetraced: () => retraced,
  };
  handles.set(host, live);
  return live;
}
