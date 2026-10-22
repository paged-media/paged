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

// paged.sheet's TEMPLATE FIELD KINDS (plan G3; extensions ADR 335): the parts
// of a workbook a template can open to a filler.
//
//   media.paged.sheet.cell         { ref, type?, allowed?, min?, max? }
//       one cell's constant: text, a number, or a choice from `allowed`
//   media.paged.sheet.range        { ref, columns?, rows?: "fixed" | { min?, max? } }
//       a range's values as a table (rows of strings, column order); a
//       growable range takes up to its own row count and clears the rest
//   media.paged.sheet.chartSource  { chart, allowed: [{ name, label?, series }] }
//       which of the author's series lists a chart draws
//
// `ref` is `Sheet!A1` (`'My sheet'!A1:B4`) or a defined name.
//
// Every write goes through `host.objects` — the object model's one write
// door (`object-model.ts`): ONE batch, one engine pass, one saved workbook
// version, the document's version label = ONE undo step, checked by the
// engine against the session's role. The workbook's version label lives on
// the DOCUMENT, so a filler writes a sheet field only where the template's
// document policy grants `document.metadata`; a refusal answers a sentence
// and the engine goes back to the version the label names.
//
// The page follows the workbook: every placed table that shows a written
// cell is re-poured after the write (text and cell styles: `text.edit` and
// `text.style` on its frame), a placed chart is redrawn (its art replaced:
// `document.add-item` and `item.delete`). Those writes come after the
// field's own, so they are checked FIRST, against the template's policy
// labels, and a field whose page could not follow is refused before
// anything changes.

import type {
  Address,
  BundleHost,
  Disposable,
  ObjectValue,
  ObjectsSurface,
  TemplateFieldControl,
  TemplateFieldKindContribution,
  TemplateFieldRef,
  TemplateFieldWrite,
} from "@paged-media/plugin-api";
import { parseBinding } from "../../sheet-host-model/src";

import type { ResolvedRange, SheetEngine } from "./engine";
import { PLUGIN_ID, type SheetObjectModel } from "./object-model";
import type { WorkbookSession } from "./session";

const P = `plugin:${PLUGIN_ID}`;
export const CELL_FIELD = `${PLUGIN_ID}.cell`;
export const RANGE_FIELD = `${PLUGIN_ID}.range`;
export const CHART_SOURCE_FIELD = `${PLUGIN_ID}.chartSource`;

/** The kinds, as the manifest declares them. */
export const SHEET_TEMPLATE_FIELDS = [
  { kind: CELL_FIELD, title: "Sheet cell" },
  { kind: RANGE_FIELD, title: "Sheet range" },
  { kind: CHART_SOURCE_FIELD, title: "Chart data" },
] as const;

/** What re-pouring a placed table takes (its text and its cell styles). */
const TABLE_GRANTS = ["text.edit", "text.style"];

// ───────────────────────────────────────────────────────── definitions

export interface CellDef {
  ref: string;
  type?: "text" | "number";
  allowed?: string[];
  min?: number;
  max?: number;
}

export interface RangeDef {
  ref: string;
  columns?: string[];
  rows?: "fixed" | { min?: number; max?: number };
}

export interface ChartSeriesDef {
  values: string;
  categories?: string;
  name?: string;
  color?: string;
}

export interface ChartSourceDef {
  chart: number;
  allowed: { name: string; label?: string; series: ChartSeriesDef[] }[];
}

class Problem extends Error {}

const escapeId = (t: string): string =>
  t.replace(/%/g, "%25").replace(/ /g, "%20");

const valueOf = (v: ObjectValue): unknown => {
  if (v.kind === "value") return v.value;
  if (v.kind === "refused") throw new Problem(v.reason);
  return null;
};

function defOf<T>(field: TemplateFieldRef, needs: string): T {
  const d = field.def;
  if (!d || typeof d !== "object" || !(needs in (d as object)))
    throw new Problem(
      `The field "${field.name}" has no ${needs} in its definition.`,
    );
  return d as T;
}

/** `Sheet!A1` → its parts (the sheet optionally quoted). */
function splitSheet(id: string): { sheet: string; rest: string } | null {
  const bang = id.lastIndexOf("!");
  if (bang <= 0) return null;
  let sheet = id.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'"))
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return { sheet, rest: id.slice(bang + 1) };
}

/** A label's envelope data (`labels` maps a key to its JSON text). */
function labelData(
  labels: unknown,
  key: string,
): Record<string, unknown> | null {
  const raw = (labels as Record<string, unknown> | null)?.[key];
  let env: unknown = raw;
  if (typeof raw === "string") {
    try {
      env = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const data = (env as { data?: unknown } | null)?.data;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : null;
}

async function labelsOf(
  objects: ObjectsSurface,
  address: string,
): Promise<unknown> {
  try {
    const v = await objects.get(address as Address, "labels");
    return v.kind === "value" ? v.value : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────── the template's policy, read

/** What each engine field kind grants on its item (paged-template's
 *  `TemplateFieldKind::grants`). */
const FIELD_GRANTS: Record<string, string[]> = {
  text: ["select", "text.edit"],
  textRun: ["select", "text.edit"],
  variable: ["select", "text.edit"],
  image: ["select", "image.replace"],
  choice: ["select"],
  visibility: ["select", "item.visibility"],
  data: ["select", "text.edit", "image.replace"],
  module: ["select", "document.metadata"],
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The permission of `perms` a filler lacks on `item` (null = the
 *  document), read from the template's policy labels the way the engine
 *  resolves them (the document's defaults, the item's field grants and its
 *  allow and deny lists), or null when it has them all. The engine stays the
 *  authority: this only lets a field refuse before a write it could not
 *  finish. */
async function fillerLacks(
  objects: ObjectsSurface,
  item: string | null,
  perms: readonly string[],
): Promise<string | null> {
  const doc = labelData(await labelsOf(objects, "doc"), "x-paged:template");
  const have = new Set(strings(doc?.defaults));
  if (item) {
    const policy = labelData(await labelsOf(objects, item), "x-paged:template");
    const field = policy?.field as
      { kind?: string; module?: { grants?: unknown } | null } | undefined;
    if (field?.kind) {
      for (const p of FIELD_GRANTS[field.kind] ?? []) have.add(p);
      if (field.kind === "module")
        for (const p of strings(field.module?.grants))
          if (p !== "template.author") have.add(p);
    }
    for (const p of strings(policy?.allow)) have.add(p);
    for (const p of strings(policy?.deny)) have.delete(p);
  }
  return perms.find((p) => !have.has(p)) ?? null;
}

/** The page items that may carry a placement's binding. */
const ITEM_KINDS = ["textFrame", "rectangle", "polygon", "graphicLine", "oval"];

/** Every placement on the page: the item and its binding (sheet + range,
 *  `chart:<n>` for a chart). */
async function placements(
  objects: ObjectsSurface,
): Promise<{ address: string; sheet: string; range: string }[]> {
  const out: { address: string; sheet: string; range: string }[] = [];
  for (const kind of ITEM_KINDS) {
    let addresses: readonly string[] = [];
    try {
      addresses = await objects.query(kind);
    } catch {
      continue;
    }
    for (const address of addresses) {
      const labels = (await labelsOf(objects, address)) as Record<
        string,
        unknown
      > | null;
      const raw = labels?.[`x-paged:${PLUGIN_ID}`];
      if (raw === undefined) continue;
      let env: unknown = raw;
      try {
        if (typeof raw === "string") env = JSON.parse(raw);
      } catch {
        continue;
      }
      const b = parseBinding(env);
      if (b) out.push({ address, sheet: b.data.sheet, range: b.data.range });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────── the kinds

export function contributeSheetTemplateFields(
  host: BundleHost,
  session: WorkbookSession,
  model: SheetObjectModel,
): Disposable {
  const bridge = session.objectBridge();

  /** The workbook as the document names it (a restore or a document open
   *  may still be loading it). */
  async function engine(): Promise<SheetEngine> {
    await session.ensureRestored();
    await model.reconcile();
    // The tables an earlier session placed, known before a write so the
    // write's refresh re-pours them (and stamps them from their own count).
    await bridge.discoverHostFrames();
    const e = bridge.engine();
    if (!e) throw new Problem("No workbook is open in this document.");
    return e;
  }

  /** `ref` (`Sheet!A1:B2` or a defined name) resolved by the engine. */
  async function resolve(
    objects: ObjectsSurface,
    e: SheetEngine,
    ref: string,
  ): Promise<{ id: string; r: ResolvedRange }> {
    let id = ref.trim();
    if (!splitSheet(id)) {
      const named = await objects.get(
        `${P}/namedRange/${escapeId(id)}` as Address,
        "refersTo",
      );
      if (named.kind !== "value")
        throw new Problem(`The workbook has no range named "${ref}".`);
      id = String(named.value).replace(/^=/, "").replace(/\$/g, "");
    }
    const parts = splitSheet(id);
    if (!parts) throw new Problem(`"${ref}" does not name a sheet's cells.`);
    const sheet = e
      .listSheets()
      .find((s) => s.name.toLowerCase() === parts.sheet.toLowerCase());
    if (!sheet || !e.resolveRange)
      throw new Problem(`The workbook has no sheet named "${parts.sheet}".`);
    try {
      return { id, r: e.resolveRange(sheet.id, parts.rest) };
    } catch {
      throw new Problem(`"${ref}" is not a range of the workbook.`);
    }
  }

  /** Refuse when a placed table showing `r` could not be re-poured by a
   *  filler (the field's own item excepted: its field grants say). */
  async function pageFollows(
    objects: ObjectsSurface,
    e: SheetEngine,
    r: ResolvedRange,
    ref: string,
  ): Promise<void> {
    for (const p of await placements(objects)) {
      if (p.range.startsWith("chart:")) continue;
      const sheet = e.listSheets().find((s) => s.name === p.sheet);
      if (!sheet || sheet.id !== r.sheet || !e.resolveRange) continue;
      let shown: ResolvedRange;
      try {
        shown = e.resolveRange(sheet.id, p.range);
      } catch {
        continue;
      }
      const meets =
        shown.top <= r.bottom &&
        r.top <= shown.bottom &&
        shown.left <= r.right &&
        r.left <= shown.right;
      if (!meets) continue;
      const lacks = await fillerLacks(objects, p.address, TABLE_GRANTS);
      if (lacks)
        throw new Problem(
          `${ref} is also shown in a table this template does not open (${p.address} needs ${lacks}); make that frame a sheet field too.`,
        );
    }
  }

  /** Commit `ops` as ONE write; a refusal is a sentence and the engine goes
   *  back to the version the document names. The page then follows. */
  async function commit(
    objects: ObjectsSurface,
    ops: Parameters<ObjectsSurface["batch"]>[0],
  ): Promise<TemplateFieldWrite> {
    const out = await objects.batch(ops, { label: "Fill template field" });
    if (!out.applied) {
      await model.reconcile();
      const reason = out.reason ?? out.code ?? "refused";
      return {
        ok: false,
        problem: /document\.metadata/.test(reason)
          ? "This template does not let a filler change the workbook: its document policy must grant document.metadata (the workbook's version is the document's label)."
          : `The workbook could not be changed: ${reason}`,
      };
    }
    await session.refreshPlacements();
    return { ok: true };
  }

  const guard = async (
    run: () => Promise<TemplateFieldWrite>,
  ): Promise<TemplateFieldWrite> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof Problem) return { ok: false, problem: err.message };
      throw err;
    }
  };

  // ── cell ─────────────────────────────────────────────────────────────

  const cellControl = (d: CellDef): TemplateFieldControl =>
    d.allowed && d.allowed.length > 0
      ? { kind: "choice", options: d.allowed.map((value) => ({ value })) }
      : d.type === "number"
        ? {
            kind: "number",
            ...(d.min !== undefined ? { min: d.min } : {}),
            ...(d.max !== undefined ? { max: d.max } : {}),
          }
        : { kind: "text" };

  const cell: TemplateFieldKindContribution<string | number> = {
    kind: CELL_FIELD,
    title: "Sheet cell",
    control: { kind: "text" },
    grants: TABLE_GRANTS,
    describe: (_ctx, field) => cellControl(defOf<CellDef>(field, "ref")),
    async read({ objects }, field) {
      const d = defOf<CellDef>(field, "ref");
      const { id, r } = await resolve(objects, await engine(), d.ref);
      if (r.top !== r.bottom || r.left !== r.right)
        throw new Problem(`"${d.ref}" is not one cell.`);
      const v = valueOf(
        await objects.get(`${P}/cell/${escapeId(id)}` as Address, "value"),
      );
      if (v === null || v === "") return null;
      return d.type === "number" && !d.allowed ? Number(v) : String(v);
    },
    write: ({ objects }, field, value) =>
      guard(async () => {
        const d = defOf<CellDef>(field, "ref");
        let text: string;
        if (d.allowed && d.allowed.length > 0) {
          text = String(value);
          if (!d.allowed.includes(text))
            return {
              ok: false,
              problem: `"${text}" is not one of the choices (${d.allowed.join(", ")}).`,
            };
        } else if (d.type === "number") {
          const n = typeof value === "number" ? value : Number(value);
          if (typeof value === "boolean" || !Number.isFinite(n))
            return {
              ok: false,
              problem: `"${String(value)}" is not a number.`,
            };
          if (d.min !== undefined && n < d.min)
            return { ok: false, problem: `${n} is less than ${d.min}.` };
          if (d.max !== undefined && n > d.max)
            return { ok: false, problem: `${n} is more than ${d.max}.` };
          text = String(n);
        } else {
          text = String(value ?? "");
        }
        if (text.startsWith("="))
          return {
            ok: false,
            problem: "A formula cannot be entered into a template field.",
          };
        const e = await engine();
        const { id, r } = await resolve(objects, e, d.ref);
        if (r.top !== r.bottom || r.left !== r.right)
          return { ok: false, problem: `"${d.ref}" is not one cell.` };
        const address = `${P}/cell/${escapeId(id)}` as Address;
        if (valueOf(await objects.get(address, "formula")) !== null)
          return {
            ok: false,
            problem: `${id} holds a formula; a template opens constant cells only.`,
          };
        // The value it already holds: nothing to write, no undo step.
        if (String(valueOf(await objects.get(address, "value")) ?? "") === text)
          return { ok: true };
        await pageFollows(objects, e, r, id);
        return commit(objects, [
          { op: "set", address, path: "value", value: text },
        ]);
      }),
  };

  // ── range ────────────────────────────────────────────────────────────

  const letters = (col: number): string => {
    let n = col;
    let label = "";
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  };

  const columnsOf = (d: RangeDef, r: ResolvedRange) =>
    Array.from({ length: r.right - r.left + 1 }, (_, i) => ({
      name: letters(r.left + i),
      ...(d.columns?.[i] ? { title: d.columns[i] } : {}),
    }));

  const growable = (d: RangeDef) =>
    typeof d.rows === "object" && d.rows !== null;

  const range: TemplateFieldKindContribution<string[][]> = {
    kind: RANGE_FIELD,
    title: "Sheet range",
    control: { kind: "table", columns: [] },
    grants: TABLE_GRANTS,
    async describe({ objects }, field) {
      const d = defOf<RangeDef>(field, "ref");
      const { r } = await resolve(objects, await engine(), d.ref);
      return { kind: "table", columns: columnsOf(d, r) };
    },
    async read({ objects }, field) {
      const d = defOf<RangeDef>(field, "ref");
      const { id } = await resolve(objects, await engine(), d.ref);
      const rows = valueOf(
        await objects.get(`${P}/range/${escapeId(id)}` as Address, "values"),
      ) as string[][] | null;
      if (!rows) return null;
      if (!growable(d)) return rows;
      // A growable range's blank rows at the end are rows not filled in.
      let n = rows.length;
      while (n > 0 && rows[n - 1]!.every((c) => c === "")) n--;
      return rows.slice(0, n);
    },
    write: ({ objects }, field, value) =>
      guard(async () => {
        const d = defOf<RangeDef>(field, "ref");
        const e = await engine();
        const { id, r } = await resolve(objects, e, d.ref);
        const height = r.bottom - r.top + 1;
        const width = r.right - r.left + 1;
        if (!Array.isArray(value) || value.some((row) => !Array.isArray(row)))
          return { ok: false, problem: "The value is not a table of rows." };
        const rows = value.map((row) =>
          (row as unknown[]).map((c) =>
            c === null || c === undefined ? "" : String(c),
          ),
        );
        const bad = rows.findIndex((row) => row.length !== width);
        if (bad >= 0)
          return {
            ok: false,
            problem: `Row ${bad + 1} has ${rows[bad]!.length} values; the table has ${width} columns.`,
          };
        if (rows.some((row) => row.some((c) => c.startsWith("="))))
          return {
            ok: false,
            problem: "A formula cannot be entered into a template field.",
          };
        if (growable(d)) {
          const lim = d.rows as { min?: number; max?: number };
          const max = Math.min(lim.max ?? height, height);
          if (rows.length > max)
            return {
              ok: false,
              problem: `The table takes at most ${max} rows; ${rows.length} were given.`,
            };
          if (lim.min !== undefined && rows.length < lim.min)
            return {
              ok: false,
              problem: `The table needs at least ${lim.min} rows; ${rows.length} were given.`,
            };
          while (rows.length < height) rows.push(Array(width).fill(""));
        } else if (rows.length !== height) {
          return {
            ok: false,
            problem: `The table has ${height} rows; ${rows.length} were given.`,
          };
        }
        const address = `${P}/range/${escapeId(id)}` as Address;
        const inputs = valueOf(await objects.get(address, "inputs")) as
          string[][] | null;
        if (inputs?.some((row) => row.some((c) => c.startsWith("="))))
          return {
            ok: false,
            problem: `${id} holds formulas; a template opens constant cells only.`,
          };
        const now = valueOf(await objects.get(address, "values"));
        if (JSON.stringify(now) === JSON.stringify(rows)) return { ok: true };
        await pageFollows(objects, e, r, id);
        return commit(objects, [
          { op: "set", address, path: "values", value: rows },
        ]);
      }),
  };

  // ── chartSource ──────────────────────────────────────────────────────

  const seriesKey = (list: readonly ChartSeriesDef[]) =>
    JSON.stringify(
      list.map((x) => [
        x.values.replace(/\$/g, ""),
        (x.categories ?? "").replace(/\$/g, ""),
      ]),
    );

  const chartSource: TemplateFieldKindContribution<string> = {
    kind: CHART_SOURCE_FIELD,
    title: "Chart data",
    control: { kind: "choice", options: [] },
    describe(_ctx, field) {
      const d = defOf<ChartSourceDef>(field, "allowed");
      return {
        kind: "choice",
        options: d.allowed.map((a) => ({
          value: a.name,
          ...(a.label ? { label: a.label } : {}),
        })),
      };
    },
    async read({ objects }, field) {
      const d = defOf<ChartSourceDef>(field, "allowed");
      await engine();
      const now = valueOf(
        await objects.get(`${P}/chart/${d.chart}` as Address, "series"),
      ) as ChartSeriesDef[] | null;
      if (!now) return null;
      const key = seriesKey(now);
      return d.allowed.find((a) => seriesKey(a.series) === key)?.name ?? null;
    },
    write: ({ objects }, field, value) =>
      guard(async () => {
        const d = defOf<ChartSourceDef>(field, "allowed");
        const choice = d.allowed.find((a) => a.name === String(value));
        if (!choice)
          return {
            ok: false,
            problem: `"${String(value)}" is not one of the choices (${d.allowed.map((a) => a.name).join(", ")}).`,
          };
        await engine();
        const address = `${P}/chart/${d.chart}` as Address;
        valueOf(await objects.get(address, "kind")); // the chart exists
        // A placed chart is redrawn: its art is replaced.
        for (const p of await placements(objects)) {
          if (p.range !== `chart:${d.chart}`) continue;
          const lacks =
            (await fillerLacks(objects, null, ["document.add-item"])) ??
            (await fillerLacks(objects, p.address, ["item.delete"]));
          if (lacks)
            return {
              ok: false,
              problem: `The chart is placed on the page and redrawing it replaces its artwork, which this template does not allow (${lacks}).`,
            };
        }
        return commit(objects, [
          {
            op: "set",
            address,
            path: "series",
            value: choice.series.map((x) => ({
              values: x.values,
              categories: x.categories ?? "",
              name: x.name ?? "",
              color: x.color ?? "",
            })),
          },
        ]);
      }),
  };

  return host.contribute.objectModel({
    kinds: [],
    templateFields: [
      cell,
      range,
      chartSource,
    ] as TemplateFieldKindContribution[],
  });
}
