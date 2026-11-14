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

// The design constraints, evaluated continuously (editor ADR 1233): when the
// document changes (an edit, an undo, a gesture's commit, a load), after
// a short pause, the constraints standing on the pages in view are measured
// and published first, the rest when the editor is idle. A constraint that
// does not hold joins the publication's issues (editor ADR 1223), where its
// fix waits for the user. Mounted once, by the canvas app.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  changesTheDocument,
  viewportToDoc,
  type ElementId,
  type PageSummary,
  type StorySummary,
} from "@paged-media/client";
import {
  editorRootOf,
  queryEditor,
  scopeOf,
  setPublicationIssues,
  useCanvasClient,
  useCollection,
  useDocumentMeta,
  useEditorScope,
  usePaged,
  type EditorScope,
  type PagedEditor,
  type PublicationIssue,
} from "@paged-media/shell";

import { layoutPages } from "../ui/layout";
import {
  evaluateConstraints,
  type ConstraintResult,
  type PageFacts,
} from "./evaluate";
import { issueLabel } from "./describe";
import { measureFacts, pageFactsOf, readGeometry, membersOf } from "./measure";
import { constraintsOfMeta, memberKey, type Constraint } from "./model";
import { constraintStateOf, setConstraintState } from "./store";

/** The pause after the last change before measuring, ms. */
export const CONSTRAINT_DEBOUNCE_MS = 150;

/** The issue source name in the publication's issue set. */
export const CONSTRAINT_ISSUES = "constraints";

/** The id of a constraint's issue. */
export const constraintIssueId = (id: string): string => `constraint:${id}`;

/** The pages in the editor's view, by id; null when the view is unknown
 *  (every page counts as in view then). */
export function pagesInView(paged: PagedEditor): Set<string> | null {
  const handle = paged.document.handle;
  const cam = paged.camera.camera;
  if (!handle || !(cam.scale > 0)) return null;
  const viewport = queryEditor(
    editorRootOf(scopeOf(paged)),
    "[data-paged-viewport]",
  );
  const r = viewport?.getBoundingClientRect();
  if (!r || !(r.width > 0) || !(r.height > 0)) return null;
  const corners = [
    viewportToDoc(cam, 0, 0),
    viewportToDoc(cam, r.width, 0),
    viewportToDoc(cam, r.width, r.height),
    viewportToDoc(cam, 0, r.height),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const [x0, x1, y0, y1] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const rects = layoutPages(handle.pageSizesPt, handle.pageOriginsPt);
  const out = new Set<string>();
  rects.forEach((p, i) => {
    if (p.x <= x1 && p.x + p.w >= x0 && p.y <= y1 && p.y + p.h >= y0)
      out.add(handle.pageIds[i]!);
  });
  return out;
}

/** The issues of the constraints that do not hold, or cannot be read
 *  because an item they name is gone. */
export function constraintIssues(
  constraints: readonly Constraint[],
  results: ReadonlyMap<string, ConstraintResult>,
  pageIndex: (pageId: string) => number,
  len?: (pt: number) => string,
): PublicationIssue[] {
  const out: PublicationIssue[] = [];
  for (const c of constraints) {
    const r = results.get(c.id);
    if (!r) continue;
    const broken = r.status === "broken";
    const gone = r.status === "unknown" && r.reason === "missing-member";
    if (!broken && !gone) continue;
    const at = r.boxes.find((b) => b !== null) ?? null;
    const element = c.members.find((_, i) => r.boxes[i]) as
      ElementId | undefined;
    const issue: PublicationIssue = {
      id: constraintIssueId(c.id),
      kind: "constraint",
      severity: broken ? "warning" : "info",
      label: issueLabel(c, r, len),
    };
    if (at && element) {
      issue.element = element;
      issue.pageId = at.pageId;
      issue.pageIndex = pageIndex(at.pageId);
      issue.box = at.box;
    }
    out.push(issue);
  }
  return out;
}

/** Measure `constraints` (those on `inView` first) and publish each pass.
 *  `live()` says whether this run is still the newest. */
export async function runConstraintPass(
  scope: EditorScope,
  client: Parameters<typeof measureFacts>[0] &
    Parameters<typeof readGeometry>[0],
  constraints: readonly Constraint[],
  pages: ReadonlyMap<string, PageFacts>,
  stories: readonly StorySummary[] | null,
  inView: ReadonlySet<string> | null,
  live: () => boolean,
  idle: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<void> {
  const publish = (
    results: Map<string, ConstraintResult>,
    pending: boolean,
  ) => {
    setConstraintState(scope, { constraints, results, pending });
    const index = (id: string) => pages.get(id)?.index ?? -1;
    setPublicationIssues(
      scope,
      constraintIssues(constraints, results, index),
      CONSTRAINT_ISSUES,
    );
  };
  if (constraints.length === 0) {
    publish(new Map(), false);
    return;
  }
  const previous = constraintStateOf(scope).results;
  setConstraintState(scope, { constraints, results: previous, pending: true });
  const geometry = await readGeometry(client, membersOf(constraints));
  if (!live()) return;
  const onView = (c: Constraint) => {
    if (!inView) return true;
    const g = geometry.get(memberKey(c.members[0]!));
    return Boolean(g?.pageId && inView.has(g.pageId));
  };
  const first = constraints.filter(onView);
  const rest = constraints.filter((c) => !onView(c));
  const results = new Map<string, ConstraintResult>();
  // Results of the last measurement stand in for the rest until measured.
  for (const c of rest) {
    const r = previous.get(c.id);
    if (r) results.set(c.id, r);
  }
  const firstFacts = await measureFacts(client, first, pages, stories, {
    geometry,
  });
  if (!live()) return;
  for (const r of evaluateConstraints(first, firstFacts)) results.set(r.id, r);
  if (rest.length === 0) {
    publish(results, false);
    return;
  }
  publish(results, true);
  await idle();
  if (!live()) return;
  const restFacts = await measureFacts(client, rest, pages, stories, {
    geometry,
  });
  if (!live()) return;
  for (const r of evaluateConstraints(rest, restFacts)) results.set(r.id, r);
  publish(new Map(results), false);
}

const idleTick = (): Promise<void> =>
  new Promise((resolve) => {
    const ric = (
      globalThis as {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
      }
    ).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, 0);
  });

/** Evaluate this editor's design constraints whenever the document changes.
 *  Mounted once, by the canvas app. */
export function useDesignConstraintsSource(): void {
  const scope = useEditorScope();
  const client = useCanvasClient();
  const paged = usePaged();
  const meta = useDocumentMeta();
  const pages = useCollection<PageSummary>("pages");
  const stories = useCollection<StorySummary>("stories");
  // The inputs as data: the effect runs again when one of them changes.
  const inputs = JSON.stringify({
    constraints: constraintsOfMeta(meta),
    pages: [...pageFactsOf(pages ?? []).values()],
    stories:
      stories?.map((s) => ({
        selfId: s.selfId,
        overset: Boolean(s.overset),
        characterCount: s.characterCount,
      })) ?? null,
  });
  const [revision, setRevision] = useState(0);
  useEffect(
    () =>
      client.subscribe((msg) => {
        if (changesTheDocument(msg)) setRevision((n) => n + 1);
      }),
    [client],
  );
  // The live editor, for the camera at the time a run starts (ADR 229: the
  // latest value written in a layout effect, read in the effect).
  const editor = useRef(paged);
  useLayoutEffect(() => {
    editor.current = paged;
  });
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      const parsed = JSON.parse(inputs) as {
        constraints: Constraint[];
        pages: PageFacts[];
        stories: StorySummary[] | null;
      };
      void runConstraintPass(
        scope,
        client,
        parsed.constraints,
        new Map(parsed.pages.map((p) => [p.id, p])),
        parsed.stories,
        pagesInView(editor.current),
        () => live,
        idleTick,
      );
    }, CONSTRAINT_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [inputs, revision, client, scope]);
}
