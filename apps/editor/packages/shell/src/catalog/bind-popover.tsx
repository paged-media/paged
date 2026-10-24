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

// The bind popover (editor ADR 292): "Bind to data…" on any property field
// opens it when a bundle serves the document's data (`data@1`). Four ways to
// bind, one live preview:
//
//   · Field      — a searchable list of the query's fields, typed;
//   · Rules      — `when <field> <op> <value> then <result>` rows, first match
//                  wins, and an otherwise;
//   · Map        — a field's values looked up, with a default;
//   · Expression — any expression of the binding language.
//
// Each mode compiles to one expression (`bind-expr.ts`); the record stepper
// asks the service what it gives at each record (`data.evaluate`), so the
// author sees the value before binding, and the engine coerces it to the
// property's schema row when it applies (ADR 558). Bind hands the service
// the durable target, the path and the expression (`data.bind`).

import { useEffect, useState, type ReactNode } from "react";

import type {
  DataEvaluation,
  DataService,
  DataTableInfo,
  ProviderField,
} from "@paged-media/plugin-api";
import { useStrings } from "@paged-media/strings";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { useDataRevision } from "../state/data-door";
import {
  compileMap,
  compileRules,
  fieldRef,
  type BindMapEntry,
  type BindRule,
  type CompileResult,
  type RuleOp,
} from "./bind-expr";
import { BIND } from "./messages";

export type BindMode = "field" | "rules" | "map" | "expression";

/** What the popover binds: a durable target, a property path and its row. */
export interface BindTarget {
  selector: string;
  path: string;
  /** The property's display name. */
  label: string;
}

const OPS: { op: RuleOp; key: keyof typeof BIND }[] = [
  { op: "=", key: "opEquals" },
  { op: "<>", key: "opNot" },
  { op: "<", key: "opLess" },
  { op: "<=", key: "opLessEq" },
  { op: ">", key: "opMore" },
  { op: ">=", key: "opMoreEq" },
  { op: "contains", key: "opContains" },
  { op: "blank", key: "opBlank" },
];

const input =
  "h-[24px] min-w-0 rounded-[4px] border border-input bg-[var(--pg-bg)] px-1.5 text-xs";
const chip =
  "rounded-[3px] px-1 font-mono text-[10px] text-[var(--pg-muted-fg)] border border-input";

/** The expression a mode's state compiles to. */
export function compiled(
  mode: BindMode,
  s: {
    field: string;
    rules: BindRule[];
    otherwise: string;
    mapField: string;
    entries: BindMapEntry[];
    mapDefault: string;
    expression: string;
  },
): CompileResult {
  switch (mode) {
    case "field": {
      const f = fieldRef(s.field);
      return f ? { expr: f } : { error: "pick a field" };
    }
    case "rules":
      return compileRules(s.rules, s.otherwise);
    case "map":
      return compileMap(s.mapField, s.entries, s.mapDefault);
    case "expression":
      return s.expression.trim()
        ? { expr: s.expression.trim() }
        : { error: "write an expression" };
  }
}

function FieldSelect({
  fields,
  value,
  onChange,
}: {
  fields: readonly ProviderField[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className={input}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {fields.map((f) => (
        <option key={f.name} value={f.name}>
          {f.name}
        </option>
      ))}
    </select>
  );
}

export function BindPopover({
  service,
  target,
  onClose,
  onBound,
}: {
  service: DataService;
  target: BindTarget | null;
  onClose: () => void;
  onBound?: (id: string) => void;
}) {
  const { t } = useStrings();
  const revision = useDataRevision();
  const [queries, setQueries] = useState<readonly DataTableInfo[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<BindMode>("field");
  const [search, setSearch] = useState("");
  const [field, setField] = useState("");
  const [rules, setRules] = useState<BindRule[]>([]);
  const [otherwise, setOtherwise] = useState("");
  const [mapField, setMapField] = useState("");
  const [entries, setEntries] = useState<BindMapEntry[]>([]);
  const [mapDefault, setMapDefault] = useState("");
  const [expression, setExpression] = useState("");
  const [record, setRecord] = useState(0);
  // The preview answered for `key` (query, expression, record): a stale
  // answer is not shown while the next one is on its way.
  const [answer, setAnswer] = useState<{
    key: string;
    value: DataEvaluation;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // The queries (an expression reads a query's fields).
  useEffect(() => {
    if (!target) return;
    let live = true;
    void Promise.resolve(service.tables()).then((all) => {
      if (!live) return;
      const qs = all.filter((x) => x.kind === "query");
      setQueries(qs);
      setQuery((q) =>
        q && qs.some((x) => x.name === q) ? q : (qs[0]?.name ?? ""),
      );
    });
    return () => {
      live = false;
    };
  }, [service, target, revision]);

  const table = queries.find((q) => q.name === query) ?? null;
  const fields = table?.schema.fields ?? [];
  const count = table?.rowCount ?? 0;
  const result = compiled(mode, {
    field,
    rules,
    otherwise,
    mapField: mapField || fields[0]?.name || "",
    entries,
    mapDefault,
    expression,
  });
  const expr = "expr" in result ? result.expr : null;

  // The live preview at the stepped record.
  const previewKey =
    expr && query ? `${query}\u0000${expr}\u0000${record}` : null;
  useEffect(() => {
    if (!previewKey || !expr || typeof service.evaluate !== "function") return;
    let live = true;
    void service.evaluate(query, expr, record).then(
      (value) => {
        if (live) setAnswer({ key: previewKey, value });
      },
      (err: unknown) => {
        if (live)
          setAnswer({
            key: previewKey,
            value: { display: "", value: null, error: String(err) },
          });
      },
    );
    return () => {
      live = false;
    };
  }, [service, query, expr, record, previewKey, revision]);
  const preview = answer && answer.key === previewKey ? answer.value : null;

  const step = (d: number) =>
    setRecord((r) => Math.max(0, Math.min(Math.max(count - 1, 0), r + d)));
  const newRule = (): BindRule => ({
    field: fields[0]?.name ?? "",
    op: "=",
    value: "",
    result: "",
  });
  const bind = () => {
    if (!target || !expr || !query) return;
    setFailure(null);
    const bindFn = service.bind;
    if (typeof bindFn !== "function") {
      setFailure("the data service does not bind");
      return;
    }
    void bindFn
      .call(service, {
        target: target.selector,
        path: target.path,
        query,
        expr,
      })
      .then(
        (b) => {
          onBound?.(b.id);
          onClose();
        },
        (err: unknown) =>
          setFailure(err instanceof Error ? err.message : String(err)),
      );
  };

  const tab = (m: BindMode, label: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      data-bind-mode={m}
      className={`h-[24px] rounded-[4px] px-2 text-xs ${mode === m ? "bg-[var(--chrome-slot-active)] font-medium" : ""}`}
      onClick={() => setMode(m)}
    >
      {label}
    </button>
  );

  const shown = fields.filter((f) =>
    f.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-bind-popover="" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(BIND.title, { property: target?.label ?? "" })}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] break-all">
            {target?.selector}
          </DialogDescription>
        </DialogHeader>

        {queries.length === 0 ? (
          <p data-bind-no-data="" className="text-xs text-[var(--pg-muted-fg)]">
            {t(BIND.noData)}
          </p>
        ) : (
          <div className="flex flex-col gap-2 text-xs">
            <label className="flex items-center gap-2">
              <span className="w-[64px] text-[var(--pg-muted-fg)]">
                {t(BIND.query)}
              </span>
              <select
                data-bind-query=""
                className={input}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setRecord(0);
                }}
              >
                {queries.map((q) => (
                  <option key={q.name} value={q.name}>
                    {q.name}
                  </option>
                ))}
              </select>
            </label>

            <div role="tablist" className="flex gap-1">
              {tab("field", t(BIND.modeField))}
              {tab("rules", t(BIND.modeRules))}
              {tab("map", t(BIND.modeMap))}
              {tab("expression", t(BIND.modeExpression))}
            </div>

            {mode === "field" && (
              <div className="flex flex-col gap-1">
                <input
                  data-bind-search=""
                  className={input}
                  placeholder={t(BIND.search)}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div
                  role="listbox"
                  className="max-h-[180px] overflow-auto rounded-[4px] border border-input"
                >
                  {shown.length === 0 && (
                    <div className="px-2 py-1 text-[var(--pg-muted-fg)]">
                      {t(BIND.noFields)}
                    </div>
                  )}
                  {shown.map((f) => {
                    const readable = fieldRef(f.name) !== null;
                    return (
                      <button
                        key={f.name}
                        type="button"
                        role="option"
                        aria-selected={field === f.name}
                        data-bind-field={f.name}
                        disabled={!readable}
                        title={readable ? undefined : t(BIND.unreadable)}
                        className={`flex w-full items-center justify-between px-2 py-[3px] text-left ${field === f.name ? "bg-[var(--chrome-slot-active)]" : ""} ${readable ? "" : "opacity-50"}`}
                        onClick={() => setField(f.name)}
                      >
                        <span>{f.name}</span>
                        <span className={chip}>{f.ty}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {mode === "rules" && (
              <div className="flex flex-col gap-1" data-bind-rules="">
                {rules.map((r, i) => {
                  const set = (patch: Partial<BindRule>) =>
                    setRules(
                      rules.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                    );
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-1"
                      data-bind-rule={i}
                    >
                      <span className="w-[36px] text-[var(--pg-muted-fg)]">
                        {t(BIND.when)}
                      </span>
                      <FieldSelect
                        fields={fields}
                        value={r.field}
                        onChange={(v) => set({ field: v })}
                      />
                      <select
                        className={input}
                        value={r.op}
                        onChange={(e) => set({ op: e.target.value as RuleOp })}
                      >
                        {OPS.map((o) => (
                          <option key={o.op} value={o.op}>
                            {t(BIND[o.key])}
                          </option>
                        ))}
                      </select>
                      {r.op !== "blank" && (
                        <input
                          className={`${input} w-[72px]`}
                          value={r.value}
                          onChange={(e) => set({ value: e.target.value })}
                        />
                      )}
                      <span className="text-[var(--pg-muted-fg)]">
                        {t(BIND.then)}
                      </span>
                      <input
                        className={`${input} w-[72px]`}
                        aria-label={t(BIND.result)}
                        value={r.result}
                        onChange={(e) => set({ result: e.target.value })}
                      />
                      <button
                        type="button"
                        aria-label={t(BIND.removeRule)}
                        className="px-1 text-[var(--pg-muted-fg)]"
                        onClick={() =>
                          setRules(rules.filter((_, j) => j !== i))
                        }
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="self-start text-[var(--pg-primary)]"
                  onClick={() => setRules([...rules, newRule()])}
                >
                  + {t(BIND.addRule)}
                </button>
                <label className="flex items-center gap-1">
                  <span className="w-[64px] text-[var(--pg-muted-fg)]">
                    {t(BIND.otherwise)}
                  </span>
                  <input
                    className={`${input} w-[96px]`}
                    value={otherwise}
                    onChange={(e) => setOtherwise(e.target.value)}
                  />
                </label>
              </div>
            )}

            {mode === "map" && (
              <div className="flex flex-col gap-1" data-bind-map="">
                <label className="flex items-center gap-1">
                  <span className="w-[64px] text-[var(--pg-muted-fg)]">
                    {t(BIND.mapField)}
                  </span>
                  <FieldSelect
                    fields={fields}
                    value={mapField || fields[0]?.name || ""}
                    onChange={setMapField}
                  />
                </label>
                {entries.map((e, i) => {
                  const set = (patch: Partial<BindMapEntry>) =>
                    setEntries(
                      entries.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                    );
                  return (
                    <div key={i} className="flex items-center gap-1">
                      <input
                        className={`${input} w-[96px]`}
                        aria-label={t(BIND.key)}
                        value={e.key}
                        onChange={(ev) => set({ key: ev.target.value })}
                      />
                      <span className="text-[var(--pg-muted-fg)]">→</span>
                      <input
                        className={`${input} w-[96px]`}
                        aria-label={t(BIND.result)}
                        value={e.value}
                        onChange={(ev) => set({ value: ev.target.value })}
                      />
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="self-start text-[var(--pg-primary)]"
                  onClick={() =>
                    setEntries([...entries, { key: "", value: "" }])
                  }
                >
                  + {t(BIND.addEntry)}
                </button>
                <label className="flex items-center gap-1">
                  <span className="w-[64px] text-[var(--pg-muted-fg)]">
                    {t(BIND.otherwise)}
                  </span>
                  <input
                    className={`${input} w-[96px]`}
                    value={mapDefault}
                    onChange={(e) => setMapDefault(e.target.value)}
                  />
                </label>
              </div>
            )}

            {mode === "expression" && (
              <textarea
                data-bind-expression=""
                className="min-h-[56px] rounded-[4px] border border-input bg-[var(--pg-bg)] p-1.5 font-mono text-xs"
                placeholder={t(BIND.expressionHint)}
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
              />
            )}

            <div
              className="rounded-[4px] border border-input p-2"
              data-bind-preview=""
            >
              <div className="flex items-center justify-between">
                <span
                  className="font-mono text-[10px] text-[var(--pg-muted-fg)] break-all"
                  data-bind-compiled=""
                >
                  {expr ?? ("error" in result ? result.error : "")}
                </span>
                <span className="flex items-center gap-1 whitespace-nowrap">
                  <button
                    type="button"
                    aria-label={t(BIND.previous)}
                    onClick={() => step(-1)}
                  >
                    ‹
                  </button>
                  <span className="text-[var(--pg-muted-fg)]">
                    {t(BIND.preview, {
                      n: count === 0 ? 0 : record + 1,
                      count,
                    })}
                  </span>
                  <button
                    type="button"
                    aria-label={t(BIND.next)}
                    onClick={() => step(1)}
                  >
                    ›
                  </button>
                </span>
              </div>
              <div
                data-bind-value=""
                className="mt-1 font-mono text-sm"
                style={{
                  color: preview?.error
                    ? "var(--status-error)"
                    : "var(--pg-fg)",
                }}
              >
                {preview?.error
                  ? t(BIND.previewError, { error: preview.error })
                  : (preview?.display ?? "")}
              </div>
            </div>
            {failure && (
              <p
                data-bind-failure=""
                className="text-xs"
                style={{ color: "var(--status-error)" }}
              >
                {failure}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <button
            type="button"
            className="h-[28px] rounded-[6px] border border-input px-3 text-xs"
            onClick={onClose}
          >
            {t(BIND.cancel)}
          </button>
          <button
            type="button"
            data-bind-confirm=""
            disabled={!expr || !query}
            className="h-[28px] rounded-[6px] bg-[var(--pg-primary)] px-3 text-xs text-[var(--pg-primary-fg)] disabled:opacity-50"
            onClick={bind}
          >
            {t(BIND.bind)}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
