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

// The publication contract, assessed continuously (editor ADR 1236): what
// the document says about itself (its pages, fonts, links, stories, template
// fields and data issues, re-read as it changes) against the contract it
// carries; the outcome goes to the header's readiness badge, and each unmet
// requirement Publication health does not report already joins the
// publication's issues (editor ADR 1223), on its pages or items. Mounted
// once, by the canvas app.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  changesTheDocument,
  type DocumentMeta,
  type FontSummary,
  type LinkSummary,
  type PageSummary,
  type TemplateFieldSummary,
} from "@paged-media/client";
import {
  createValueStore,
  printOutputFacts,
  scoped,
  setPublicationIssues,
  setPublicationReadiness,
  setReadinessOpener,
  useCanvasClient,
  useCockpitActions,
  useCollection,
  useDocumentMeta,
  useDocumentStats,
  useEditorScope,
  useScoped,
  type EditorScope,
  type PublicationIssue,
} from "@paged-media/shell";

import { useProblems } from "../panels/problems-store";
import { hostElement } from "../publication-issues";
import {
  assessContract,
  type ContractAssessment,
  type ContractFacts,
} from "./assess";
import { contractOfMeta, type PublicationContract } from "./model";

/** The panel the badge and the issues open. */
export const CONTRACT_PANEL = "paged.publication-contract";

/** The issue source name in the publication's issue set. */
export const CONTRACT_ISSUES = "contract";

export interface ContractSnapshot {
  contract: PublicationContract | null;
  assessment: ContractAssessment | null;
}

const STATE = scoped("publicationContract", () =>
  createValueStore<ContractSnapshot>({ contract: null, assessment: null }),
);

export function contractStateOf(scope: EditorScope): ContractSnapshot {
  return scope.get(STATE).get();
}

/** This editor's contract and its assessment, re-read when they change. */
export function useContractState(): ContractSnapshot {
  const store = useScoped(STATE);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** A field value with nothing in it. */
function emptyValue(v: TemplateFieldSummary["value"]): boolean {
  if (!v) return true;
  switch (v.kind) {
    case "text":
      return v.text.trim() === "";
    case "image":
      return v.uri.trim() === "";
    case "runs":
      return v.runs.every((r) =>
        "text" in r ? String(r.text ?? "").trim() === "" : true,
      );
    default:
      return false;
  }
}

/** The facts the contract is assessed on. */
export function contractFacts(input: {
  meta: DocumentMeta | null;
  pages: readonly PageSummary[] | null;
  fonts: readonly FontSummary[] | null;
  links: readonly LinkSummary[] | null;
  oversetStories: number | null;
  fields: readonly TemplateFieldSummary[] | null;
  dataIssues: number;
  editedSinceApproval: boolean;
}): ContractFacts {
  return {
    loaded: input.meta != null && (input.meta.pageCount ?? 0) > 0,
    print: printOutputFacts(input.meta),
    pages: input.pages
      ? input.pages.map((p) => ({
          sizePt: p.sizePt,
          bleedTopPt: p.bleedTopPt,
          bleedLeftPt: p.bleedLeftPt,
          bleedBottomPt: p.bleedBottomPt,
          bleedRightPt: p.bleedRightPt,
        }))
      : null,
    fonts: input.fonts,
    links: input.links
      ? input.links.map((l) => ({
          status: l.status ?? null,
          effectivePpi: l.effectivePpi ?? null,
          colorspace: l.colorspace ?? null,
          element: hostElement(l),
        }))
      : null,
    oversetStories: input.oversetStories,
    emptyRequiredFields: (input.fields ?? []).filter(
      (f) => f.field.required && emptyValue(f.value),
    ).length,
    dataIssues: input.dataIssues,
    documentName: input.meta?.documentName ?? "",
    editedSinceApproval: input.editedSinceApproval,
  };
}

/** The issues of the unmet requirements Publication health does not
 *  report itself: one per page or item they stand on, else the document's. */
export function contractIssues(
  assessment: ContractAssessment,
  pageIds: readonly string[],
): PublicationIssue[] {
  const out: PublicationIssue[] = [];
  for (const c of assessment.checks) {
    if (c.level !== "blocker" && c.level !== "warning") continue;
    if (c.inHealth) continue;
    const severity = c.level === "blocker" ? "error" : "warning";
    const base = {
      kind: "contract" as const,
      severity,
      label: c.text,
    } as const;
    if (c.pages?.length)
      for (const i of c.pages)
        out.push({
          ...base,
          id: `contract:${c.id}:page:${i}`,
          pageIndex: i,
          ...(pageIds[i] ? { pageId: pageIds[i] } : {}),
        });
    else if (c.items?.length)
      for (const el of c.items)
        out.push({
          ...base,
          id: `contract:${c.id}:item:${String(el.id)}`,
          element: el,
        });
    else out.push({ ...base, id: `contract:${c.id}` });
  }
  return out;
}

/** The check an issue id names (`contract:<check>:…`). */
export function contractCheckId(issueId: string): string | null {
  const m = /^contract:([^:]+)/.exec(issueId);
  return m ? m[1]! : null;
}

/** Assess this editor's document against its contract whenever either
 *  changes. Mounted once, by the canvas app. */
export function usePublicationContractSource(): void {
  const scope = useEditorScope();
  const client = useCanvasClient();
  const actions = useCockpitActions();
  const meta = useDocumentMeta();
  const pages = useCollection<PageSummary>("pages");
  const fonts = useCollection<FontSummary>("fonts");
  const links = useCollection<LinkSummary>("links");
  const fields = useCollection<TemplateFieldSummary>("templateFields");
  const stats = useDocumentStats();
  const problemsStore = useProblems();
  const problems = useSyncExternalStore(
    problemsStore.subscribe,
    problemsStore.snapshot,
    problemsStore.snapshot,
  );
  const contract = contractOfMeta(meta);
  // "Approved, then edited" (in this session): a document change after the
  // approval this editor last saw.
  const approval =
    contract?.approval.status === "approved"
      ? `${contract.approval.at ?? 0}|${contract.approval.by ?? ""}`
      : null;
  // The approval the latest render saw, for the change listener (ADR 229:
  // written in a layout effect, read in the callback).
  const approvalRef = useRef(approval);
  useLayoutEffect(() => {
    approvalRef.current = approval;
  });
  const [watch, setWatch] = useState<{ key: string | null; edited: boolean }>({
    key: null,
    edited: false,
  });
  useEffect(
    () =>
      client.subscribe((msg) => {
        if (!changesTheDocument(msg)) return;
        const key = approvalRef.current;
        if (key)
          setWatch((w) =>
            w.key === key && w.edited ? w : { key, edited: true },
          );
      }),
    [client],
  );
  const edited = watch.key !== null && watch.key === approval && watch.edited;
  const dataIssues = problems.filter(
    (p) => p.bundleId === "media.paged.data" && p.severity !== "info",
  ).length;
  const facts = contractFacts({
    meta,
    pages,
    fonts,
    links,
    oversetStories: stats?.overset_stories ?? null,
    fields,
    dataIssues,
    editedSinceApproval: edited,
  });
  const assessment = contract ? assessContract(contract, facts) : null;
  const pageIds = (pages ?? []).map((p) => p.selfId);
  const published = JSON.stringify({ contract, assessment, pageIds });
  useEffect(() => {
    const {
      contract: c,
      assessment: a,
      pageIds: ids,
    } = JSON.parse(published) as {
      contract: PublicationContract | null;
      assessment: ContractAssessment | null;
      pageIds: string[];
    };
    scope.get(STATE).set({ contract: c, assessment: a });
    setPublicationIssues(
      scope,
      a ? contractIssues(a, ids) : [],
      CONTRACT_ISSUES,
    );
    setPublicationReadiness(
      scope,
      a
        ? {
            level: a.readiness,
            open: a.checks.filter(
              (x) => x.level === "blocker" || x.level === "warning",
            ).length,
            details: a.checks
              .filter((x) => x.level === "blocker" || x.level === "warning")
              .map((x) => x.text),
          }
        : null,
    );
  }, [published, scope]);
  useEffect(() => {
    setReadinessOpener(scope, () => actions.openPanel?.(CONTRACT_PANEL));
    return () => setReadinessOpener(scope, null);
  }, [scope, actions]);
}
