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

// ADR 560 — catalogues. A template's own fields (text, picture, visibility:
// the engine's `templateFields`) are binding targets: a binding names a
// field and the expression that fills it. Running the catalogue copies the
// template's page once per record (or group) and fills every copy's fields
// from its record, the values decided by the engine (`plan_catalogue`) and
// written the way the template form writes them (`data-host-model`
// `catalogueFillOps`), so the template's constraints hold and the engine
// checks every write against the session's role.
//
// The pages a catalogue owns are the template page and its copies: the
// template page carries this plugin's page label `{ catalogue: <page id> }`
// and every copy inherits it (a copied page keeps its labels), so a second
// run finds and replaces exactly them, whoever runs it. Opening the
// catalogue to a filler is the template's business: a page policy
// (`x-paged:template` `{ allow: ["document.pages"] }` on the template page,
// written by an author) lets a filler copy that page and remove its copies
// and no other page (engine `permit`, ADR 560). A run is two undo steps
// when it adds or removes pages (the pages, then their fields: a copy's
// fields have new ids the second write must name), one otherwise.

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationOutcome,
  PageId,
} from "@paged-media/plugin-api";

import { t as tr } from "@paged-media/strings";

import {
  BINDING_KEY,
  catalogueFieldKind,
  catalogueFillOps,
  makeEnvelope,
  parseEnvelope,
  type CatalogueCopy,
  type CataloguePlan,
  type TemplateFieldRow,
} from "../../data-host-model/src";
import type { DataEngineLike } from "./engine";
import { CATALOGUE as M, TEMPLATE } from "./messages";

/** A template field bound to the data. */
export interface TemplateFieldBinding {
  /** The field's name in the template. */
  field: string;
  query: string;
  /** The binding expression (a column name is the simplest one). */
  expr: string;
  /** Visibility fields: hide when the expression is true. */
  invert?: boolean;
}

/** How a catalogue repeats its template. */
export type CatalogueMode = "perRecord" | "perGroup";

/** A catalogue as it was last made: its template page and its records. */
export interface CatalogueDef {
  page: string;
  query: string;
  mode: CatalogueMode;
  by?: string[];
}

/** What the session keeps (and saves) of its catalogues. */
export interface CatalogueState {
  fields: TemplateFieldBinding[];
  runs: Record<string, CatalogueDef>;
}

export function emptyCatalogueState(): CatalogueState {
  return { fields: [], runs: {} };
}

/** A field a binding can target. */
export interface TemplateFieldTarget {
  name: string;
  kind: "text" | "image" | "visibility";
  required: boolean;
  maxLength: number | null;
  /** The page of the field's first item. */
  page: string | null;
  /** The binding that fills it, if any. */
  binding: TemplateFieldBinding | null;
}

export interface CatalogueRunOptions {
  /** The query (default: the query of the bound fields). */
  query?: string;
  /** The template page (default: the page of the first bound field). */
  page?: string;
  mode?: CatalogueMode;
  /** `perGroup`: the columns to group by. */
  by?: string[];
}

export interface CatalogueProblem {
  instance: string;
  field: string;
  problem: string;
}

export interface CatalogueResult {
  ok: boolean;
  /** The pages the catalogue holds now, template page first. */
  pages: string[];
  instances: number;
  records: number;
  undoSteps: number;
  problems: CatalogueProblem[];
  message: string;
}

/** What the catalogue methods need of the session. */
export interface CatalogueContext {
  host: BundleHost;
  state: CatalogueState;
  ensureEngine(): Promise<DataEngineLike>;
  queryIds(): string[];
  recordCount(query: string): Promise<number>;
  refreshData(): Promise<void>;
  checkExpression(
    expr: string,
    query: string,
  ): Promise<{ ok: boolean; error?: string; unknownFields: string[] }>;
  markDirty(): void;
  emit(): void;
  setMessage(message: string): void;
}

export interface CatalogueMethods {
  /** The template's text, picture and visibility fields (one per name),
   *  each with the binding that fills it. */
  templateFieldTargets(): Promise<TemplateFieldTarget[]>;
  templateFieldBindings(): TemplateFieldBinding[];
  /** Bind a template field (replacing its binding). The field must be a
   *  text, picture or visibility field of the template, and the expression
   *  must work on the query. */
  bindTemplateField(
    b: TemplateFieldBinding,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  unbindTemplateField(field: string): boolean;
  /** The catalogues made so far, by template page. */
  catalogues(): CatalogueDef[];
  /** Copy the template page once per record (or group) and fill the
   *  copies; a second run replaces the copies of the first. */
  runCatalogue(opts?: CatalogueRunOptions): Promise<CatalogueResult>;
}

interface PageRow {
  selfId: string;
  pluginMetadata?: { key: string; value: string }[];
}

/** The template page a page belongs to as a catalogue page, if it does. */
function catalogueOf(page: PageRow): string | null {
  const entry = page.pluginMetadata?.find((e) => e.key === BINDING_KEY);
  const data = entry ? parseEnvelope(entry.value)?.data : null;
  const c = (data as { catalogue?: unknown } | null)?.catalogue;
  return typeof c === "string" ? c : null;
}

/** A refusal as a sentence (a permission the template withholds is named). */
function refusal(outcome: MutationOutcome): string {
  const e = outcome.applied ? "" : outcome.error;
  const text = typeof e === "string" ? e : JSON.stringify(e ?? "");
  const m =
    /NotPermitted \{ permission: \\?"([^"\\]+)\\?", target: \\?"([^"\\]+)/.exec(
      text,
    ) ??
    /"permission":"([^"]+)","target":"([^"]+)"/.exec(text.replace(/\\/g, ""));
  return m
    ? tr(TEMPLATE.notPermitted, { target: m[2]!, permission: m[1]! })
    : text;
}

const problemText = (code: string, detail: string): string =>
  code === "required"
    ? tr(M.required)
    : code === "tooLong"
      ? tr(M.tooLong, { max: detail })
      : tr(M.error, { detail });

export function catalogueMethods(ctx: CatalogueContext): CatalogueMethods {
  const { host, state } = ctx;

  const fieldRows = () =>
    host.document.collection<TemplateFieldRow>("templateFields");

  /** The page each row's item is on. */
  async function pagesOf(
    rows: readonly TemplateFieldRow[],
  ): Promise<Map<string, string>> {
    const ids = rows
      .map((r) => r.elementId)
      .filter((e): e is ElementId => e !== null);
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    for (const g of await host.document.elementGeometry(ids)) {
      const id = (g.id as { id?: unknown }).id;
      if (typeof id === "string" && g.pageId) out.set(id, g.pageId);
    }
    return out;
  }

  const fail = (message: string, problems: CatalogueProblem[] = []) => {
    ctx.setMessage(message);
    return {
      ok: false,
      pages: [],
      instances: 0,
      records: 0,
      undoSteps: 0,
      problems,
      message,
    } satisfies CatalogueResult;
  };

  return {
    async templateFieldTargets() {
      const rows = await fieldRows();
      const pages = await pagesOf(rows);
      const seen = new Set<string>();
      const out: TemplateFieldTarget[] = [];
      for (const r of rows) {
        const kind = catalogueFieldKind(r.field.kind);
        if (!kind || seen.has(r.field.name)) continue;
        seen.add(r.field.name);
        out.push({
          name: r.field.name,
          kind,
          required: r.field.required ?? false,
          maxLength: r.field.constraints?.maxLength ?? null,
          page: pages.get(r.targetId) ?? null,
          binding: state.fields.find((b) => b.field === r.field.name) ?? null,
        });
      }
      return out;
    },

    templateFieldBindings() {
      return state.fields.map((b) => ({ ...b }));
    },

    async bindTemplateField(b) {
      const rows = await fieldRows();
      const row = rows.find((r) => r.field.name === b.field);
      if (!row)
        return { ok: false, reason: tr(M.noSuchField, { field: b.field }) };
      if (!catalogueFieldKind(row.field.kind))
        return {
          ok: false,
          reason: tr(M.notFillable, { field: b.field, kind: row.field.kind }),
        };
      if (!ctx.queryIds().includes(b.query))
        return { ok: false, reason: tr(M.queryUndefined, { query: b.query }) };
      if ((await ctx.recordCount(b.query)) === 0) await ctx.refreshData();
      const check = await ctx.checkExpression(b.expr, b.query);
      if (check.unknownFields.length > 0)
        return {
          ok: false,
          reason: tr(M.unknownColumns, {
            columns: check.unknownFields.join(", "),
          }),
        };
      if (!check.ok)
        return {
          ok: false,
          reason: tr(M.exprInvalid, { error: check.error ?? "" }),
        };
      const next: TemplateFieldBinding = {
        field: b.field,
        query: b.query,
        expr: b.expr,
        ...(b.invert ? { invert: true } : {}),
      };
      const at = state.fields.findIndex((x) => x.field === b.field);
      if (at >= 0) state.fields[at] = next;
      else state.fields.push(next);
      ctx.setMessage(tr(M.bound, { field: b.field, expr: b.expr }));
      ctx.markDirty();
      ctx.emit();
      return { ok: true };
    },

    unbindTemplateField(field) {
      const at = state.fields.findIndex((x) => x.field === field);
      if (at < 0) return false;
      state.fields.splice(at, 1);
      ctx.markDirty();
      ctx.emit();
      return true;
    },

    catalogues() {
      return Object.values(state.runs).map((d) => ({ ...d }));
    },

    async runCatalogue(opts = {}) {
      const rows = await fieldRows();
      const pageOfItem = await pagesOf(rows);
      const pageOf = (r: TemplateFieldRow) => pageOfItem.get(r.targetId);
      const before = await host.document.collection<PageRow>("pages");
      // The last catalogue of this page (or of this query, or the only one).
      const runs = Object.values(state.runs);
      const previous = opts.page
        ? state.runs[opts.page]
        : (runs.find((r) => r.query === opts.query) ??
          (opts.query === undefined && runs.length === 1
            ? runs[0]
            : undefined));
      const query =
        opts.query ?? previous?.query ?? state.fields[0]?.query ?? "";
      const bound = state.fields.filter((b) => b.query === query);
      if (bound.length === 0) return fail(tr(M.noBindings));
      // Otherwise the page of the first bound field that is not a copy.
      const copyOfAnother = new Set(
        before
          .filter((p) => {
            const c = catalogueOf(p);
            return c !== null && c !== p.selfId;
          })
          .map((p) => p.selfId),
      );
      const firstBound = rows.find((r) => {
        const p = pageOf(r);
        return (
          p !== undefined &&
          !copyOfAnother.has(p) &&
          bound.some((b) => b.field === r.field.name)
        );
      });
      const page =
        opts.page ??
        previous?.page ??
        (firstBound ? pageOf(firstBound) : undefined);
      if (!page) return fail(tr(M.noBindings));
      const template = before.find((p) => p.selfId === page);
      if (!template) return fail(tr(M.noPage, { page }));
      const mode = opts.mode ?? state.runs[page]?.mode ?? "perRecord";
      const by =
        opts.by ?? (mode === "perGroup" ? (state.runs[page]?.by ?? []) : []);

      // The template's own fields: on its page, the first item of a name.
      const onTemplate = new Map<string, TemplateFieldRow>();
      for (const r of rows)
        if (pageOf(r) === page && !onTemplate.has(r.field.name))
          onTemplate.set(r.field.name, r);
      const fields = bound.flatMap((b) => {
        const row = onTemplate.get(b.field);
        const kind = row ? catalogueFieldKind(row.field.kind) : null;
        if (!row || !kind) return [];
        return [
          {
            name: b.field,
            kind,
            expr: b.expr,
            required: row.field.required ?? false,
            ...(row.field.constraints?.maxLength != null
              ? { maxLength: row.field.constraints.maxLength }
              : {}),
            invert: b.invert ?? false,
          },
        ];
      });
      if (fields.length === 0) return fail(tr(M.noFieldsOnPage, { page }));

      const engine = await ctx.ensureEngine();
      if (typeof engine.plan_catalogue !== "function")
        return fail(tr(M.engineTooOld));
      if ((await ctx.recordCount(query)) === 0) await ctx.refreshData();
      const plan = engine.plan_catalogue(query, {
        fields,
        ...(mode === "perGroup" ? { mode, by } : { mode }),
      }) as CataloguePlan;
      if (plan.unknownColumns?.length)
        return fail(
          tr(M.unknownColumns, { columns: plan.unknownColumns.join(", ") }),
        );
      const problems: CatalogueProblem[] = plan.instances.flatMap((i) =>
        i.values.flatMap((v) =>
          v.outcome === "refused"
            ? [
                {
                  instance: i.label,
                  field: v.field,
                  problem: problemText(v.code, v.detail),
                },
              ]
            : [],
        ),
      );
      if (problems.length > 0) {
        const first = problems[0]!;
        return fail(
          tr(M.refused, {
            reason: tr(M.problem, {
              label: first.instance,
              field: first.field,
              problem: first.problem,
            }),
          }),
          problems,
        );
      }

      // 1. The pages: mark the template page, remove the last run's copies,
      //    copy the template once per further instance.
      const n = plan.instances.length;
      const copies = before.filter(
        (p) => p.selfId !== page && catalogueOf(p) === page,
      );
      const structure: Mutation[] = [];
      if (catalogueOf(template) !== page)
        structure.push({
          op: "setPageMetadata",
          args: {
            page: page as PageId,
            key: BINDING_KEY,
            value: makeEnvelope({ catalogue: page }),
          },
        });
      for (const c of copies)
        structure.push({
          op: "deletePage",
          args: { pageId: c.selfId as PageId },
        });
      for (let i = 1; i < n; i++)
        structure.push({ op: "duplicatePage", args: { page: page as PageId } });
      let undoSteps = 0;
      if (structure.length > 0) {
        const out = await host.document.mutate({
          op: "batch",
          args: { ops: structure },
        });
        if (!out.applied) {
          const reason = refusal(out);
          return fail(
            tr(M.refused, {
              reason:
                catalogueOf(template) !== page &&
                /document\.metadata/.test(reason)
                  ? tr(M.notMarked)
                  : reason,
            }),
          );
        }
        undoSteps += 1;
      }
      state.runs[page] = { page, query, mode, ...(by.length ? { by } : {}) };
      ctx.markDirty();
      if (n === 0) {
        const message = tr(M.emptied);
        ctx.setMessage(message);
        ctx.emit();
        return {
          ok: true,
          pages: [page],
          instances: 0,
          records: plan.totalRecords,
          undoSteps,
          problems: [],
          message,
        };
      }

      // 2. The fields: every copy, in document order, from its instance.
      const after = await host.document.collection<PageRow>("pages");
      const pages = after
        .filter((p) => p.selfId === page || catalogueOf(p) === page)
        .map((p) => p.selfId);
      const rowsAfter = await fieldRows();
      const pageAfter = await pagesOf(rowsAfter);
      const byPage = new Map<string, Map<string, TemplateFieldRow>>();
      for (const r of rowsAfter) {
        const p = pageAfter.get(r.targetId);
        if (!p) continue;
        const m = byPage.get(p) ?? new Map<string, TemplateFieldRow>();
        if (!m.has(r.field.name)) m.set(r.field.name, r);
        byPage.set(p, m);
      }
      const fill = catalogueFillOps(
        plan.instances.map((inst, i): CatalogueCopy => ({
          rows: byPage.get(pages[i] ?? "") ?? new Map(),
          values: inst.values,
        })),
      );
      if (fill.ops.length > 0) {
        const out = await host.document.mutate({
          op: "batch",
          args: { ops: fill.ops },
        });
        if (!out.applied) return fail(tr(M.refused, { reason: refusal(out) }));
        undoSteps += 1;
      }
      const missing = Object.values(fill.missing).flat().length;
      const message =
        tr(M.done, { instances: n, records: plan.totalRecords }) +
        (missing > 0 ? ` ${tr(M.missingFields, { count: missing })}` : "");
      ctx.setMessage(message);
      ctx.emit();
      return {
        ok: true,
        pages,
        instances: n,
        records: plan.totalRecords,
        undoSteps,
        problems: [],
        message,
      };
    },
  };
}
