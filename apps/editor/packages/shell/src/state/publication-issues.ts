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

// The publication's issues, per editor (editor ADR 1223; the UX strategy's
// Concept B, "a visual production health layer"; task DF7). The canvas app
// gathers them from what the engine already reports — missing links and
// low-resolution or RGB images (the links collection), overset stories
// (the stories collection and their frame chains), missing fonts (the
// fonts collection), the last export's preflight findings, and what an
// import could not carry (the compatibility report) — and publishes them
// here; the issue markers draw them on the page, the page overview counts
// them per page, and Publication health lists them with their fixes.
//
// An issue is anchored where it stands: an item (its box on its page), a
// page, or nothing (a missing font is the document's). Activating one
// takes the user there (the camera moves; the view before is kept to
// return to), selects the item, and shows the fixes the engine offers.

import { useSyncExternalStore } from "react";
import type { Camera, ElementId } from "@paged-media/client";

import { scoped, useEditorScope, type EditorScope } from "./editor-scope";

export type IssueKind =
  | "missing-font"
  | "overset"
  | "low-res"
  | "missing-link"
  | "color-space"
  | "missing-data"
  | "import-loss"
  | "output-standard";

export type IssueSeverity = "error" | "warning" | "info";

/** One issue of the publication. */
export interface PublicationIssue {
  /** Stable while the issue lasts (kind + what it is on). */
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  /** What it is, worded ("Missing link: logo.tif"). */
  label: string;
  /** The page it stands on (its id and 0-based index), when it has one. */
  pageId?: string;
  pageIndex?: number;
  /** The item it stands on, when it has one. */
  element?: ElementId;
  /** The item's box on its page, page-local points `[x, y, w, h]`. */
  box?: readonly [number, number, number, number];
}

export interface IssuesSnapshot {
  issues: readonly PublicationIssue[];
  /** The issue the user went to last (its fixes show). */
  active: string | null;
  /** The view before the user went to an issue, to return to. */
  returnView: Camera | null;
}

interface IssuesSlot extends IssuesSnapshot {
  /** How the app goes to an issue (set by the canvas app). */
  activate: ((issue: PublicationIssue) => void) | null;
  listeners: Set<() => void>;
  snapshot: IssuesSnapshot;
}

const ISSUES = scoped("publicationIssues", (): IssuesSlot => ({
  issues: [],
  active: null,
  returnView: null,
  activate: null,
  listeners: new Set(),
  snapshot: { issues: [], active: null, returnView: null },
}));

function emit(slot: IssuesSlot): void {
  slot.snapshot = {
    issues: slot.issues,
    active: slot.active,
    returnView: slot.returnView,
  };
  for (const l of [...slot.listeners]) l();
}

/** The app publishes the issues it gathered (replacing the last set). */
export function setPublicationIssues(
  scope: EditorScope,
  issues: readonly PublicationIssue[],
): void {
  const slot = scope.get(ISSUES);
  slot.issues = issues;
  if (slot.active && !issues.some((i) => i.id === slot.active))
    slot.active = null;
  emit(slot);
}

/** How the app goes to an issue (navigate, select, show its fixes). */
export function setIssueActivator(
  scope: EditorScope,
  activate: ((issue: PublicationIssue) => void) | null,
): void {
  scope.get(ISSUES).activate = activate;
}

/** Go to `issue` (a marker's or a list row's click). */
export function activateIssue(
  scope: EditorScope,
  issue: PublicationIssue,
): void {
  const slot = scope.get(ISSUES);
  slot.active = issue.id;
  emit(slot);
  slot.activate?.(issue);
}

/** Keep the view the user left for an issue (the first one only: going
 *  from issue to issue returns to where the user started). */
export function rememberReturnView(scope: EditorScope, view: Camera): void {
  const slot = scope.get(ISSUES);
  if (slot.returnView) return;
  slot.returnView = view;
  emit(slot);
}

/** Take the kept view (the return button), clearing it. */
export function takeReturnView(scope: EditorScope): Camera | null {
  const slot = scope.get(ISSUES);
  const view = slot.returnView;
  slot.returnView = null;
  slot.active = null;
  emit(slot);
  return view;
}

export function publicationIssuesOf(scope: EditorScope): IssuesSnapshot {
  return scope.get(ISSUES).snapshot;
}

/** This editor's issues, re-read when they change. */
export function usePublicationIssues(): IssuesSnapshot {
  const slot = useEditorScope().get(ISSUES);
  return useSyncExternalStore(
    (l) => {
      slot.listeners.add(l);
      return () => {
        slot.listeners.delete(l);
      };
    },
    () => slot.snapshot,
    () => slot.snapshot,
  );
}

const rank = (s: IssueSeverity) =>
  s === "error" ? 0 : s === "warning" ? 1 : 2;

/** Issues per page index, for the page overview: the worst first. */
export function issuesByPage(
  issues: readonly PublicationIssue[],
): Map<number, PublicationIssue[]> {
  const out = new Map<number, PublicationIssue[]>();
  for (const i of issues) {
    if (i.pageIndex === undefined || i.pageIndex < 0) continue;
    const list = out.get(i.pageIndex) ?? [];
    list.push(i);
    out.set(i.pageIndex, list);
  }
  for (const list of out.values())
    list.sort((a, b) => rank(a.severity) - rank(b.severity));
  return out;
}
