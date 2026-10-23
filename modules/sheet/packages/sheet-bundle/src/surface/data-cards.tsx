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

// The data cards of the sheet bar (sheet ADR 517): the entry alert, Data
// validation and the AutoFilter menu. Like paste special
// they hang under the bar, which is not scaled with the frame, so they read
// at any zoom. Each card takes a snapshot of what it edits when it opens
// (as Excel's dialogs do) and hands the answer to the session; the engine
// decides what it means.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { WorkbookSession } from "../session";
import type {
  FilterColumnValues,
  FilterCriterion,
  SortKey,
  ValidationRuleArg,
  ValidationRuleInfo,
} from "../engine-w2";
import type { DataToolsApi } from "../data-tools";

/** What the cards need from the session. */
export type DataCardSession = DataToolsApi &
  Pick<
    WorkbookSession,
    "activeCell" | "onDidChange" | "undoCellEdit" | "state"
  >;

interface CardChrome {
  style: CSSProperties;
  button: CSSProperties;
  /** Hand the keys back to the grid. */
  done: () => void;
}

const group: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
};
const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const field: CSSProperties = {
  font: "12px var(--font-sans, sans-serif)",
  padding: "2px 6px",
  border: "1px solid var(--pg-border, #c9c9c4)",
  borderRadius: 4,
  background: "var(--pg-bg, #ffffff)",
  color: "var(--pg-fg, #1a1a1a)",
};
const muted: CSSProperties = { color: "var(--pg-muted-fg, #5b5b57)" };

/** The frame every card shares: under the bar, Esc cancels, Enter
 *  submits (outside multi-line fields). */
function Card({
  label,
  testId,
  chrome,
  onCancel,
  onSubmit,
  minWidth = 320,
  role = "dialog",
  children,
}: {
  label: string;
  testId: string;
  chrome: CardChrome;
  onCancel: () => void;
  onSubmit?: () => void;
  minWidth?: number;
  role?: "dialog" | "alertdialog";
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      role={role}
      aria-label={label}
      style={{
        ...chrome.style,
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        minWidth,
        maxWidth: 520,
        flexDirection: "column",
        alignItems: "stretch",
        gap: 8,
        padding: 10,
        zIndex: 3,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (
          e.key === "Enter" &&
          onSubmit &&
          !(e.target instanceof HTMLTextAreaElement) &&
          !(e.target instanceof HTMLButtonElement)
        ) {
          e.preventDefault();
          e.stopPropagation();
          onSubmit();
        }
      }}
    >
      <strong>{label}</strong>
      {children}
    </div>
  );
}

function Buttons({ children }: { children: ReactNode }) {
  return <div style={{ ...group, justifyContent: "flex-end" }}>{children}</div>;
}

// ── the entry alert ───────────────────────────────────────────────────

/** Excel's alert on an entry its validation holds back (or a locked cell):
 *  Stop offers Retry / Cancel, Warning asks Continue? Yes / No / Cancel,
 *  Information OK / Cancel; a protected cell OK. */
export function EntryAlertCard({
  session,
  chrome,
}: {
  session: DataCardSession;
  chrome: CardChrome;
}) {
  const [alert] = useState(() => session.entryAlert());
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
  }, []);
  if (!alert) return null;
  const answer = (a: Parameters<DataCardSession["answerEntryAlert"]>[0]) => {
    session.answerEntryAlert(a);
    chrome.done();
  };
  const choices: [
    Parameters<DataCardSession["answerEntryAlert"]>[0],
    string,
  ][] = alert.protected
    ? [["ok", "OK"]]
    : alert.style === "stop"
      ? [
          ["retry", "Retry"],
          ["cancel", "Cancel"],
        ]
      : alert.style === "warning"
        ? [
            ["yes", "Yes"],
            ["no", "No"],
            ["cancel", "Cancel"],
          ]
        : [
            ["ok", "OK"],
            ["cancel", "Cancel"],
          ];
  const icon =
    alert.style === "stop" ? "⛔" : alert.style === "warning" ? "⚠️" : "ℹ️";
  return (
    <Card
      label={alert.title || "Microsoft Excel"}
      testId="sheet-entry-alert"
      role="alertdialog"
      chrome={chrome}
      onCancel={() => answer(alert.protected ? "ok" : "cancel")}
    >
      <div style={{ ...group, flexWrap: "nowrap", alignItems: "flex-start" }}>
        <span aria-hidden="true" style={{ fontSize: 18 }}>
          {icon}
        </span>
        <span style={{ whiteSpace: "pre-wrap" }}>
          {alert.message}
          {alert.style === "warning" && !alert.protected ? (
            <>
              <br />
              Continue?
            </>
          ) : null}
        </span>
      </div>
      <Buttons>
        {choices.map(([value, text], i) => (
          <button
            key={value}
            type="button"
            ref={i === 0 ? first : undefined}
            data-testid={`sheet-entry-alert-${value}`}
            style={chrome.button}
            onClick={() => answer(value)}
          >
            {text}
          </button>
        ))}
      </Buttons>
    </Card>
  );
}

// ── data validation ───────────────────────────────────────────────────

type RuleType = NonNullable<ValidationRuleArg["type"]>;

const ALLOW: [RuleType, string][] = [
  ["any", "Any value"],
  ["whole", "Whole number"],
  ["decimal", "Decimal"],
  ["list", "List"],
  ["date", "Date"],
  ["time", "Time"],
  ["textLength", "Text length"],
  ["custom", "Custom"],
];

const OPERATORS: [string, string][] = [
  ["between", "between"],
  ["notBetween", "not between"],
  ["equal", "equal to"],
  ["notEqual", "not equal to"],
  ["greaterThan", "greater than"],
  ["lessThan", "less than"],
  ["greaterThanOrEqual", "greater than or equal to"],
  ["lessThanOrEqual", "less than or equal to"],
];

/** A stored formula as the card shows it: `=10` → `10`, an inline list
 *  `="a,b"` → `a,b`; anything else keeps its `=`. */
function shownFormula(f: string | null | undefined): string {
  if (!f) return "";
  const inline = /^="(.*)"$/s.exec(f);
  if (inline) return inline[1]!.replace(/""/g, '"');
  const body = f.startsWith("=") ? f.slice(1) : f;
  return /^-?\d+(\.\d+)?$/.test(body) ? body : f;
}

interface ValidationForm {
  type: RuleType;
  operator: string;
  formula1: string;
  formula2: string;
  allowBlank: boolean;
  inCellDropdown: boolean;
  showInput: boolean;
  promptTitle: string;
  prompt: string;
  showError: boolean;
  errorStyle: "stop" | "warning" | "information";
  errorTitle: string;
  error: string;
}

function formOf(rule: ValidationRuleInfo | null): ValidationForm {
  return {
    type: !rule || rule.type === "none" ? "any" : rule.type,
    operator: rule?.operator || "between",
    formula1: shownFormula(rule?.formula1),
    formula2: shownFormula(rule?.formula2),
    allowBlank: rule?.allowBlank ?? true,
    inCellDropdown: rule?.inCellDropdown ?? true,
    showInput: rule?.showInput ?? true,
    promptTitle: rule?.promptTitle ?? "",
    prompt: rule?.prompt ?? "",
    showError: rule?.showError ?? true,
    errorStyle: rule?.errorStyle ?? "stop",
    errorTitle: rule?.errorTitle ?? "",
    error: rule?.error ?? "",
  };
}

/** The form as the engine's rule argument. */
export function ruleOfForm(f: ValidationForm): ValidationRuleArg {
  const rule: ValidationRuleArg = {
    type: f.type,
    allowBlank: f.allowBlank,
    showInput: f.showInput,
    promptTitle: f.promptTitle,
    prompt: f.prompt,
    showError: f.showError,
    errorStyle: f.errorStyle,
    errorTitle: f.errorTitle,
    error: f.error,
  };
  if (f.type === "list") {
    rule.inCellDropdown = f.inCellDropdown;
    const src = f.formula1.trim();
    if (src.startsWith("=")) rule.formula1 = src;
    else
      rule.listItems = src
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
  } else if (f.type === "custom") {
    rule.formula1 = f.formula1;
  } else if (f.type !== "any") {
    rule.operator = f.operator;
    rule.formula1 = f.formula1;
    if (f.operator === "between" || f.operator === "notBetween")
      rule.formula2 = f.formula2;
  }
  return rule;
}

type ValidationTab = "settings" | "input" | "error";

export function ValidationCard({
  session,
  chrome,
}: {
  session: DataCardSession;
  chrome: CardChrome;
}) {
  const [draft] = useState(() => session.validationDraft());
  const [form, setForm] = useState<ValidationForm>(() =>
    formOf(draft?.rule ?? null),
  );
  const [tab, setTab] = useState<ValidationTab>("settings");
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ValidationForm>(k: K, v: ValidationForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const cancel = () => {
    session.closeDataCard();
    chrome.done();
  };
  const ok = () => {
    const r = session.applyValidation(ruleOfForm(form));
    if (!r.ok) return setError(r.message);
    session.closeDataCard();
    chrome.done();
  };
  const clearAll = () => setForm(formOf(null));
  const binary = form.operator === "between" || form.operator === "notBetween";
  const usesOperator = !["any", "list", "custom"].includes(form.type);
  const valueLabel =
    form.type === "date"
      ? ["Start date", "End date", "Date"]
      : form.type === "time"
        ? ["Start time", "End time", "Time"]
        : form.type === "textLength"
          ? ["Minimum", "Maximum", "Length"]
          : ["Minimum", "Maximum", "Value"];
  const tabButton = (id: ValidationTab, text: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      style={{
        ...chrome.button,
        ...(tab === id ? { background: "var(--pg-accent-bg, #e6eefc)" } : null),
      }}
      onClick={() => setTab(id)}
    >
      {text}
    </button>
  );
  return (
    <Card
      label="Data validation"
      testId="sheet-validation-card"
      chrome={chrome}
      onCancel={cancel}
      onSubmit={ok}
      minWidth={380}
    >
      <span style={muted}>Applies to {draft?.range ?? "—"}</span>
      <div role="tablist" style={group}>
        {tabButton("settings", "Settings")}
        {tabButton("input", "Input message")}
        {tabButton("error", "Error alert")}
      </div>
      {tab === "settings" ? (
        <div role="tabpanel" style={column}>
          <label style={group}>
            Allow
            <select
              data-testid="sheet-validation-type"
              value={form.type}
              style={field}
              onChange={(e) => set("type", e.currentTarget.value as RuleType)}
            >
              {ALLOW.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
            {form.type !== "any" ? (
              <label>
                <input
                  type="checkbox"
                  checked={form.allowBlank}
                  onChange={(e) => set("allowBlank", e.currentTarget.checked)}
                />{" "}
                Ignore blank
              </label>
            ) : null}
          </label>
          {usesOperator ? (
            <label style={group}>
              Data
              <select
                data-testid="sheet-validation-operator"
                value={form.operator}
                style={field}
                onChange={(e) => set("operator", e.currentTarget.value)}
              >
                {OPERATORS.map(([v, text]) => (
                  <option key={v} value={v}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {usesOperator ? (
            <>
              <label style={group}>
                {binary ? valueLabel[0] : valueLabel[2]}
                <input
                  data-testid="sheet-validation-formula1"
                  value={form.formula1}
                  style={{ ...field, flex: 1 }}
                  onChange={(e) => set("formula1", e.currentTarget.value)}
                />
              </label>
              {binary ? (
                <label style={group}>
                  {valueLabel[1]}
                  <input
                    data-testid="sheet-validation-formula2"
                    value={form.formula2}
                    style={{ ...field, flex: 1 }}
                    onChange={(e) => set("formula2", e.currentTarget.value)}
                  />
                </label>
              ) : null}
            </>
          ) : null}
          {form.type === "list" ? (
            <>
              <label style={group}>
                Source
                <input
                  data-testid="sheet-validation-source"
                  value={form.formula1}
                  placeholder="Yes,No  or  =$A$1:$A$5"
                  style={{ ...field, flex: 1 }}
                  onChange={(e) => set("formula1", e.currentTarget.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.inCellDropdown}
                  onChange={(e) =>
                    set("inCellDropdown", e.currentTarget.checked)
                  }
                />{" "}
                In-cell dropdown
              </label>
            </>
          ) : null}
          {form.type === "custom" ? (
            <label style={group}>
              Formula
              <input
                data-testid="sheet-validation-formula1"
                value={form.formula1}
                placeholder="=A1>0"
                style={{ ...field, flex: 1 }}
                onChange={(e) => set("formula1", e.currentTarget.value)}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      {tab === "input" ? (
        <div role="tabpanel" style={column}>
          <label>
            <input
              type="checkbox"
              checked={form.showInput}
              onChange={(e) => set("showInput", e.currentTarget.checked)}
            />{" "}
            Show input message when cell is selected
          </label>
          <label style={group}>
            Title
            <input
              data-testid="sheet-validation-prompt-title"
              value={form.promptTitle}
              style={{ ...field, flex: 1 }}
              onChange={(e) => set("promptTitle", e.currentTarget.value)}
            />
          </label>
          <label style={column}>
            Input message
            <textarea
              data-testid="sheet-validation-prompt"
              value={form.prompt}
              rows={3}
              style={field}
              onChange={(e) => set("prompt", e.currentTarget.value)}
            />
          </label>
        </div>
      ) : null}
      {tab === "error" ? (
        <div role="tabpanel" style={column}>
          <label>
            <input
              type="checkbox"
              checked={form.showError}
              onChange={(e) => set("showError", e.currentTarget.checked)}
            />{" "}
            Show error alert after invalid data is entered
          </label>
          <label style={group}>
            Style
            <select
              data-testid="sheet-validation-style"
              value={form.errorStyle}
              style={field}
              onChange={(e) =>
                set(
                  "errorStyle",
                  e.currentTarget.value as ValidationForm["errorStyle"],
                )
              }
            >
              <option value="stop">Stop</option>
              <option value="warning">Warning</option>
              <option value="information">Information</option>
            </select>
          </label>
          <label style={group}>
            Title
            <input
              data-testid="sheet-validation-error-title"
              value={form.errorTitle}
              style={{ ...field, flex: 1 }}
              onChange={(e) => set("errorTitle", e.currentTarget.value)}
            />
          </label>
          <label style={column}>
            Error message
            <textarea
              data-testid="sheet-validation-error"
              value={form.error}
              rows={3}
              style={field}
              onChange={(e) => set("error", e.currentTarget.value)}
            />
          </label>
        </div>
      ) : null}
      {error ? (
        <span role="alert" style={{ color: "#b42318" }}>
          {error}
        </span>
      ) : null}
      <div style={{ ...group, justifyContent: "space-between" }}>
        <button type="button" style={chrome.button} onClick={clearAll}>
          Clear all
        </button>
        <span style={group}>
          <button type="button" style={chrome.button} onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="sheet-validation-ok"
            style={chrome.button}
            onClick={ok}
          >
            OK
          </button>
        </span>
      </div>
    </Card>
  );
}

// ── the AutoFilter menu ───────────────────────────────────────────────

/** The Custom AutoFilter's comparisons: each an operator and how the value
 *  is written (Excel's wildcards for begins / ends / contains). */
const CUSTOM_OPS: [
  id: string,
  text: string,
  op: string,
  wrap: (v: string) => string,
][] = [
  ["equal", "equals", "equal", (v) => v],
  ["notEqual", "does not equal", "notEqual", (v) => v],
  ["greaterThan", "is greater than", "greaterThan", (v) => v],
  [
    "greaterThanOrEqual",
    "is greater than or equal to",
    "greaterThanOrEqual",
    (v) => v,
  ],
  ["lessThan", "is less than", "lessThan", (v) => v],
  ["lessThanOrEqual", "is less than or equal to", "lessThanOrEqual", (v) => v],
  ["beginsWith", "begins with", "equal", (v) => `${v}*`],
  ["notBeginsWith", "does not begin with", "notEqual", (v) => `${v}*`],
  ["endsWith", "ends with", "equal", (v) => `*${v}`],
  ["notEndsWith", "does not end with", "notEqual", (v) => `*${v}`],
  ["contains", "contains", "equal", (v) => `*${v}*`],
  ["notContains", "does not contain", "notEqual", (v) => `*${v}*`],
];

/** One custom condition as the engine takes it. */
export function customCondition(
  id: string,
  value: string,
): { op: string; val: string } {
  const row = CUSTOM_OPS.find((o) => o[0] === id) ?? CUSTOM_OPS[0]!;
  return { op: row[2], val: row[3](value) };
}

type FilterSubmenu =
  | { view: "list" }
  | {
      view: "custom";
      first: string;
      second: string;
      and: boolean;
      between?: boolean;
    }
  | { view: "top" };

/** The "Text / Number / Date Filters ▸" entries per column kind: a custom
 *  comparison (or two for Between), a top-10, or a dynamic filter. */
function conditionEntries(
  kind: FilterColumnValues["kind"],
): [text: string, pick: FilterSubmenu | { dynamic: string }][] {
  const custom = (first: string, between = false): FilterSubmenu => ({
    view: "custom",
    first,
    second: between ? "lessThanOrEqual" : "equal",
    and: true,
    between,
  });
  if (kind === "number")
    return [
      ["Equals…", custom("equal")],
      ["Does not equal…", custom("notEqual")],
      ["Greater than…", custom("greaterThan")],
      ["Greater than or equal to…", custom("greaterThanOrEqual")],
      ["Less than…", custom("lessThan")],
      ["Less than or equal to…", custom("lessThanOrEqual")],
      ["Between…", custom("greaterThanOrEqual", true)],
      ["Top 10…", { view: "top" }],
      ["Above average", { dynamic: "aboveAverage" }],
      ["Below average", { dynamic: "belowAverage" }],
      ["Custom filter…", custom("equal")],
    ];
  if (kind === "date")
    return [
      ["Equals…", custom("equal")],
      ["Before…", custom("lessThan")],
      ["After…", custom("greaterThan")],
      ["Between…", custom("greaterThanOrEqual", true)],
      ["Tomorrow", { dynamic: "tomorrow" }],
      ["Today", { dynamic: "today" }],
      ["Yesterday", { dynamic: "yesterday" }],
      ["Next week", { dynamic: "nextWeek" }],
      ["This week", { dynamic: "thisWeek" }],
      ["Last week", { dynamic: "lastWeek" }],
      ["Next month", { dynamic: "nextMonth" }],
      ["This month", { dynamic: "thisMonth" }],
      ["Last month", { dynamic: "lastMonth" }],
      ["Next quarter", { dynamic: "nextQuarter" }],
      ["This quarter", { dynamic: "thisQuarter" }],
      ["Last quarter", { dynamic: "lastQuarter" }],
      ["Next year", { dynamic: "nextYear" }],
      ["This year", { dynamic: "thisYear" }],
      ["Last year", { dynamic: "lastYear" }],
      ["Year to date", { dynamic: "yearToDate" }],
      ["Custom filter…", custom("equal")],
    ];
  return [
    ["Equals…", custom("equal")],
    ["Does not equal…", custom("notEqual")],
    ["Begins with…", custom("beginsWith")],
    ["Ends with…", custom("endsWith")],
    ["Contains…", custom("contains")],
    ["Does not contain…", custom("notContains")],
    ["Custom filter…", custom("equal")],
  ];
}

const SORT_TEXT: Record<FilterColumnValues["kind"], [string, string]> = {
  text: ["Sort A to Z", "Sort Z to A"],
  number: ["Sort Smallest to Largest", "Sort Largest to Smallest"],
  date: ["Sort Oldest to Newest", "Sort Newest to Oldest"],
};
const FILTERS_TEXT: Record<FilterColumnValues["kind"], string> = {
  text: "Text Filters",
  number: "Number Filters",
  date: "Date Filters",
};

function Swatch({ color, onPick }: { color: string; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-label={color}
      title={color}
      onClick={onPick}
      style={{
        width: 18,
        height: 14,
        padding: 0,
        border: "1px solid var(--pg-border, #c9c9c4)",
        background: color,
        cursor: "pointer",
      }}
    />
  );
}

const menuItem: CSSProperties = {
  textAlign: "left",
  background: "transparent",
  border: "none",
  padding: "2px 4px",
  cursor: "pointer",
  font: "12px var(--font-sans, sans-serif)",
  color: "var(--pg-fg, #1a1a1a)",
};

export function FilterMenuCard({
  session,
  col,
  header,
  chrome,
}: {
  session: DataCardSession;
  col: number;
  /** The column's header text (the "Clear filter from" label). */
  header: string;
  chrome: CardChrome;
}) {
  const [values] = useState(() => session.filterValues(col));
  const [checked, setChecked] = useState<Set<string>>(
    () =>
      new Set(
        (values?.items ?? []).filter((i) => i.selected).map((i) => i.text),
      ),
  );
  const [blanks, setBlanks] = useState(values?.blanksSelected ?? true);
  const [search, setSearch] = useState("");
  const [sub, setSub] = useState<FilterSubmenu>({ view: "list" });
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const [v1, setV1] = useState("");
  const [v2, setV2] = useState("");
  const [top, setTop] = useState({ top: true, n: 10, percent: false });
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    session.closeDataCard();
    chrome.done();
  };
  const apply = (criterion: FilterCriterion | null) => {
    const r = session.applyFilter(col, criterion);
    if (!r.ok) return setError(r.message);
    chrome.done();
  };
  const sort = (key: Omit<SortKey, "index">) => {
    const r = session.sortFilterColumn(col, key);
    if (!r.ok) return setError(r.message);
    chrome.done();
  };
  if (!values) {
    return (
      <Card
        label="Filter"
        testId="sheet-filter-menu"
        chrome={chrome}
        onCancel={close}
      >
        <span style={muted}>No filter on this column.</span>
      </Card>
    );
  }
  const kind = values.kind;
  const items = values.items;
  const q = search.trim().toLowerCase();
  const shown = q
    ? items.filter((i) => i.text.toLowerCase().includes(q))
    : items;
  const allOn =
    shown.every((i) => checked.has(i.text)) &&
    (q !== "" || values.blanks === 0 || blanks);
  const okList = () => {
    // Searching keeps only the matches that are ticked (as Excel does).
    const keep = q
      ? shown.filter((i) => checked.has(i.text))
      : items.filter((i) => checked.has(i.text));
    const everything =
      !q && keep.length === items.length && (values.blanks === 0 || blanks);
    if (everything) return apply(null);
    apply({
      kind: "values",
      values: keep.map((i) => i.text),
      blanks: q ? false : blanks,
    });
  };
  const okCustom = () => {
    if (sub.view !== "custom") return;
    const conditions = [customCondition(sub.first, v1)];
    if (v2.trim() !== "") conditions.push(customCondition(sub.second, v2));
    apply({ kind: "custom", and: sub.and, conditions });
  };
  const okTop = () =>
    apply({ kind: "top", n: top.n, percent: top.percent, top: top.top });

  if (sub.view === "custom") {
    const opSelect = (
      value: string,
      onChange: (v: string) => void,
      testId: string,
    ) => (
      <select
        data-testid={testId}
        value={value}
        style={field}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        {CUSTOM_OPS.filter(
          ([id]) =>
            kind === "text" ||
            ![
              "beginsWith",
              "notBeginsWith",
              "endsWith",
              "notEndsWith",
              "contains",
              "notContains",
            ].includes(id),
        ).map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    );
    return (
      <Card
        label="Custom AutoFilter"
        testId="sheet-filter-custom"
        chrome={chrome}
        onCancel={() => setSub({ view: "list" })}
        onSubmit={okCustom}
      >
        <span style={muted}>Show rows where {header || "the column"}:</span>
        <div style={group}>
          {opSelect(
            sub.first,
            (first) => setSub({ ...sub, first }),
            "sheet-filter-op1",
          )}
          <input
            data-testid="sheet-filter-value1"
            value={v1}
            style={{ ...field, flex: 1 }}
            onChange={(e) => setV1(e.currentTarget.value)}
          />
        </div>
        <div role="radiogroup" aria-label="Combine" style={group}>
          <label>
            <input
              type="radio"
              checked={sub.and}
              onChange={() => setSub({ ...sub, and: true })}
            />{" "}
            And
          </label>
          <label>
            <input
              type="radio"
              checked={!sub.and}
              onChange={() => setSub({ ...sub, and: false })}
            />{" "}
            Or
          </label>
        </div>
        <div style={group}>
          {opSelect(
            sub.second,
            (second) => setSub({ ...sub, second }),
            "sheet-filter-op2",
          )}
          <input
            data-testid="sheet-filter-value2"
            value={v2}
            style={{ ...field, flex: 1 }}
            onChange={(e) => setV2(e.currentTarget.value)}
          />
        </div>
        <span style={muted}>
          Use ? for any single character, * for any series.
        </span>
        {error ? (
          <span role="alert" style={{ color: "#b42318" }}>
            {error}
          </span>
        ) : null}
        <Buttons>
          <button
            type="button"
            style={chrome.button}
            onClick={() => setSub({ view: "list" })}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="sheet-filter-custom-ok"
            style={chrome.button}
            onClick={okCustom}
          >
            OK
          </button>
        </Buttons>
      </Card>
    );
  }

  if (sub.view === "top") {
    return (
      <Card
        label="Top 10 AutoFilter"
        testId="sheet-filter-top"
        chrome={chrome}
        onCancel={() => setSub({ view: "list" })}
        onSubmit={okTop}
      >
        <div style={group}>
          <select
            aria-label="Top or bottom"
            value={top.top ? "top" : "bottom"}
            style={field}
            onChange={(e) =>
              setTop({ ...top, top: e.currentTarget.value === "top" })
            }
          >
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
          <input
            aria-label="Count"
            data-testid="sheet-filter-top-n"
            type="number"
            min={1}
            value={top.n}
            style={{ ...field, width: 64 }}
            onChange={(e) =>
              setTop({ ...top, n: Number(e.currentTarget.value) || 1 })
            }
          />
          <select
            aria-label="Items or percent"
            value={top.percent ? "percent" : "items"}
            style={field}
            onChange={(e) =>
              setTop({ ...top, percent: e.currentTarget.value === "percent" })
            }
          >
            <option value="items">Items</option>
            <option value="percent">Percent</option>
          </select>
        </div>
        {error ? (
          <span role="alert" style={{ color: "#b42318" }}>
            {error}
          </span>
        ) : null}
        <Buttons>
          <button
            type="button"
            style={chrome.button}
            onClick={() => setSub({ view: "list" })}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="sheet-filter-top-ok"
            style={chrome.button}
            onClick={okTop}
          >
            OK
          </button>
        </Buttons>
      </Card>
    );
  }

  const [asc, desc] = SORT_TEXT[kind];
  return (
    <Card
      label={header ? `Filter: ${header}` : "Filter"}
      testId="sheet-filter-menu"
      chrome={chrome}
      onCancel={close}
      onSubmit={okList}
      minWidth={260}
    >
      <div style={{ ...column, gap: 0 }}>
        <button
          type="button"
          data-testid="sheet-filter-sort-asc"
          style={menuItem}
          onClick={() => sort({ descending: false })}
        >
          {asc}
        </button>
        <button
          type="button"
          data-testid="sheet-filter-sort-desc"
          style={menuItem}
          onClick={() => sort({ descending: true })}
        >
          {desc}
        </button>
        {values.fillColors.length > 0 || values.fontColors.length > 0 ? (
          <div style={{ ...group, padding: "2px 4px" }}>
            <span>Sort by color</span>
            {values.fillColors.map((c) => (
              <Swatch
                key={`sf${c}`}
                color={c}
                onPick={() => sort({ sortBy: "cellColor", color: c })}
              />
            ))}
            {values.fontColors.map((c) => (
              <Swatch
                key={`st${c}`}
                color={c}
                onPick={() => sort({ sortBy: "fontColor", color: c })}
              />
            ))}
          </div>
        ) : null}
        <hr
          style={{
            width: "100%",
            border: "none",
            borderTop: "1px solid var(--pg-border, #c9c9c4)",
          }}
        />
        <button
          type="button"
          data-testid="sheet-filter-clear"
          style={{ ...menuItem, ...(values.criterion ? null : muted) }}
          disabled={!values.criterion}
          onClick={() => apply(null)}
        >
          Clear filter from “{header || "column"}”
        </button>
        {values.fillColors.length > 0 || values.fontColors.length > 0 ? (
          <div style={{ ...group, padding: "2px 4px" }}>
            <span>Filter by color</span>
            {values.fillColors.map((c) => (
              <Swatch
                key={`ff${c}`}
                color={c}
                onPick={() =>
                  apply({ kind: "color", color: c, cellColor: true })
                }
              />
            ))}
            {values.fontColors.map((c) => (
              <Swatch
                key={`ft${c}`}
                color={c}
                onPick={() =>
                  apply({ kind: "color", color: c, cellColor: false })
                }
              />
            ))}
          </div>
        ) : null}
        <button
          type="button"
          data-testid="sheet-filter-conditions"
          aria-expanded={conditionsOpen}
          style={menuItem}
          onClick={() => setConditionsOpen(!conditionsOpen)}
        >
          {FILTERS_TEXT[kind]} {conditionsOpen ? "▾" : "▸"}
        </button>
        {conditionsOpen ? (
          <div style={{ ...column, gap: 0, paddingLeft: 12 }}>
            {conditionEntries(kind).map(([text, pick]) => (
              <button
                key={text}
                type="button"
                style={menuItem}
                onClick={() => {
                  if ("dynamic" in pick)
                    apply({ kind: "dynamic", type: pick.dynamic });
                  else setSub(pick);
                }}
              >
                {text}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <input
        data-testid="sheet-filter-search"
        type="search"
        placeholder="Search"
        value={search}
        style={field}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      <div
        role="group"
        aria-label="Values"
        style={{
          ...column,
          gap: 2,
          maxHeight: 180,
          overflowY: "auto",
          border: "1px solid var(--pg-border, #c9c9c4)",
          borderRadius: 4,
          padding: 4,
        }}
      >
        <label>
          <input
            type="checkbox"
            data-testid="sheet-filter-all"
            checked={allOn}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              const next = new Set(checked);
              for (const i of shown) {
                if (on) next.add(i.text);
                else next.delete(i.text);
              }
              setChecked(next);
              if (!q) setBlanks(on);
            }}
          />{" "}
          (Select all{q ? " search results" : ""})
        </label>
        {shown.map((i) => (
          <label key={i.text}>
            <input
              type="checkbox"
              data-testid="sheet-filter-item"
              checked={checked.has(i.text)}
              onChange={(e) => {
                const next = new Set(checked);
                if (e.currentTarget.checked) next.add(i.text);
                else next.delete(i.text);
                setChecked(next);
              }}
            />{" "}
            {i.text === "" ? "(empty text)" : i.text}
            <span style={muted}> ({i.count})</span>
          </label>
        ))}
        {values.blanks > 0 && !q ? (
          <label>
            <input
              type="checkbox"
              data-testid="sheet-filter-blanks"
              checked={blanks}
              onChange={(e) => setBlanks(e.currentTarget.checked)}
            />{" "}
            (Blanks)
          </label>
        ) : null}
      </div>
      {error ? (
        <span role="alert" style={{ color: "#b42318" }}>
          {error}
        </span>
      ) : null}
      <Buttons>
        <button type="button" style={chrome.button} onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="sheet-filter-ok"
          style={chrome.button}
          onClick={okList}
        >
          OK
        </button>
      </Buttons>
    </Card>
  );
}

/** The card the session has open (the alert first), under the bar. */
export function DataCards({
  session,
  chrome,
  card,
  alert,
  filterHeader,
}: {
  session: DataCardSession;
  chrome: CardChrome;
  card: ReturnType<DataToolsApi["dataCard"]>;
  alert: ReturnType<DataToolsApi["entryAlert"]>;
  filterHeader: string;
}) {
  if (alert)
    return (
      <EntryAlertCard
        key={JSON.stringify(alert)}
        session={session}
        chrome={chrome}
      />
    );
  if (!card) return null;
  switch (card.kind) {
    case "validation":
      return <ValidationCard session={session} chrome={chrome} />;
    case "filter":
      return (
        <FilterMenuCard
          key={card.col}
          session={session}
          col={card.col}
          header={filterHeader}
          chrome={chrome}
        />
      );
    default:
      return null;
  }
}
