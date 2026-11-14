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

// The publication's issues, gathered (editor ADR 1223; task DF7): the
// canvas app reads what the engine already reports and publishes it to
// the shell's issue store (`setPublicationIssues`), where the issue
// markers, the page overview and Publication health read it. Nothing here
// asks the engine for anything new:
//
//   · links (`LinkSummary`): a missing link (error), a picture below 150
//     effective ppi (warning), an RGB picture in a CMYK document (note) —
//     on the frame that holds it;
//   · stories (`StorySummary.overset`): an overset story — on the last
//     frame of its chain (`frameChain`, the link marked `overflow`);
//   · fonts (`FontSummary.isMissing`): a missing font — the document's,
//     on no page;
//   · the last export's preflight findings (`PreflightFinding.pageIndex`):
//     an output-standard finding — on its page;
//   · the compatibility report (editor ADR 1222): what an import left out
//     or converted, on the pages and items it names;
//   · paged.data's issues on the diagnostics channel: missing data — the
//     document's.
//
// Going to an issue keeps the view to return to, moves the camera there,
// selects the item, and opens Publication health, where its fixes are.

import { useEffect, useState, useSyncExternalStore } from "react";

import type {
  CanvasClient,
  ElementId,
  FontSummary,
  LinkSummary,
  StorySummary,
} from "@paged-media/client";
import {
  rememberReturnView,
  setIssueActivator,
  setPublicationIssues,
  useCanvasClient,
  useCockpitActions,
  useCollection,
  useDocumentMeta,
  useEditorScope,
  usePaged,
  useRegistries,
  type PagedEditor,
  type PublicationIssue,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

import { usePreflightFindings } from "./panels/cockpit/preflight-findings";
import { useCompatReports } from "./panels/compatibility-report-store";
import { useProblems } from "./panels/problems-store";
import { revealItems, revealPage } from "./reveal-targets";

const M = defineMessages("app.publicationIssues", {
  missingLink: "Missing link: {name}",
  lowRes: "Low-resolution picture: {name} ({ppi} ppi)",
  rgb: "RGB picture in a CMYK document: {name}",
  overset: "Overset text",
  missingFont: "Missing font: {family}",
  importLoss: "Import: {what}",
  missingData: "Missing data: {what}",
});

/** The editor's low-resolution floor (Publication health's). */
export const LOW_RES_PPI = 150;

/** The panel that lists the issues with their fixes. */
export const HEALTH_PANEL = "paged.publication-health";

function fileName(uri: string): string {
  const path = uri.replace(/[?#].*$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name) || uri;
  } catch {
    return name || uri;
  }
}

/** A link's host frame as an element id (`LinkSummary.hostKind` is the
 *  parse-side kind: "Rectangle", "Oval", "Polygon", "GraphicLine"). */
export function hostElement(link: LinkSummary): ElementId | null {
  switch (link.hostKind) {
    case "Rectangle":
      return { kind: "rectangle", id: link.hostSelfId };
    case "Oval":
      return { kind: "oval", id: link.hostSelfId };
    case "Polygon":
      return { kind: "polygon", id: link.hostSelfId };
    case "GraphicLine":
      return { kind: "graphicLine", id: link.hostSelfId };
    default:
      return null;
  }
}

/** What an issue stands on before it is placed. */
interface Pending extends PublicationIssue {
  /** An overset story's id (its last frame is found through the chain). */
  storyId?: string;
}

/** Place each issue on its item's page and box (one geometry read). */
async function place(
  client: CanvasClient,
  pageIds: readonly string[],
  pending: Pending[],
): Promise<PublicationIssue[]> {
  // An overset story stands on the frame its text overflows from.
  for (const p of pending) {
    if (!p.storyId) continue;
    try {
      const chain = await client.frameChain(p.storyId);
      const tail = chain.find((l) => l.overflow) ?? chain.at(-1);
      if (tail) p.element = { kind: "textFrame", id: tail.frameId };
    } catch {
      /* the story stays the document's */
    }
  }
  const withItem = pending.filter((p) => p.element);
  if (withItem.length > 0) {
    try {
      const geometry = await client.elementGeometry(
        withItem.map((p) => p.element!),
      );
      withItem.forEach((p, i) => {
        const g = geometry[i];
        if (!g?.pageId || g.bounds.length < 4) return;
        const [top, left, bottom, right] = g.bounds as [
          number,
          number,
          number,
          number,
        ];
        const [, , , , tx, ty] = (g.itemTransform ?? [1, 0, 0, 1, 0, 0]) as [
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        p.pageId = g.pageId;
        p.pageIndex = pageIds.indexOf(g.pageId);
        p.box = [left + tx, top + ty, right - left, bottom - top];
      });
    } catch {
      /* unplaced issues stay listed, with no marker */
    }
  }
  return pending.map(({ storyId: _story, ...issue }) => issue);
}

/** Gather and publish this editor's issues; set how the app goes to one.
 *  Mounted once, by the canvas app. */
export function usePublicationIssuesSource(): void {
  const scope = useEditorScope();
  const client = useCanvasClient();
  const strings = useStrings();
  const paged = usePaged();
  const registries = useRegistries();
  const actions = useCockpitActions();
  const meta = useDocumentMeta();
  const links = useCollection<LinkSummary>("links");
  const fonts = useCollection<FontSummary>("fonts");
  const stories = useCollection<StorySummary>("stories");
  const { findings } = usePreflightFindings(client);
  const reports = useCompatReports();
  const problemsStore = useProblems();
  const problems = useSyncExternalStore(
    problemsStore.subscribe,
    problemsStore.snapshot,
    problemsStore.snapshot,
  );
  const pageIds = paged.document.handle?.pageIds ?? [];

  const pending: Pending[] = [];
  const cmyk = (meta?.colorMode ?? "").toLowerCase() === "cmyk";
  for (const l of links ?? []) {
    const element = hostElement(l) ?? undefined;
    const name = fileName(l.uri);
    if (l.status === "missing")
      pending.push({
        id: `missing-link:${l.hostSelfId}`,
        kind: "missing-link",
        severity: "error",
        label: strings.t(M.missingLink, { name }),
        element,
      });
    if (l.effectivePpi != null && l.effectivePpi < LOW_RES_PPI)
      pending.push({
        id: `low-res:${l.hostSelfId}`,
        kind: "low-res",
        severity: "warning",
        label: strings.t(M.lowRes, { name, ppi: Math.round(l.effectivePpi) }),
        element,
      });
    if (cmyk && (l.colorspace ?? "").toUpperCase() === "RGB")
      pending.push({
        id: `color-space:${l.hostSelfId}`,
        kind: "color-space",
        severity: "info",
        label: strings.t(M.rgb, { name }),
        element,
      });
  }
  for (const s of stories ?? []) {
    if (!s.overset) continue;
    pending.push({
      id: `overset:${s.selfId}`,
      kind: "overset",
      severity: "warning",
      label: strings.t(M.overset),
      storyId: s.selfId,
    });
  }
  for (const f of fonts ?? []) {
    if (!f.isMissing) continue;
    pending.push({
      id: `missing-font:${f.family}`,
      kind: "missing-font",
      severity: "error",
      label: strings.t(M.missingFont, { family: f.family }),
    });
  }
  (findings ?? []).forEach((f, i) => {
    const index = f.pageIndex ?? undefined;
    pending.push({
      id: `output-standard:${f.code}:${i}`,
      kind: "output-standard",
      severity: f.severity === "error" ? "error" : "warning",
      label: f.message,
      ...(index !== undefined && pageIds[index]
        ? { pageIndex: index, pageId: pageIds[index] }
        : {}),
    });
  });
  for (const r of reports) {
    if (r.direction !== "import") continue;
    r.losses.forEach((loss, i) => {
      const what = loss.message || loss.code;
      const severity = loss.severity === "info" ? "info" : "warning";
      for (const index of loss.pages ?? []) {
        if (!pageIds[index]) continue;
        pending.push({
          id: `import-loss:${r.id}:${i}:${index}`,
          kind: "import-loss",
          severity,
          label: strings.t(M.importLoss, { what }),
          pageIndex: index,
          pageId: pageIds[index],
        });
      }
    });
  }
  for (const p of problems) {
    if (p.bundleId !== "media.paged.data" || p.severity === "info") continue;
    pending.push({
      id: `missing-data:${p.key}:${p.message}`,
      kind: "missing-data",
      severity: p.severity,
      label: strings.t(M.missingData, { what: p.message }),
    });
  }

  // The gathered set as data: placed again when it changes, and after
  // every edit (an edit moves items).
  const gathered = JSON.stringify({ pageIds, pending });
  const [revision, setRevision] = useState(0);
  useEffect(
    () =>
      client.subscribe((msg) => {
        if (
          msg.kind === "mutationApplied" ||
          msg.kind === "undoApplied" ||
          msg.kind === "redoApplied" ||
          msg.kind === "gestureCommitted"
        )
          setRevision((n) => n + 1);
      }),
    [client],
  );
  useEffect(() => {
    let cancelled = false;
    const { pageIds: ids, pending: list } = JSON.parse(gathered) as {
      pageIds: string[];
      pending: Pending[];
    };
    void place(client, ids, list).then((issues) => {
      if (!cancelled) setPublicationIssues(scope, issues);
    });
    return () => {
      cancelled = true;
    };
  }, [gathered, revision, client, scope]);

  // Going to an issue: keep the view, move there, select, show the fixes.
  useEffect(() => {
    setIssueActivator(scope, (issue) => {
      void goToIssue(
        paged,
        (id, p) => registries.commands.invoke(id, p),
        issue,
      ).then(() => actions.openPanel?.(HEALTH_PANEL));
    });
    return () => setIssueActivator(scope, null);
  }, [scope, paged, registries, actions]);
}

/** Keep the view, then go to `issue`: its item (selected, fitted), else
 *  its page. */
export async function goToIssue(
  paged: PagedEditor,
  invoke: (id: string, payload?: unknown) => Promise<unknown>,
  issue: PublicationIssue,
): Promise<boolean> {
  rememberReturnView(paged.scope, { ...paged.camera.camera });
  if (issue.element) {
    const found = await revealItems(paged, { invoke }, [issue.element]);
    if (found > 0) return true;
  }
  if (issue.pageIndex !== undefined) return revealPage(paged, issue.pageIndex);
  return false;
}
