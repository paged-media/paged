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

// Data ADR 566 — the Bindings panel's three new parts: the workflow as six
// steps, the record scrubber, and the outlier finder (the UX strategy's
// §7.5). Each is a plain component over props; the panel wires them to the
// session.

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { NumericFieldProps } from "@paged-media/plugin-api";
import { useStrings } from "@paged-media/strings";

import { WORKFLOW } from "../messages";
import { ratioText, type Outlier } from "../outliers";
import {
  WORKFLOW_STEPS,
  type WorkflowStepId,
  type WorkflowStepState,
} from "../workflow";

const STEP_LABEL = {
  connect: WORKFLOW.connect,
  records: WORKFLOW.records,
  bind: WORKFLOW.bind,
  preview: WORKFLOW.preview,
  validate: WORKFLOW.validate,
  publish: WORKFLOW.publish,
} as const;
const STEP_HINT = {
  connect: WORKFLOW.connectHint,
  records: WORKFLOW.recordsHint,
  bind: WORKFLOW.bindHint,
  preview: WORKFLOW.previewHint,
  validate: WORKFLOW.validateHint,
  publish: WORKFLOW.publishHint,
} as const;

export function WorkflowSteps({
  states,
  onGo,
}: {
  states: Record<WorkflowStepId, WorkflowStepState>;
  onGo(step: WorkflowStepId): void;
}) {
  const { t } = useStrings();
  return (
    <ol data-data-workflow="" aria-label={t(WORKFLOW.title)} style={steps}>
      {WORKFLOW_STEPS.map((id, i) => {
        const state = states[id];
        return (
          <li key={id} style={{ display: "flex", alignItems: "center" }}>
            {i > 0 ? (
              <span aria-hidden="true" style={arrow}>
                →
              </span>
            ) : null}
            <button
              type="button"
              data-data-step={id}
              data-state={state}
              aria-current={state === "current" ? "step" : undefined}
              title={t(STEP_HINT[id])}
              onClick={() => onGo(id)}
              style={{ ...step, ...STEP_LOOK[state] }}
            >
              {state === "done" ? "✓ " : state === "attention" ? "⚠ " : ""}
              {t(STEP_LABEL[id])}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Wait this long after the slider stops before previewing (each preview
 *  writes the document). */
const SCRUB_MS = 140;

export function RecordScrubber({
  index,
  total,
  canRun,
  onPreview,
  NumericField,
  message,
}: {
  /** The record shown, 0-based. */
  index: number;
  total: number;
  /** A query is picked (before it ran, Next runs it). */
  canRun: boolean;
  onPreview(record: number): void;
  NumericField: React.ComponentType<NumericFieldProps>;
  message: string | null;
}) {
  const { t } = useStrings();
  const [scrub, setScrub] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const shown = scrub ?? index;
  return (
    <div data-testid="preview-stepper" style={column}>
      <div style={row}>
        <strong style={{ fontSize: 12 }}>{t(WORKFLOW.previewRecord)}</strong>
        <span data-testid="preview-position" style={muted}>
          {total === 0
            ? t(WORKFLOW.noRecords)
            : t(WORKFLOW.position, { n: shown + 1, total })}
        </span>
      </div>
      <div style={row}>
        <button
          type="button"
          data-data-scrub="previous"
          title={t(WORKFLOW.previousTitle)}
          disabled={total === 0 || index <= 0}
          onClick={() => onPreview(index - 1)}
          style={button}
        >
          {t(WORKFLOW.previous)}
        </button>
        <input
          type="range"
          data-data-scrubber=""
          aria-label={t(WORKFLOW.scrubber)}
          min={1}
          max={Math.max(1, total)}
          step={1}
          value={total === 0 ? 1 : shown + 1}
          disabled={total === 0}
          onChange={(e) => {
            const next = Number(e.currentTarget.value) - 1;
            setScrub(next);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = null;
              setScrub(null);
              onPreview(next);
            }, SCRUB_MS);
          }}
          style={{ flex: 1, minWidth: 80, accentColor: "var(--pg-primary)" }}
        />
        <button
          type="button"
          data-data-scrub="next"
          title={t(WORKFLOW.nextTitle)}
          // Before the query ran, Next runs it and shows record 1.
          disabled={total === 0 ? !canRun : index >= total - 1}
          onClick={() => onPreview(total === 0 ? 0 : index + 1)}
          style={button}
        >
          {t(WORKFLOW.next)}
        </button>
        <span data-data-record-field="" style={{ display: "inline-flex" }}>
          <NumericField
            value={total === 0 ? null : index + 1}
            min={1}
            max={Math.max(1, total)}
            step={1}
            precision={0}
            disabled={total === 0}
            ariaLabel={t(WORKFLOW.recordNumber)}
            onCommit={(n) => onPreview(Math.round(n) - 1)}
          />
        </span>
      </div>
      {message ? (
        <span style={muted} data-data-step-msg="">
          {message}
        </span>
      ) : null}
    </div>
  );
}

export function OutlierFinder({
  outliers,
  scanning,
  checking,
  onScan,
  onCheckOverflow,
  onPreview,
  current,
}: {
  /** Null: not scanned yet. */
  outliers: readonly Outlier[] | null;
  scanning: boolean;
  checking: boolean;
  onScan(): void;
  onCheckOverflow(): void;
  onPreview(record: number): void;
  /** The record the preview shows, 0-based. */
  current: number | null;
}) {
  const { t } = useStrings();
  const describe = (o: Outlier): string => {
    switch (o.kind) {
      case "missing":
        return t(WORKFLOW.outlierMissing, { field: o.field });
      case "long":
        return t(WORKFLOW.outlierLong, {
          field: o.field,
          length: o.measure,
          usual: Math.round(o.usual),
        });
      case "ratio":
        return t(WORKFLOW.outlierRatio, {
          field: o.field,
          ratio: ratioText(o.measure),
          usual: ratioText(o.usual),
        });
      case "overflow":
        return t(WORKFLOW.outlierOverflow);
    }
  };
  return (
    <div data-data-outliers="" style={column}>
      <div style={row}>
        <strong style={{ fontSize: 12 }}>{t(WORKFLOW.outliers)}</strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-data-outliers-scan=""
          disabled={scanning}
          title={t(WORKFLOW.scanTitle)}
          onClick={onScan}
          style={button}
        >
          {scanning ? t(WORKFLOW.scanning) : t(WORKFLOW.scan)}
        </button>
        <button
          type="button"
          data-data-outliers-render=""
          disabled={checking || !outliers || outliers.length === 0}
          title={t(WORKFLOW.renderTitle)}
          onClick={onCheckOverflow}
          style={button}
        >
          {checking ? t(WORKFLOW.rendering) : t(WORKFLOW.render)}
        </button>
      </div>
      {outliers === null ? (
        <span style={muted}>{t(WORKFLOW.outliersHint)}</span>
      ) : outliers.length === 0 ? (
        <span data-data-outliers-none="" role="status" style={muted}>
          {t(WORKFLOW.noOutliers)}
        </span>
      ) : (
        <ul style={list} role="list">
          {outliers.slice(0, 30).map((o) => (
            <li key={`${o.kind}:${o.bindingId}:${o.record}`}>
              <button
                type="button"
                data-data-outlier={o.kind}
                data-record={o.record}
                aria-current={current === o.record ? "true" : undefined}
                onClick={() => onPreview(o.record)}
                style={{
                  ...outlierRow,
                  ...(current === o.record
                    ? { background: "var(--selected-bg, #e6eefc)" }
                    : null),
                }}
              >
                <span style={{ ...badge, ...KIND_LOOK[o.kind] }}>
                  {t(WORKFLOW.recordShort, { n: o.record + 1 })}
                </span>
                <span>{describe(o)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STEP_LOOK: Record<WorkflowStepState, CSSProperties> = {
  done: { color: "var(--pg-success, #067647)" },
  current: {
    borderColor: "var(--pg-primary, #2b6cb0)",
    color: "var(--pg-primary, #2b6cb0)",
    fontWeight: 600,
  },
  todo: { color: "var(--pg-muted-fg, #5b5b57)" },
  attention: {
    borderColor: "var(--pg-warning, #b54708)",
    color: "var(--pg-warning, #b54708)",
    fontWeight: 600,
  },
};
const KIND_LOOK: Record<Outlier["kind"], CSSProperties> = {
  overflow: { background: "#fde2e1", color: "#b42318" },
  missing: { background: "#fef0c7", color: "#b54708" },
  long: { background: "#e6eefc", color: "#2b6cb0" },
  ratio: { background: "#eef2f6", color: "#344054" },
};
const steps: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 2,
  listStyle: "none",
  margin: "0 0 8px",
  padding: 0,
  fontSize: 12,
};
const step: CSSProperties = {
  minHeight: 24,
  padding: "0 8px",
  borderRadius: 12,
  border: "1px solid var(--chrome-border, #c9c9c4)",
  background: "var(--pg-bg, #ffffff)",
  font: "inherit",
  cursor: "pointer",
};
const arrow: CSSProperties = {
  padding: "0 2px",
  color: "var(--pg-muted-fg, #5b5b57)",
};
const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  margin: "6px 0",
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
};
const button: CSSProperties = { minHeight: 24 };
const muted: CSSProperties = {
  color: "var(--pg-muted-fg, #5b5b57)",
  fontSize: 12,
};
const list: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  maxHeight: 220,
  overflowY: "auto",
};
const outlierRow: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  width: "100%",
  minHeight: 24,
  textAlign: "left",
  border: "none",
  background: "transparent",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
  padding: "2px 4px",
  borderRadius: 4,
};
const badge: CSSProperties = {
  flexShrink: 0,
  padding: "0 6px",
  borderRadius: 8,
  fontVariantNumeric: "tabular-nums",
};

/** A picture's width ÷ height, read by the browser from a URL it can load
 *  (http, https, data, blob); null for a path it cannot resolve or a
 *  picture that does not load within a few seconds. */
export function measureImageRatio(src: string): Promise<number | null> {
  if (
    !/^(https?:|data:image\/|blob:)/i.test(src.trim()) ||
    typeof Image === "undefined"
  )
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const done = (r: number | null) => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 4000);
    img.onload = () =>
      done(
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? img.naturalWidth / img.naturalHeight
          : null,
      );
    img.onerror = () => done(null);
    img.src = src.trim();
  });
}
