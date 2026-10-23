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

// paged.data's TEMPLATE FIELD KINDS (editor plan G3; extensions ADR 335) and
// its read-only inspection commands (plan G4).
//
//   media.paged.data.record        { query, label? }
//       which record of a query fills the document (a choice; "1" is the
//       first record, `label` names the column the options show)
//   media.paged.data.bindingValue  { binding }
//       a property or visibility binding's value, set by hand and PINNED so
//       a refresh leaves it (ADR 553); the control follows the property's
//       type (a number, a toggle, a choice, a text)
//   media.paged.data.dataSet       { allowed? }
//       which captured data set the document shows (§9.9, applied as ONE
//       batch)
//   media.paged.data.variable      { name }
//       a variable of the variable set, by its name (a property or
//       visibility variable; a text variable fills through its frame)
//
// Writes go through the lanes the panels use (the property lane's one
// `host.objects` batch, the preview lanes, `applyDataSet`), so the engine
// checks each against the session's role and a refusal comes back as a
// sentence. The chosen record and the applied data set are saved with the
// session (`persist.ts`), so a reopened document reads them and
// `paged template check` can refill a submission.

import type {
  Address,
  ObjectsSurface,
  TemplateFieldControl,
  TemplateFieldKindContribution,
  TemplateFieldRef,
  TemplateFieldWrite,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";

import { t as tr } from "@paged-media/strings";

import { TEMPLATE as M } from "./messages";
import type { DataSourceSession } from "./session";

export const RECORD_FIELD = "media.paged.data.record";
export const BINDING_VALUE_FIELD = "media.paged.data.bindingValue";
export const DATA_SET_FIELD = "media.paged.data.dataSet";
export const VARIABLE_FIELD = "media.paged.data.variable";

/** What the property and visibility lanes write on the field's item. */
const DATA_GRANTS = ["text.edit", "image.replace", "item.visibility"];

class Problem extends Error {}

/** A refusal as a sentence: a permission the template withholds is named,
 *  anything else is passed on. */
function why(reason: string): string {
  const m =
    /NotPermitted \{ permission: \\?"([^"\\]+)\\?", target: \\?"([^"\\]+)/.exec(
      reason,
    ) ??
    /"permission":"([^"]+)","target":"([^"]+)"/.exec(reason.replace(/\\/g, ""));
  return m ? tr(M.notPermitted, { target: m[2]!, permission: m[1]! }) : reason;
}

function defOf<T>(field: TemplateFieldRef, needs: string): T {
  const d = field.def;
  if (!d || typeof d !== "object" || !(needs in (d as object)))
    throw new Problem(tr(M.fieldNeeds, { field: field.name, needs }));
  return d as T;
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

/** The kinds of page item a visibility binding's raw `Self` id may name. */
const ITEM_KINDS = [
  "rectangle",
  "textFrame",
  "oval",
  "polygon",
  "graphicLine",
  "group",
];

interface Target {
  address: string;
  path: string;
  control: TemplateFieldControl;
}

/** Where a binding writes, and the control its value takes. */
async function targetOf(
  objects: ObjectsSurface,
  session: DataSourceSession,
  binding: string,
): Promise<Target> {
  const def = (await session.bindingDefinition(binding)) as Record<
    string,
    unknown
  > | null;
  if (!def) throw new Problem(tr(M.bindingUndefined, { binding }));
  if (def.kind === "visibility") {
    const id = String(def.target ?? "");
    for (const kind of ITEM_KINDS) {
      const v = await objects
        .get(`${kind}:${id}` as Address, "elementVisible")
        .catch(() => null);
      if (v?.kind === "value")
        return {
          address: `${kind}:${id}`,
          path: "elementVisible",
          control: { kind: "toggle" },
        };
    }
    throw new Problem(tr(M.visibilityItemGone, { binding }));
  }
  if (def.kind !== "property")
    throw new Problem(tr(M.notAField, { kind: String(def.kind) }));
  const selector = (def.target as { selector?: string } | null)?.selector;
  const addresses = selector ? await objects.query(selector) : [];
  const address = addresses[0];
  if (!address) throw new Problem(tr(M.objectGone, { binding }));
  const path = String(def.path ?? "");
  const row = (await objects.schema(address as Address)).find(
    (r) => r.path === path,
  );
  const t = row?.type as ValueType | undefined;
  const control: TemplateFieldControl =
    t?.kind === "number" || t?.kind === "length"
      ? {
          kind: "number",
          ...(row?.range?.min !== undefined ? { min: row.range.min } : {}),
          ...(row?.range?.max !== undefined ? { max: row.range.max } : {}),
        }
      : t?.kind === "bool"
        ? { kind: "toggle" }
        : t?.kind === "enum"
          ? {
              kind: "choice",
              options: t.members.map((value) => ({ value })),
            }
          : { kind: "text" };
  return { address, path, control };
}

/** The value a control takes, or why not. */
function checked(control: TemplateFieldControl, value: unknown): unknown {
  switch (control.kind) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (typeof value === "boolean" || !Number.isFinite(n))
        throw new Problem(tr(M.notANumber, { value: String(value) }));
      if (control.min !== undefined && n < control.min)
        throw new Problem(tr(M.lessThan, { value: n, min: control.min }));
      if (control.max !== undefined && n > control.max)
        throw new Problem(tr(M.moreThan, { value: n, max: control.max }));
      return n;
    }
    case "toggle":
      if (typeof value !== "boolean")
        throw new Problem(tr(M.notOnOff, { value: String(value) }));
      return value;
    case "choice":
      if (!control.options.some((o) => o.value === String(value)))
        throw new Problem(
          tr(M.notAChoice, {
            value: String(value),
            choices: control.options.map((o) => o.value).join(", "),
          }),
        );
      return String(value);
    default:
      return String(value ?? "");
  }
}

/** Set a binding's target by hand and pin the binding, as one write. */
async function writeBinding(
  objects: ObjectsSurface,
  session: DataSourceSession,
  binding: string,
  value: unknown,
): Promise<TemplateFieldWrite> {
  const t = await targetOf(objects, session, binding);
  const v = checked(t.control, value);
  const wasPinned = session.syncStatusOf(binding) === "pinned";
  if (!wasPinned) session.setPinned(binding, true);
  const out = await objects.set(t.address as Address, t.path, v, {
    label: tr(M.fillUndo),
  });
  if (!out.applied) {
    if (!wasPinned) session.setPinned(binding, false);
    return {
      ok: false,
      problem: tr(M.notWritten, {
        reason: why(out.reason ?? out.code ?? "refused"),
      }),
    };
  }
  await session.flushPersist();
  return { ok: true };
}

async function readBinding(
  objects: ObjectsSurface,
  session: DataSourceSession,
  binding: string,
): Promise<unknown> {
  const t = await targetOf(objects, session, binding);
  const v = await objects.get(t.address as Address, t.path);
  return v.kind === "value" ? v.value : null;
}

// ─────────────────────────────────────────────────────────── the kinds

interface RecordDef {
  query: string;
  label?: string;
}

/** The records of `query` as choices: "1" is the first record. Read with
 *  a query preview, which ingests nothing: reading a field leaves every
 *  binding's sync state as it was. */
async function recordOptions(
  session: DataSourceSession,
  d: RecordDef,
): Promise<{ value: string; label?: string }[]> {
  await session.whenRestored();
  const q = session.listQueries().find((x) => x.id === d.query);
  if (!q) throw new Problem(tr(M.queryUndefined, { query: d.query }));
  const p = await session.previewQuery(q.sql, MAX_RECORDS);
  if (p.diagnostic)
    throw new Problem(
      tr(M.queryFailed, { query: d.query, problem: p.diagnostic.message }),
    );
  const col = d.label ? p.columns.findIndex((c) => c.name === d.label) : -1;
  return p.rows.map((row, i) => ({
    value: String(i + 1),
    ...(col >= 0 && row[col] ? { label: row[col]! } : {}),
  }));
}

/** A record field offers at most this many records. */
const MAX_RECORDS = 1000;

export function dataTemplateFields(
  session: DataSourceSession,
): TemplateFieldKindContribution[] {
  const record: TemplateFieldKindContribution<string> = {
    kind: RECORD_FIELD,
    title: "Data record",
    control: { kind: "choice", options: [] },
    grants: DATA_GRANTS,
    async describe(_ctx, field) {
      return {
        kind: "choice",
        options: await recordOptions(session, defOf<RecordDef>(field, "query")),
      };
    },
    async read(_ctx, field) {
      const d = defOf<RecordDef>(field, "query");
      await session.whenRestored();
      const at = session.getState().preview?.[d.query];
      return at === undefined ? null : String(at + 1);
    },
    write: (_ctx, field, value) =>
      guard(async () => {
        const d = defOf<RecordDef>(field, "query");
        const options = await recordOptions(session, d);
        if (!options.some((o) => o.value === String(value)))
          return {
            ok: false,
            problem:
              options.length === 0
                ? tr(M.noRecords, { query: d.query })
                : tr(M.notARecord, {
                    value: String(value),
                    query: d.query,
                    count: options.length,
                  }),
          };
        const at = Number(value) - 1;
        // The lanes resolve against the ingested result.
        if ((await session.recordCount(d.query)) === 0)
          await session.refreshData();
        const ids: string[] = [];
        const others: string[] = [];
        for (const b of session.listBindings()) {
          const def = (await session.bindingDefinition(b.id)) as {
            query?: string;
          } | null;
          if (def?.query !== d.query) continue;
          if (b.kind === "property" || b.kind === "visibility") ids.push(b.id);
          else if (b.kind !== "rule" && b.kind !== "recordFlow")
            others.push(b.id);
        }
        if (ids.length > 0) {
          const r = await session.applyProperties({
            record: at,
            ids,
            withVisibility: true,
          });
          const refused = Object.entries(r.skipped).filter(([, why]) =>
            /refused/.test(why),
          );
          if (refused.length > 0)
            return {
              ok: false,
              problem: tr(M.recordRefused, {
                record: at + 1,
                reason: why(refused[0]![1]),
              }),
            };
        }
        for (const id of others) await session.previewRecord(id, at);
        session.setPreviewPosition(d.query, at);
        await session.flushPersist();
        return { ok: true };
      }),
  };

  const bindingValue: TemplateFieldKindContribution = {
    kind: BINDING_VALUE_FIELD,
    title: "Data binding value",
    control: { kind: "text" },
    grants: DATA_GRANTS,
    async describe({ objects }, field) {
      const d = defOf<{ binding: string }>(field, "binding");
      await session.whenRestored();
      return (await targetOf(objects, session, d.binding)).control;
    },
    async read({ objects }, field) {
      const d = defOf<{ binding: string }>(field, "binding");
      await session.whenRestored();
      return readBinding(objects, session, d.binding);
    },
    write: ({ objects }, field, value) =>
      guard(async () => {
        const d = defOf<{ binding: string }>(field, "binding");
        await session.whenRestored();
        return writeBinding(objects, session, d.binding, value);
      }),
  };

  const setsOf = async (field: TemplateFieldRef) => {
    const allowed = (field.def as { allowed?: unknown } | null)?.allowed;
    await session.whenRestored();
    const all = await session.listDataSets();
    return Array.isArray(allowed)
      ? all.filter((n) => allowed.includes(n))
      : all;
  };

  const dataSet: TemplateFieldKindContribution<string> = {
    kind: DATA_SET_FIELD,
    title: "Data set",
    control: { kind: "choice", options: [] },
    grants: DATA_GRANTS,
    async describe(_ctx, field) {
      return {
        kind: "choice",
        options: (await setsOf(field)).map((value) => ({ value })),
      };
    },
    async read(_ctx, field) {
      const name = session.appliedDataSet();
      return name !== null && (await setsOf(field)).includes(name)
        ? name
        : null;
    },
    write: (_ctx, field, value) =>
      guard(async () => {
        const sets = await setsOf(field);
        const name = String(value);
        if (!sets.includes(name))
          return {
            ok: false,
            problem: tr(M.notADataSet, { name, sets: sets.join(", ") }),
          };
        const r = await session.applyDataSet(name);
        const skipped = Object.entries(r.skipped);
        if (r.applied === 0 && skipped.length > 0)
          return {
            ok: false,
            problem: tr(M.dataSetRefused, {
              name,
              reason: why(skipped[0]![1]),
            }),
          };
        await session.flushPersist();
        return { ok: true };
      }),
  };

  /** A variable is its binding's (one per bindable binding, §9.9). */
  const variableBinding = async (field: TemplateFieldRef): Promise<string> => {
    const d = defOf<{ name: string }>(field, "name");
    await session.whenRestored();
    const v = (await session.variables()).find((x) => x.name === d.name);
    if (!v) throw new Problem(tr(M.variableUndefined, { name: d.name }));
    if (!v.bound) throw new Problem(tr(M.variableUnbound, { name: d.name }));
    if (v.trait === "textcontent" || v.trait === "filereference")
      throw new Problem(tr(M.variableIsContent, { name: d.name }));
    return d.name;
  };

  const variable: TemplateFieldKindContribution = {
    kind: VARIABLE_FIELD,
    title: "Data variable",
    control: { kind: "text" },
    grants: DATA_GRANTS,
    async describe({ objects }, field) {
      return (await targetOf(objects, session, await variableBinding(field)))
        .control;
    },
    async read({ objects }, field) {
      return readBinding(objects, session, await variableBinding(field));
    },
    write: ({ objects }, field, value) =>
      guard(async () =>
        writeBinding(objects, session, await variableBinding(field), value),
      ),
  };

  return [
    record,
    bindingValue,
    dataSet,
    variable,
  ] as TemplateFieldKindContribution[];
}

// ─────────────────────────────────────────── inspection commands (G4)

const text: ValueType = { kind: "text" };
const texts: ValueType = { kind: "list", of: text };

/** The read-only inspection commands and the variable-library doors: none
 *  writes to the document. Declared in the manifest like the rest. */
export function inspectionCommands(
  session: DataSourceSession,
): TypedCommandContribution[] {
  return [
    {
      id: "media.paged.data.previewQuery",
      title: "Preview a query's rows",
      args: {
        kind: "struct",
        fields: {
          sql: text,
          limit: { kind: "number", integer: true, default: 50 },
        },
      },
      result: {
        kind: "struct",
        fields: {
          columns: texts,
          rows: { kind: "list", of: texts },
          total: { kind: "number", integer: true, optional: true },
          problem: { ...text, optional: true },
        },
      },
      async handler(_ctx, a) {
        const { sql, limit } = a as { sql: string; limit: number };
        await session.whenRestored();
        const p = await session.previewQuery(sql, limit);
        return {
          columns: p.columns.map((c) => c.name),
          rows: p.rows.map((r) => r.map((c) => c ?? "")),
          ...(p.total !== null ? { total: p.total } : {}),
          ...(p.diagnostic ? { problem: p.diagnostic.message } : {}),
        };
      },
    },
    {
      id: "media.paged.data.checkExpression",
      title: "Check a binding expression",
      args: {
        kind: "struct",
        fields: { expr: text, query: { ...text, optional: true } },
      },
      result: {
        kind: "struct",
        fields: {
          ok: { kind: "bool" },
          error: { ...text, optional: true },
          fields: texts,
          unknownFields: texts,
        },
      },
      async handler(_ctx, a) {
        const { expr, query } = a as { expr: string; query?: string };
        await session.whenRestored();
        const r = await session.checkExpression(expr, query);
        return {
          ok: r.ok,
          ...(r.error ? { error: r.error } : {}),
          fields: r.fields,
          unknownFields: r.unknownFields,
        };
      },
    },
    {
      id: "media.paged.data.refreshDiff",
      title: "What changed since the last refresh",
      args: { kind: "struct", fields: {} },
      result: {
        kind: "list",
        of: {
          kind: "struct",
          fields: {
            binding: text,
            change: text,
            before: { ...text, optional: true },
            after: { ...text, optional: true },
          },
        },
      },
      async handler() {
        await session.whenRestored();
        await session.refreshData();
        const r = await session.refreshDiff();
        return r.entries.map((e) => ({
          binding: e.binding,
          change: e.kind,
          ...(e.before !== undefined ? { before: e.before } : {}),
          ...(e.after !== undefined ? { after: e.after } : {}),
        }));
      },
    },
    {
      id: "media.paged.data.previewRecordFlow",
      title: "Preview a record flow's blocks",
      args: { kind: "struct", fields: { binding: text } },
      result: {
        kind: "struct",
        fields: {
          total: { kind: "number", integer: true },
          blocks: texts,
        },
      },
      async handler(_ctx, a) {
        const { binding } = a as { binding: string };
        await session.whenRestored();
        const p = await session.previewRecordFlow(binding);
        if (!p) throw new Error(`invalidValue: "${binding}" is no record flow`);
        return { total: p.total, blocks: p.blocks.map((b) => b.text) };
      },
    },
    {
      id: "media.paged.data.captureEveryRecord",
      title: "Capture a data set per record",
      args: {
        kind: "struct",
        fields: {
          query: text,
          prefix: { ...text, optional: true },
          nameColumn: { ...text, optional: true },
        },
      },
      result: texts,
      async handler(_ctx, a) {
        const { query, prefix, nameColumn } = a as {
          query: string;
          prefix?: string;
          nameColumn?: string;
        };
        await session.whenRestored();
        return session.captureEveryRecord(query, {
          ...(prefix !== undefined ? { prefix } : {}),
          ...(nameColumn !== undefined ? { nameColumn } : {}),
        });
      },
    },
    {
      id: "media.paged.data.exportVariableLibrary",
      title: "Export the variable library (XML)",
      args: { kind: "struct", fields: {} },
      result: text,
      async handler() {
        await session.whenRestored();
        return session.exportVariableLibrary();
      },
    },
    {
      id: "media.paged.data.importVariableLibrary",
      title: "Import a variable library (XML)",
      args: { kind: "struct", fields: { xml: text } },
      result: {
        kind: "struct",
        fields: {
          setName: text,
          variables: { kind: "number", integer: true },
          dataSets: { kind: "number", integer: true },
          unbound: texts,
          graphOnly: texts,
        },
      },
      async handler(_ctx, a) {
        await session.whenRestored();
        const r = await session.importVariableLibrary(
          (a as { xml: string }).xml,
        );
        return {
          setName: r.setName,
          variables: r.variables,
          dataSets: r.dataSets,
          unbound: r.unbound,
          graphOnly: r.graphOnly,
        };
      },
    },
  ];
}
