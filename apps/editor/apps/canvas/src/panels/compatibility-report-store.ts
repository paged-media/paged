/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The compatibility reports of one editor (editor ADR 1222). Two doors in:
//
//   · RECORDED — an operation of the editor records its report directly:
//     the document load's import losses and the IDML export's `lost`
//     (protocol 80), the editor's own SVG import.
//   · DERIVED — a bundle's loss rows on the diagnostics channel (the SDK's
//     `lossDiagnostics` carries each `LossEntry` as `loss`, extensions ADR
//     1106): every (bundle, key) set with losses is one report, so
//     paged.slide's PowerPoint import, paged.doc's Word placement and
//     paged.pdf's vectors land in the same report as the engine's own.
//
// A new or changed report says its summary once, as a prominent result
// with "View report" (the operation feedback's toast channel; the UX
// strategy's §6.4). The panel reads `useCompatReports`.

import { useSyncExternalStore } from "react";

import type { LossEntry } from "@paged-media/plugin-api";
import {
  operationFeedbackOf,
  scoped,
  useEditorScope,
  type EditorScope,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import {
  operationOfKey,
  summaryLine,
  type CompatReport,
} from "./compatibility-report";
import { problemsOf, type ProblemEntry } from "./problems-store";

/** The report panel's id (the panel registry derives `paged.panel.show.*`). */
export const COMPAT_REPORT_PANEL = "paged.import-report";

const M = defineMessages("app.compatibilityReport", {
  viewReport: "View report",
  importAction: "import {name}",
});

interface CompatStore {
  recorded: Map<string, CompatReport>;
  /** The derived reports' last signature, so a toast says each once. */
  announced: Map<string, string>;
  snapshot: readonly CompatReport[];
  listeners: Set<() => void>;
  watching: boolean;
}

const COMPAT = scoped("compatibilityReports", (): CompatStore => ({
  recorded: new Map(),
  announced: new Map(),
  snapshot: [],
  listeners: new Set(),
  watching: false,
}));

/** The derived reports: one per bundle's keyed set with loss rows. */
export function reportsFromProblems(
  entries: readonly ProblemEntry[],
  at: number,
): CompatReport[] {
  const sets = new Map<
    string,
    { bundleId: string; key: string; losses: LossEntry[] }
  >();
  for (const e of entries) {
    if (!e.loss) continue;
    const id = `${e.bundleId}|${e.key}`;
    let set = sets.get(id);
    if (!set) {
      set = { bundleId: e.bundleId, key: e.key, losses: [] };
      sets.set(id, set);
    }
    set.losses.push(e.loss);
  }
  return [...sets.entries()].map(([id, set]) => {
    const op = operationOfKey(set.bundleId, set.key);
    return {
      id,
      direction: op.direction,
      format: op.format,
      at,
      losses: set.losses,
      source: set.bundleId,
    };
  });
}

const signature = (r: CompatReport) =>
  JSON.stringify([r.name ?? "", r.losses.map((l) => [l.code, l.count])]);

function rebuild(scope: EditorScope): void {
  const store = scope.get(COMPAT);
  const derived = reportsFromProblems(
    problemsOf(scope).snapshot(),
    Date.now(),
  ).filter((r) => !store.recorded.has(r.id));
  // A derived report keeps the time it first appeared with these losses.
  const previous = new Map(store.snapshot.map((r) => [r.id, r]));
  const next = [
    ...derived.map((r) => {
      const was = previous.get(r.id);
      return was && signature(was) === signature(r) ? was : r;
    }),
    ...store.recorded.values(),
  ].sort((a, b) => b.at - a.at);
  for (const r of derived) announce(scope, r);
  store.snapshot = next;
  for (const l of [...store.listeners]) l();
}

/** Say a report's summary once per content (a toast with View report). */
function announce(scope: EditorScope, report: CompatReport): void {
  const store = scope.get(COMPAT);
  const sig = signature(report);
  if (store.announced.get(report.id) === sig) return;
  store.announced.set(report.id, sig);
  if (report.losses.length === 0) return;
  operationFeedbackOf(scope).report({
    action: t(M.importAction, { name: report.name ?? report.format }),
    outcome: "success",
    title: summaryLine(report),
    prominent: true,
    actions: [
      {
        label: t(M.viewReport),
        command: `paged.panel.show.${COMPAT_REPORT_PANEL}`,
      },
    ],
    key: `paged.compat|${report.id}`,
    source: report.source,
  });
}

/** Follow `scope`'s problems for bundles' loss rows (once per editor). */
export function watchCompatibility(scope: EditorScope): () => void {
  const store = scope.get(COMPAT);
  if (store.watching) return () => {};
  store.watching = true;
  const off = problemsOf(scope).subscribe(() => rebuild(scope));
  rebuild(scope);
  return () => {
    off();
    store.watching = false;
  };
}

/** Record an operation's report (replaces the one with its id). */
export function recordCompatReport(
  scope: EditorScope,
  report: Omit<CompatReport, "at"> & { at?: number },
): void {
  const store = scope.get(COMPAT);
  const full: CompatReport = { ...report, at: report.at ?? Date.now() };
  store.recorded.set(full.id, full);
  announce(scope, full);
  rebuild(scope);
}

/** The report of a document load (protocol 80, engine ADR 1305): one per
 *  editor, replaced by the next open; a document that opened whole clears
 *  it. The format is the file's (`.idml`; a `.paged` reports what its
 *  IDML half did not carry). */
export function recordDocumentImport(
  scope: EditorScope,
  name: string,
  losses: readonly LossEntry[],
): void {
  const id = "paged.document|import";
  if (losses.length === 0) {
    clearCompatReport(scope, id);
    return;
  }
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "idml";
  recordCompatReport(scope, {
    id,
    direction: "import",
    format: ext === "paged" ? "idml" : ext,
    name,
    losses,
    source: "paged.document",
  });
}

/** Forget a report (its document closed, the user cleared it). */
export function clearCompatReport(scope: EditorScope, id: string): void {
  const store = scope.get(COMPAT);
  store.recorded.delete(id);
  rebuild(scope);
}

/** `scope`'s reports, newest first. */
export function compatReportsOf(scope: EditorScope): readonly CompatReport[] {
  return scope.get(COMPAT).snapshot;
}

/** This editor's reports, re-read when they change. */
export function useCompatReports(): readonly CompatReport[] {
  const scope = useEditorScope();
  const store = scope.get(COMPAT);
  return useSyncExternalStore(
    (l) => {
      store.listeners.add(l);
      return () => {
        store.listeners.delete(l);
      };
    },
    () => store.snapshot,
    () => store.snapshot,
  );
}
