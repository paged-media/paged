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
// validation. Like paste special
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
import type { ValidationRuleArg, ValidationRuleInfo } from "../engine-w2";
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
    default:
      void filterHeader;
      return null;
  }
}
