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

// The document map's navigation lenses (editor ADR "Page lenses and
// semantic zoom"; the redesign strategy's §4.3): one panel, five ways to
// find a place in the same document, one search over all of them.
//
//   Pages      the spreads and their pages (the map's own list)
//   Structure  sections, headings, bookmarks and stories
//   Layers     the layers and the page items on each, by name
//   Issues     the pages with problems: missing and low-resolution links,
//              overset stories, the last preflight's findings; problems
//              that belong to no page (missing fonts) as one document row
//   Data       the records a data binding placed, where they landed (only
//              while the document has a binding)
//
// A click navigates (an explicit navigation: Back returns, editor ADR
// 1211) and, for an object, selects it; it never changes the document.
// Each lens reads only while it is shown. Pure helpers are exported for
// the tests.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  elementOfPlacement,
  useCanvasClient,
  useCollection,
  useDataRevision,
  useDataService,
  useDocument,
} from "@paged-media/shell";
import type {
  ElementGeometryItem,
  ElementId,
  LayerSummary,
  LinkSummary,
  PageSummary,
  PreflightFinding,
  SectionSummary,
  StorySummary,
} from "@paged-media/client";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

import { usePreflightFindings } from "./preflight-findings";
import {
  buildLayerTree,
  elementKey,
  useObjectTree,
  type ObjectNode,
} from "../layer-objects";

export const M = defineMessages("app.pageLenses", {
  lenses: "Navigation lens",
  pages: "Pages",
  structure: "Structure",
  layers: "Layers",
  issues: "Issues",
  data: "Data",
  search: "Search pages, sections, headings, objects",
  sections: "Sections",
  headings: "Headings",
  bookmarks: "Bookmarks",
  stories: "Stories",
  story: "Story {n}",
  storyMeta:
    "{chars, plural, one {# character} other {# characters}}{overset, select, true { · overset} other {}}",
  page: "Page {n}",
  noLayer: "Layer",
  untitledLayer: "Layer {n}",
  hidden: "hidden",
  locked: "locked",
  nothing: "Nothing matches.",
  empty: "Nothing here in this document.",
  noIssues: "No problems found on any page.",
  documentRow: "Document",
  missingLinks: "{count, plural, one {# missing link} other {# missing links}}",
  lowRes:
    "{count, plural, one {# low-resolution image} other {# low-resolution images}}",
  overset: "{count, plural, one {# overset story} other {# overset stories}}",
  preflight:
    "{count, plural, one {# preflight finding} other {# preflight findings}}",
  missingFonts: "{count, plural, one {# missing font} other {# missing fonts}}",
  preflightNotRun: "Preflight has not run: Validate output adds its findings.",
  record: "Record {n}",
  noPlacements: "The binding places nothing yet.",
});

export type LensId = "pages" | "structure" | "layers" | "issues" | "data";

/** The lenses in their order; Data only with a binding. */
export function lensesFor(hasData: boolean): LensId[] {
  const all: LensId[] = ["pages", "structure", "layers", "issues"];
  return hasData ? [...all, "data"] : all;
}

/** Does `text` match the search `query` (case-insensitive, trimmed)? An
 *  empty query matches everything. */
export function matches(
  query: string,
  ...text: Array<string | null | undefined>
) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return text.some((t) => (t ?? "").toLowerCase().includes(q));
}

/** What the lenses do on a click. */
export interface LensActions {
  /** Fit page `index` (an explicit navigation). */
  goToPage(index: number): void;
  /** Select the page items and bring their page into view. */
  selectAndShow(ids: ElementId[]): void;
}

interface LensProps {
  query: string;
  actions: LensActions;
}

// ───────────────────────────────────────────────────────── tabs

export function LensTabs({
  lens,
  lenses,
  onLens,
}: {
  lens: LensId;
  lenses: readonly LensId[];
  onLens: (lens: LensId) => void;
}) {
  const strings = useStrings();
  return (
    <div
      role="tablist"
      aria-label={strings.t(M.lenses)}
      data-page-lenses=""
      style={{ display: "flex", gap: 2, padding: "0 12px 8px" }}
    >
      {lenses.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={lens === id}
          data-page-lens={id}
          onClick={() => onLens(id)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const i = lenses.indexOf(id);
            const next =
              lenses[
                (i + (e.key === "ArrowRight" ? 1 : -1) + lenses.length) %
                  lenses.length
              ]!;
            onLens(next);
            (
              e.currentTarget.parentElement?.querySelector(
                `[data-page-lens="${next}"]`,
              ) as HTMLElement | null
            )?.focus();
          }}
          tabIndex={lens === id ? 0 : -1}
          style={{
            flex: 1,
            minWidth: 0,
            height: 24,
            padding: "0 4px",
            border: "none",
            borderRadius: "var(--radius-md)",
            background: lens === id ? "var(--pg-muted)" : "transparent",
            color: lens === id ? "var(--pg-fg)" : "var(--pg-muted-fg)",
            fontWeight: lens === id ? 600 : 400,
            fontSize: 11.5,
            fontFamily: "var(--font-sans)",
            cursor: "pointer",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {strings.t(M[id])}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────── shared rows

function Heading({ children }: { children: ReactNode }) {
  return (
    <div className="pg-label" style={{ padding: "8px 8px 4px" }}>
      {children}
    </div>
  );
}

function Row(props: {
  testId: string;
  label: string;
  meta?: string | null;
  indent?: number;
  tone?: "warn" | "error";
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      data-lens-row={props.testId}
      disabled={props.disabled || !props.onClick}
      onClick={props.onClick}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        width: "100%",
        padding: `5px 8px 5px ${8 + (props.indent ?? 0) * 12}px`,
        border: "none",
        borderRadius: "var(--radius-md)",
        background: "transparent",
        color: "var(--pg-fg)",
        textAlign: "left",
        cursor: props.onClick && !props.disabled ? "pointer" : "default",
        fontFamily: "var(--font-sans)",
        fontSize: 12.5,
      }}
    >
      {props.tone && (
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            flexShrink: 0,
            background:
              props.tone === "error"
                ? "var(--status-error)"
                : "var(--status-review)",
          }}
        />
      )}
      <span style={ellipsis}>{props.label}</span>
      {props.meta && (
        <span
          className="pg-mono-meta"
          style={{ marginLeft: "auto", flexShrink: 0 }}
        >
          {props.meta}
        </span>
      )}
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div
      className="pg-ui-xs"
      style={{ padding: "8px", color: "var(--pg-muted-fg)" }}
    >
      {children}
    </div>
  );
}

const ellipsis: CSSProperties = {
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** The page number a reader sees for page `index`: its folio (the name
 *  InDesign shows, "iv", "A-2") when it has one, else its position. */
export function pageLabel(
  index: number,
  page: Pick<PageSummary, "name"> | undefined,
): string {
  return page?.name ? page.name : String(index + 1);
}

// ───────────────────────────────────────────────────── Structure

/** The headings the resolver numbered, in document order: text, level
 *  and page. */
export function headingsOf(
  numbering: Record<
    string,
    {
      text?: string | null;
      level?: number | null;
      pageId?: string | null;
      pageNumber: number;
    }
  >,
  pageIds: ReadonlyArray<string>,
): Array<{ id: string; text: string; level: number; pageIndex: number }> {
  const out: Array<{
    id: string;
    text: string;
    level: number;
    pageIndex: number;
  }> = [];
  for (const [id, pos] of Object.entries(numbering)) {
    const level = pos.level ?? 0;
    if (level <= 0 || !pos.pageId) continue;
    const pageIndex = pageIds.indexOf(pos.pageId);
    if (pageIndex < 0) continue;
    out.push({ id, text: pos.text ?? "", level, pageIndex });
  }
  return out.sort(
    (a, b) =>
      a.pageIndex - b.pageIndex ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}

export function StructureLens({ query, actions }: LensProps) {
  const strings = useStrings();
  const client = useCanvasClient();
  const { handle, resolution } = useDocument();
  const sections = useCollection<SectionSummary>("sections") ?? [];
  const stories = useCollection<StorySummary>("stories") ?? [];
  const bookmarks =
    useCollection<{
      selfId: string;
      name: string;
      destinationPage?: string | null;
    }>("bookmarks") ?? [];
  const pageIds = (handle?.pageIds ?? []).map(String);
  const headings = resolution ? headingsOf(resolution.numbering, pageIds) : [];

  const revealStory = (storyId: string) => {
    void client
      .frameChain(storyId)
      .then((chain) => {
        const first = chain[0];
        if (first)
          actions.selectAndShow([
            { kind: "textFrame", id: first.frameId } as ElementId,
          ]);
      })
      .catch(() => {});
  };

  const sectionRows = sections.filter((s) =>
    matches(query, s.prefix, String((s.startPageIndex ?? -1) + 1)),
  );
  const headingRows = headings.filter((h) =>
    matches(query, h.text, String(h.pageIndex + 1)),
  );
  const bookmarkRows = bookmarks.filter((b) => matches(query, b.name));
  const storyRows = stories
    .map((s, i) => ({ s, label: strings.t(M.story, { n: i + 1 }) }))
    .filter(({ label }) => matches(query, label));
  const total =
    sectionRows.length +
    headingRows.length +
    bookmarkRows.length +
    storyRows.length;

  return (
    <div data-lens-body="structure">
      {sectionRows.length > 0 && <Heading>{strings.t(M.sections)}</Heading>}
      {sectionRows.map((s) => (
        <Row
          key={s.selfId}
          testId={`section:${s.selfId}`}
          label={s.prefix || "§"}
          meta={
            s.startPageIndex != null
              ? strings.t(M.page, { n: s.startPageIndex + 1 })
              : null
          }
          onClick={
            s.startPageIndex != null
              ? () => actions.goToPage(s.startPageIndex!)
              : undefined
          }
        />
      ))}
      {headingRows.length > 0 && <Heading>{strings.t(M.headings)}</Heading>}
      {headingRows.map((h) => (
        <Row
          key={h.id}
          testId={`heading:${h.id}`}
          label={h.text}
          indent={h.level - 1}
          meta={strings.t(M.page, { n: h.pageIndex + 1 })}
          onClick={() => actions.goToPage(h.pageIndex)}
        />
      ))}
      {bookmarkRows.length > 0 && <Heading>{strings.t(M.bookmarks)}</Heading>}
      {bookmarkRows.map((b) => {
        const index = b.destinationPage
          ? pageIds.indexOf(b.destinationPage)
          : -1;
        return (
          <Row
            key={b.selfId}
            testId={`bookmark:${b.selfId}`}
            label={b.name}
            meta={index >= 0 ? strings.t(M.page, { n: index + 1 }) : null}
            onClick={index >= 0 ? () => actions.goToPage(index) : undefined}
          />
        );
      })}
      {storyRows.length > 0 && <Heading>{strings.t(M.stories)}</Heading>}
      {storyRows.map(({ s, label }) => (
        <Row
          key={s.selfId}
          testId={`story:${s.selfId}`}
          label={label}
          tone={s.overset ? "error" : undefined}
          meta={strings.t(M.storyMeta, {
            chars: s.characterCount,
            overset: s.overset ? "true" : "false",
          })}
          onClick={() => revealStory(s.selfId)}
        />
      ))}
      {total === 0 && (
        <Note>{strings.t(query.trim() ? M.nothing : M.empty)}</Note>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────── Layers

/** The items of a branch, depth first, with their depth (for the
 *  search, which also finds a group's members). */
function flatten(
  items: ReadonlyArray<ObjectNode>,
  depth = 0,
): Array<{ node: ObjectNode; depth: number }> {
  const out: Array<{ node: ObjectNode; depth: number }> = [];
  for (const n of items) {
    out.push({ node: n, depth });
    out.push(...flatten(n.children, depth + 1));
  }
  return out;
}

export function LayersLens({ query, actions }: LensProps) {
  const strings = useStrings();
  const layers = useCollection<LayerSummary>("layers") ?? [];
  const tree = useObjectTree(true);
  const branches = tree ? buildLayerTree(tree.roots, layers, tree.facts) : [];
  // Each layer with the items the search keeps (a layer whose name
  // matches keeps its row even with none).
  const views = branches
    .map((b, i) => {
      const name = b.layer.name || strings.t(M.untitledLayer, { n: i + 1 });
      const rows = flatten(b.items).filter(({ node }) =>
        matches(query, node.name, node.label, name),
      );
      const state = [
        b.layer.visible ? null : strings.t(M.hidden),
        b.layer.locked ? strings.t(M.locked) : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return { branch: b, name, rows, state };
    })
    .filter((v) => v.rows.length > 0 || matches(query, v.name));
  const shown = views.reduce((n, v) => n + v.rows.length + 1, 0);
  return (
    <div data-lens-body="layers">
      {views.map(({ branch: b, name, rows, state }) => (
        <div key={b.layer.selfId || "none"} data-lens-layer={b.layer.selfId}>
          <div
            className="pg-label"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 8px 4px",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: b.colour,
              }}
            />
            <span style={ellipsis}>{name}</span>
            {state && <span className="pg-mono-meta">{state}</span>}
          </div>
          {rows.map(({ node, depth }) => (
            <Row
              key={node.key}
              testId={`object:${elementKey(node.id)}`}
              label={node.name || node.label}
              indent={depth}
              onClick={() => actions.selectAndShow([node.id])}
            />
          ))}
        </div>
      ))}
      {tree && shown === 0 && (
        <Note>{strings.t(query.trim() ? M.nothing : M.empty)}</Note>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────── Issues

/** One page's problems. */
export interface PageIssues {
  pageIndex: number;
  missingLinks: ElementId[];
  lowRes: ElementId[];
  overset: ElementId[];
  preflight: PreflightFinding[];
}

/** Low resolution: an image placed at under this many effective ppi. */
export const LOW_RES_PPI = 150;

const HOST_KIND: Record<string, ElementId["kind"]> = {
  Rectangle: "rectangle",
  Oval: "oval",
  Polygon: "polygon",
  GraphicLine: "graphicLine",
};

/** The page items that hold a problem, by kind, before their pages are
 *  known: missing links' and low-resolution links' host frames. */
export function linkProblemHosts(links: ReadonlyArray<LinkSummary>): {
  missing: ElementId[];
  lowRes: ElementId[];
} {
  const missing: ElementId[] = [];
  const lowRes: ElementId[] = [];
  for (const l of links) {
    const kind = l.hostKind ? HOST_KIND[l.hostKind] : undefined;
    if (!kind || !l.hostSelfId) continue;
    const id = { kind, id: l.hostSelfId } as ElementId;
    if (l.status === "missing") missing.push(id);
    else if (
      typeof l.effectivePpi === "number" &&
      l.effectivePpi > 0 &&
      l.effectivePpi < LOW_RES_PPI
    )
      lowRes.push(id);
  }
  return { missing, lowRes };
}

/** Group the located problems by page, pages in order. */
export function issuesByPage(
  pageIds: ReadonlyArray<string>,
  located: ReadonlyArray<{
    kind: "missingLinks" | "lowRes" | "overset";
    id: ElementId;
    pageId: string | null;
  }>,
  preflight: ReadonlyArray<PreflightFinding>,
): PageIssues[] {
  const byIndex = new Map<number, PageIssues>();
  const at = (pageIndex: number) => {
    let p = byIndex.get(pageIndex);
    if (!p) {
      p = {
        pageIndex,
        missingLinks: [],
        lowRes: [],
        overset: [],
        preflight: [],
      };
      byIndex.set(pageIndex, p);
    }
    return p;
  };
  for (const l of located) {
    const i = l.pageId ? pageIds.indexOf(l.pageId) : -1;
    if (i < 0) continue;
    at(i)[l.kind].push(l.id);
  }
  for (const f of preflight) {
    if (f.pageIndex == null || f.pageIndex < 0 || f.pageIndex >= pageIds.length)
      continue;
    at(f.pageIndex).preflight.push(f);
  }
  return [...byIndex.values()].sort((a, b) => a.pageIndex - b.pageIndex);
}

/** The problems' page items and their pages, read through the client
 *  (outside the component: no conditional in a `try`, ADR 229). */
async function locateProblems(
  client: ReturnType<typeof useCanvasClient>,
  links: ReadonlyArray<LinkSummary>,
  stories: ReadonlyArray<StorySummary>,
): Promise<
  Array<{
    kind: "missingLinks" | "lowRes" | "overset";
    id: ElementId;
    pageId: string | null;
  }>
> {
  try {
    const { missing, lowRes } = linkProblemHosts(links);
    const overset: ElementId[] = [];
    for (const s of stories) {
      if (!s.overset) continue;
      const chain = await client.frameChain(s.selfId);
      const last = chain[chain.length - 1];
      if (last)
        overset.push({ kind: "textFrame", id: last.frameId } as ElementId);
    }
    const all = [...missing, ...lowRes, ...overset];
    if (all.length === 0) return [];
    const geometry: ElementGeometryItem[] = await client.elementGeometry(all);
    const pageOf = new Map(
      geometry.map((g) => [
        elementKey(g.id),
        g.pageId == null ? null : String(g.pageId),
      ]),
    );
    const tag =
      (kind: "missingLinks" | "lowRes" | "overset") => (id: ElementId) => ({
        kind,
        id,
        pageId: pageOf.get(elementKey(id)) ?? null,
      });
    return [
      ...missing.map(tag("missingLinks")),
      ...lowRes.map(tag("lowRes")),
      ...overset.map(tag("overset")),
    ];
  } catch {
    return [];
  }
}

export function IssuesLens({ query, actions }: LensProps) {
  const strings = useStrings();
  const client = useCanvasClient();
  const { handle } = useDocument();
  const pages = useCollection<PageSummary>("pages") ?? [];
  const links = useCollection<LinkSummary>("links");
  const stories = useCollection<StorySummary>("stories");
  const fonts = useCollection<{ isMissing?: boolean }>("fonts") ?? [];
  const preflight = usePreflightFindings(client);
  const [located, setLocated] = useState<
    Awaited<ReturnType<typeof locateProblems>>
  >([]);
  useEffect(() => {
    if (!links || !stories) return;
    let live = true;
    void locateProblems(client, links, stories).then((l) => {
      if (live) setLocated(l);
    });
    return () => {
      live = false;
    };
  }, [client, links, stories]);

  const pageIds = (handle?.pageIds ?? []).map(String);
  const rows = issuesByPage(pageIds, located, preflight.findings ?? []).filter(
    (p) => matches(query, String(p.pageIndex + 1), pages[p.pageIndex]?.name),
  );
  const missingFonts = fonts.filter((f) => f.isMissing).length;
  const summary = (p: PageIssues) =>
    [
      p.missingLinks.length > 0
        ? strings.t(M.missingLinks, { count: p.missingLinks.length })
        : null,
      p.lowRes.length > 0
        ? strings.t(M.lowRes, { count: p.lowRes.length })
        : null,
      p.overset.length > 0
        ? strings.t(M.overset, { count: p.overset.length })
        : null,
      p.preflight.length > 0
        ? strings.t(M.preflight, { count: p.preflight.length })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const errorTone = (p: PageIssues) =>
    p.missingLinks.length > 0 ||
    p.overset.length > 0 ||
    p.preflight.some((f) => f.severity === "error")
      ? ("error" as const)
      : ("warn" as const);

  return (
    <div data-lens-body="issues">
      {missingFonts > 0 && matches(query, strings.t(M.documentRow)) && (
        <Row
          testId="document"
          label={strings.t(M.documentRow)}
          meta={strings.t(M.missingFonts, { count: missingFonts })}
          tone="error"
        />
      )}
      {rows.map((p) => {
        const items = [...p.missingLinks, ...p.overset, ...p.lowRes];
        return (
          <Row
            key={p.pageIndex}
            testId={`page:${p.pageIndex}`}
            label={strings.t(M.page, {
              n: pageLabel(p.pageIndex, pages[p.pageIndex]),
            })}
            meta={summary(p)}
            tone={errorTone(p)}
            onClick={() =>
              items.length > 0
                ? actions.selectAndShow(items)
                : actions.goToPage(p.pageIndex)
            }
          />
        );
      })}
      {rows.length === 0 && missingFonts === 0 && (
        <Note>{strings.t(query.trim() ? M.nothing : M.noIssues)}</Note>
      )}
      {preflight.findings === null && (
        <Note>{strings.t(M.preflightNotRun)}</Note>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Data

/** The placed records, one row per record, with the page items they
 *  landed in. */
export function recordsOf(
  placements: ReadonlyArray<{ address: string; record?: number }>,
): Array<{ record: number; items: ElementId[] }> {
  const by = new Map<number, ElementId[]>();
  for (const p of placements) {
    if (p.record == null) continue;
    const id = elementOfPlacement(p.address);
    if (!id) continue;
    const list = by.get(p.record) ?? [];
    list.push(id);
    by.set(p.record, list);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([record, items]) => ({ record, items }));
}

/** Is there a data binding in this document? (The Data lens shows only
 *  then.) */
export function useHasDataBinding(): boolean {
  const service = useDataService();
  const revision = useDataRevision();
  // The last answer, for the service it came from.
  const [answer, setAnswer] = useState<{
    service: unknown;
    has: boolean;
  } | null>(null);
  useEffect(() => {
    let live = true;
    if (!service?.status) return;
    void service
      .status()
      .then((s) => {
        if (live) setAnswer({ service, has: s.length > 0 });
      })
      .catch(() => {
        if (live) setAnswer({ service, has: false });
      });
    return () => {
      live = false;
    };
  }, [service, revision]);
  return service != null && answer?.service === service && answer.has;
}

export function DataLens({ query, actions }: LensProps) {
  const strings = useStrings();
  const service = useDataService();
  const revision = useDataRevision();
  const [records, setRecords] = useState<ReturnType<typeof recordsOf>>([]);
  useEffect(() => {
    let live = true;
    if (!service?.placements) return;
    void service
      .placements()
      .then((p) => {
        if (live) setRecords(recordsOf(p));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [service, revision]);
  const rows = records.filter((r) =>
    matches(
      query,
      strings.t(M.record, { n: r.record + 1 }),
      String(r.record + 1),
    ),
  );
  return (
    <div data-lens-body="data">
      {rows.map((r) => (
        <Row
          key={r.record}
          testId={`record:${r.record}`}
          label={strings.t(M.record, { n: r.record + 1 })}
          onClick={() => actions.selectAndShow(r.items)}
        />
      ))}
      {rows.length === 0 && (
        <Note>{strings.t(query.trim() ? M.nothing : M.noPlacements)}</Note>
      )}
    </div>
  );
}

export type { Strings };
