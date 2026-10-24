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

// Record templates and a record flow's pagination (PM-0015 L4, editor ADR
// 291's "not built" list). A record template is the "catalog cell" a record
// flow renders once per record: lines of a static label and a binding
// expression, at a line height (data-core `Template`). The engine owns the
// library (`template_library`, `template_from_text`, `rename_template`,
// `remove_template`, `preview_template`) and a flow's options
// (`record_flow`, `set_record_flow`); these methods read the selection and
// the page, hand the engine what it needs, and keep the session saved.
// Nothing here evaluates or paginates: the summary counts the blocks the
// engine's paginator placed.

import type { BundleHost, ElementId, PageId } from "@paged-media/plugin-api";

import type { DataEngineLike } from "./engine";
import { marginBox, paginateOverPages } from "./flow-writer";
import { storyText } from "./merge";
import type { SessionDiagnostic } from "./session";

/** One template field: a static label, then the expression's value. */
export interface TemplateFieldJson {
  label: string;
  expr: string;
}

/** A record template as the engine keeps it. */
export interface RecordTemplate {
  id: string;
  fields: TemplateFieldJson[];
  lineHeightPt: number;
}

/** A template in the library, with the record flows rendering through it. */
export interface TemplateEntry {
  template: RecordTemplate;
  usedBy: string[];
}

/** A group footer: `{count}` in the label is the group's record count;
 *  `sumField` is aggregated by `agg`. */
export interface GroupFooterJson {
  label: string;
  sumField?: string | null;
  agg?: "sum" | "avg" | "min" | "max";
}

/** A record flow's options, the engine's `FlowOpts`. */
export interface FlowOptions {
  groupBy: string[];
  repeatHeader: boolean;
  continuedMarker: boolean;
  footer?: GroupFooterJson | null;
}

/** A record flow's recipe. */
export interface RecordFlowRecipe {
  chain: string;
  query: string;
  template: string;
  options: FlowOptions;
}

/** A template filled with one record. */
export interface TemplatePreview {
  record: number;
  total: number;
  lines: { text: string; error?: string }[];
}

/** What the paginator did with a flow over the start page's margin box,
 *  one frame per page. */
export interface PaginationSummary {
  /** The frame height the flow was paginated over (pt). */
  frameHeightPt: number;
  total: number;
  placed: number;
  overflow: boolean;
  pages: {
    records: number;
    headers: number;
    continued: number;
    footers: number;
    usedPt: number;
  }[];
  /** The tallest record (pt); taller than the frame means a page of its own. */
  tallestRecordPt: number;
}

/** A refusal in words, or null when it worked. */
export type Outcome = string | null;

export interface RecordTemplateMethods {
  /** The template library, or null while the engine is not running. */
  templateLibrary(): TemplateEntry[] | null;
  /** Make template `name` from the selected text frames' text, written as
   *  for Data Merge: each line one template line, `<<field>>` a field. */
  createTemplateFromSelection(
    name: string,
    lineHeightPt?: number,
  ): Promise<{
    error: Outcome;
    template?: RecordTemplate;
    unreferenced?: string[];
  }>;
  renameTemplate(from: string, to: string): Promise<Outcome>;
  deleteTemplate(id: string): Promise<Outcome>;
  /** Change a template's line height (the height of each of its lines). */
  setTemplateLineHeight(id: string, lineHeightPt: number): Promise<Outcome>;
  /** Template `id` filled with record `record` (1-based) of `query`. */
  previewTemplate(
    id: string,
    query: string,
    record: number,
  ): Promise<TemplatePreview | { error: string }>;
  /** A record flow's recipe, or null (not a flow, or no engine yet). */
  recordFlow(id: string): RecordFlowRecipe | null;
  /** Set a record flow's template and options. */
  setRecordFlow(
    id: string,
    template: string,
    options: FlowOptions,
  ): Promise<Outcome>;
  /** Paginate a record flow as lowering would place it: null when it cannot
   *  (no engine, no page), `{ needsData }` when its query has no records. */
  paginationSummary(
    id: string,
  ): Promise<
    PaginationSummary | { needsData: true } | { error: string } | null
  >;
}

export interface RecordTemplateContext {
  host: BundleHost;
  ensureEngine(): Promise<DataEngineLike>;
  /** The engine when it is running (render-time reads). */
  engineNow(): DataEngineLike | null;
  startPage(): Promise<string | null>;
  markDirty(): void;
  emit(): void;
  report(d: SessionDiagnostic): void;
}

const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const NO_LANE = "this data engine has no template library (rebuild it)";

export function recordTemplateMethods(
  ctx: RecordTemplateContext,
): RecordTemplateMethods {
  async function engine(): Promise<DataEngineLike | string> {
    try {
      const e = await ctx.ensureEngine();
      return typeof e.template_library === "function" ? e : NO_LANE;
    } catch (err) {
      return `engine unavailable: ${errText(err)}`;
    }
  }

  /** Run a change on the engine; a refusal is the engine's words. */
  async function change(run: (e: DataEngineLike) => void): Promise<Outcome> {
    const e = await engine();
    if (typeof e === "string") return e;
    try {
      run(e);
    } catch (err) {
      return errText(err);
    }
    ctx.markDirty();
    ctx.emit();
    return null;
  }

  function templateOf(e: DataEngineLike, id: string): RecordTemplate | null {
    const lib = (e.template_library?.() ?? []) as TemplateEntry[];
    return lib.find((t) => t.template.id === id)?.template ?? null;
  }

  return {
    templateLibrary() {
      const e = ctx.engineNow();
      if (!e || typeof e.template_library !== "function") return null;
      return e.template_library() as TemplateEntry[];
    },

    async createTemplateFromSelection(name, lineHeightPt = 12) {
      const frames = ctx.host.selection
        .get()
        .filter((s): s is ElementId => s.kind === "textFrame");
      if (frames.length === 0) return { error: "select a text frame" };
      const geoms = await ctx.host.document.elementGeometry(frames);
      const texts: string[] = [];
      for (const f of frames) {
        const g = geoms.find((x) => x.id.id === f.id);
        const storyId = (g as { storyId?: string | null } | undefined)?.storyId;
        const content = storyId
          ? await ctx.host.document.storyContent(storyId)
          : null;
        if (content) texts.push(storyText(content));
      }
      if (texts.every((t) => t.trim() === ""))
        return { error: "the selected frames hold no text" };
      const e = await engine();
      if (typeof e === "string") return { error: e };
      try {
        const draft = e.template_from_text!(
          name.trim(),
          texts.join("\n"),
          lineHeightPt,
        ) as { template: RecordTemplate; unreferenced: string[] };
        ctx.markDirty();
        ctx.emit();
        return { error: null, ...draft };
      } catch (err) {
        return { error: errText(err) };
      }
    },

    renameTemplate(from, to) {
      return change((e) => e.rename_template!(from, to.trim()));
    },

    deleteTemplate(id) {
      return change((e) => e.remove_template!(id));
    },

    setTemplateLineHeight(id, lineHeightPt) {
      if (!(lineHeightPt > 0))
        return Promise.resolve("a line height is more than 0 pt");
      return change((e) => {
        const t = templateOf(e, id);
        if (!t) throw new Error(`no template "${id}"`);
        e.define_template({ ...t, lineHeightPt });
      });
    },

    async previewTemplate(id, query, record) {
      const e = await engine();
      if (typeof e === "string") return { error: e };
      const total = e.query_record_count?.(query) ?? 0;
      if (total === 0) return { error: `the query "${query}" has no records` };
      const n = Math.min(Math.max(1, Math.round(record)), total);
      try {
        const lines = e.preview_template!(id, query, n - 1) as {
          text: string;
          error?: string;
        }[];
        return { record: n, total, lines };
      } catch (err) {
        return { error: errText(err) };
      }
    },

    recordFlow(id) {
      const e = ctx.engineNow();
      if (!e || typeof e.record_flow !== "function") return null;
      return (e.record_flow(id) as RecordFlowRecipe | null) ?? null;
    },

    setRecordFlow(id, template, options) {
      return change((e) => e.set_record_flow!(id, template, options));
    },

    async paginationSummary(id) {
      const e = ctx.engineNow();
      if (!e || typeof e.record_flow !== "function") return null;
      const recipe = e.record_flow(id) as RecordFlowRecipe | null;
      if (!recipe) return null;
      if ((e.query_record_count?.(recipe.query) ?? 0) === 0)
        return { needsData: true };
      const pageId = await ctx.startPage();
      if (!pageId) return null;
      const pages = await ctx.host.document.collection<{
        selfId: string;
        sizePt: [number, number];
        marginTopPt?: number;
        marginLeftPt?: number;
        marginBottomPt?: number;
        marginRightPt?: number;
      }>("pages");
      const page = pages.find((p) => p.selfId === (pageId as PageId));
      if (!page) return null;
      const box = marginBox(page);
      const height = box[2] - box[0];
      try {
        const flow = paginateOverPages(e, id, height);
        let tallest = 0;
        const summary = flow.frames.map((f) => {
          const out = {
            records: 0,
            headers: 0,
            continued: 0,
            footers: 0,
            usedPt: f.usedPt,
          };
          for (const b of f.blocks) {
            if (b.block === "record") {
              out.records += 1;
              tallest = Math.max(tallest, b.heightPt);
            } else if (b.block === "groupHeader") {
              out.headers += 1;
              if (b.continued) out.continued += 1;
            } else out.footers += 1;
          }
          return out;
        });
        return {
          frameHeightPt: height,
          total: flow.total,
          placed: flow.placed,
          overflow: flow.overflow,
          pages: summary,
          tallestRecordPt: tallest,
        };
      } catch (err) {
        return { error: errText(err) };
      }
    },
  };
}
