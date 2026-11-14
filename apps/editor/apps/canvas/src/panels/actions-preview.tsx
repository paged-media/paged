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

// Editor ADR 1233 — the Actions panel's preview and parameters. The preview
// is what a run WOULD do here, worked out before anything runs: the steps
// with the objects each acts on (outlined on the canvas; pointing at one in
// the list draws it stronger), the refusals that stop the run before it
// starts, and how it undoes. Run is offered only when nothing refuses. The
// parameters are the payload values a user chose to change between runs.

import { useState, type CSSProperties } from "react";

import {
  CockpitBtn,
  isObjectAddress,
  parameterLeaves,
  undoStatementText,
  useActions,
  type PagedAction,
  type RunPlan,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.actionsPreview", {
  previewTitle: "What “{name}” will do here",
  acts: "acts on {count, plural, one {# object} other {# objects}}",
  actsNone: "acts on no object (the view, the editor or the document)",
  selection: "the selection",
  refused: "It will not run:",
  run: "Run",
  close: "Close preview",
  skipped: "skipped",
  parameters: "Parameters",
  noParameters:
    "No parameters. Open a step's values below to make one a parameter.",
  paramLabel: "Name of parameter {n}",
  paramValue: "Value of {label}",
  removeParam: "Remove parameter {label}",
  values: "Values",
  makeParam: "Make {path} a parameter",
  noValues: "This step has no values to change.",
});

const MUTED: CSSProperties = {
  color: "var(--pg-muted-fg)",
  fontFamily: "var(--font-sans)",
};

const input: CSSProperties = {
  height: 24,
  padding: "0 6px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--pg-border)",
  background: "transparent",
  color: "var(--pg-fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  minWidth: 0,
};

/** The preview of `plan`: steps, targets, refusals, the undo statement. */
export function ActionPreview({
  plan,
  onRun,
  onClose,
  busy,
}: {
  plan: RunPlan;
  onRun: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const strings = useStrings();
  const actions = useActions();
  return (
    <div
      data-actions-preview={plan.actionId}
      data-actions-preview-refused={plan.refusals.length > 0 ? "" : undefined}
      style={{
        margin: "0 14px 12px",
        border: "1px solid var(--status-review)",
        borderRadius: "var(--radius-md)",
        padding: 9,
        fontSize: 12,
      }}
      onMouseLeave={() => actions.focusTarget(null)}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {strings.t(M.previewTitle, { name: plan.name })}
      </div>
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {plan.steps.map((s) => (
          <li
            key={s.index}
            data-actions-preview-step={s.index}
            style={{ fontSize: 11, marginBottom: 4 }}
          >
            <span>{s.title}</span>
            {!s.stop && (
              <div style={{ ...MUTED, fontSize: 10.5 }}>
                {s.targets.length === 0
                  ? strings.t(M.actsNone)
                  : strings.t(M.acts, { count: s.targets.length })}
                {s.usesSelection.length > 0
                  ? ` · ${strings.t(M.selection)}`
                  : ""}
                {s.targets.length > 0 && (
                  <span style={{ display: "block" }}>
                    {s.targets.map((a) => (
                      <code
                        key={a}
                        data-actions-preview-target={a}
                        onMouseEnter={() => actions.focusTarget(a)}
                        style={{
                          marginRight: 6,
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          cursor: "default",
                        }}
                      >
                        {a}
                      </code>
                    ))}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {plan.skipped.map((s) => (
        <div key={s.index} style={{ ...MUTED, fontSize: 11 }}>
          {s.index + 1}. {s.step.title} — {strings.t(M.skipped)}
        </div>
      ))}
      {plan.refusals.length > 0 ? (
        <div
          role="alert"
          data-actions-refusals
          style={{ marginTop: 6, color: "var(--status-error)", fontSize: 11 }}
        >
          <div style={{ fontWeight: 600 }}>{strings.t(M.refused)}</div>
          {plan.refusals.map((r, i) => (
            <div key={i} data-actions-refusal={r.index ?? "action"}>
              {r.reason}
            </div>
          ))}
        </div>
      ) : (
        <div
          data-actions-undo-statement={plan.undo.kind}
          style={{ ...MUTED, fontSize: 11, marginTop: 6 }}
        >
          {undoStatementText(plan.undo)}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <CockpitBtn
          primary
          sm
          disabled={busy || plan.refusals.length > 0}
          onClick={onRun}
          testId="actions-run"
        >
          {strings.t(M.run)}
        </CockpitBtn>
        <CockpitBtn sm onClick={onClose} testId="actions-close-preview">
          {strings.t(M.close)}
        </CockpitBtn>
      </div>
    </div>
  );
}

/** The action's parameters: name and value of each, editable. */
export function ActionParams({ action }: { action: PagedAction }) {
  const strings = useStrings();
  const actions = useActions();
  const params = action.params ?? [];
  return (
    <div data-actions-params style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
        {strings.t(M.parameters)}
      </div>
      {params.length === 0 && (
        <div style={{ ...MUTED, fontSize: 11 }}>
          {strings.t(M.noParameters)}
        </div>
      )}
      {params.map((p, i) => (
        <div
          key={p.id}
          data-actions-param={p.id}
          style={{
            display: "flex",
            gap: 4,
            alignItems: "center",
            marginBottom: 4,
          }}
        >
          <input
            value={p.label}
            aria-label={strings.t(M.paramLabel, { n: i + 1 })}
            onChange={(e) =>
              actions.renameParam(action.id, p.id, e.target.value)
            }
            style={{ ...input, flex: 1 }}
          />
          {typeof p.value === "boolean" ? (
            <input
              type="checkbox"
              checked={p.value}
              aria-label={strings.t(M.paramValue, { label: p.label })}
              data-actions-param-value={p.id}
              onChange={(e) =>
                actions.setParamValue(action.id, p.id, e.target.checked)
              }
            />
          ) : (
            <ParamValue
              value={p.value}
              label={strings.t(M.paramValue, { label: p.label })}
              testValue={p.id}
              onCommit={(v) => actions.setParamValue(action.id, p.id, v)}
            />
          )}
          <button
            type="button"
            aria-label={strings.t(M.removeParam, { label: p.label })}
            onClick={() => actions.removeParam(action.id, p.id)}
            style={{
              background: "none",
              border: "none",
              color: "var(--pg-muted-fg)",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** A parameter's value field: a number stays a number. */
function ParamValue({
  value,
  label,
  testValue,
  onCommit,
}: {
  value: string | number;
  label: string;
  testValue: string;
  onCommit: (v: string | number) => void;
}) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    if (typeof value === "number") {
      const n = Number(text.replace(",", "."));
      if (Number.isFinite(n)) onCommit(n);
      else setText(String(value));
    } else onCommit(text);
  };
  return (
    <input
      value={text}
      inputMode={typeof value === "number" ? "decimal" : undefined}
      aria-label={label}
      data-actions-param-value={testValue}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      style={{ ...input, width: 90 }}
    />
  );
}

/** One step's payload values, each of which can become a parameter. */
export function StepValues({
  action,
  index,
}: {
  action: PagedAction;
  index: number;
}) {
  const strings = useStrings();
  const actions = useActions();
  const step = action.steps[index];
  const leaves =
    step?.payload === undefined
      ? []
      : parameterLeaves(step.payload, isObjectAddress);
  return (
    <div data-actions-step-values={index} style={{ padding: "2px 0 6px 22px" }}>
      {leaves.length === 0 && (
        <div style={{ ...MUTED, fontSize: 10.5 }}>{strings.t(M.noValues)}</div>
      )}
      {leaves.map((leaf) => {
        const path = leaf.path.join(".");
        return (
          <div
            key={path}
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              fontSize: 10.5,
            }}
          >
            <code style={{ fontFamily: "var(--font-mono)" }}>{path}</code>
            <span style={MUTED}>{JSON.stringify(leaf.value)}</span>
            <button
              type="button"
              data-actions-make-param={path}
              onClick={() => actions.addParam(action.id, index, leaf.path)}
              style={{
                background: "none",
                border: "1px solid var(--pg-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--pg-fg)",
                fontSize: 10,
                cursor: "pointer",
                padding: "0 5px",
              }}
            >
              {strings.t(M.makeParam, { path })}
            </button>
          </div>
        );
      })}
    </div>
  );
}
