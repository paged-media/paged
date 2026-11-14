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

// The one toast channel of operation feedback (editor ADR "Operation
// feedback", UXI-FBK-001, UXI-ASY-010): brief results at the editor's
// foot, at most three, each with its remedy and its further actions, its
// technical detail behind "Details" (UXI-ASY-011), and a count when the
// same thing was reported again while it showed. A failure is announced
// assertively, anything else politely. Each toast closes on its ✕, when
// one of its actions ran, or when its time is up (a fatal failure stays).

import { useEffect, useState } from "react";
import { useStrings } from "@paged-media/strings";

import { Icon } from "../icons";
import {
  FEEDBACK_STRINGS as M,
  isFailure,
  severityOf,
  useFeedbackSnapshot,
  useOperationFeedback,
  type FeedbackAction,
  type FeedbackToast,
} from "../state/operation-feedback";

const DOT = {
  error: "var(--status-error)",
  warning: "var(--status-review)",
  info: "var(--status-info)",
} as const;

export function FeedbackToasts() {
  const strings = useStrings();
  const feedback = useOperationFeedback();
  const { toasts } = useFeedbackSnapshot();

  // The words follow the editor's locale.
  useEffect(() => {
    feedback.setTranslator((key, params) => strings.t(key, params));
  }, [feedback, strings]);

  // One timer for the toast that leaves next.
  const next = toasts.reduce<number | null>(
    (soonest, x) =>
      x.expiresAt !== null && (soonest === null || x.expiresAt < soonest)
        ? x.expiresAt
        : soonest,
    null,
  );
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(
      () => {
        const now = Date.now();
        for (const x of feedback.snapshot().toasts)
          if (x.expiresAt !== null && x.expiresAt <= now)
            feedback.dismissToast(x.id);
      },
      Math.max(0, next - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [feedback, next]);

  if (toasts.length === 0) return null;
  return (
    <section
      aria-label={strings.t(M.region)}
      data-feedback-toasts
      style={regionStyle}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </section>
  );
}

function Toast({ toast }: { toast: FeedbackToast }) {
  const strings = useStrings();
  const feedback = useOperationFeedback();
  const [details, setDetails] = useState(false);
  const { report, text } = toast;
  const severity = severityOf(report.outcome);
  const run = (action: FeedbackAction) => {
    feedback.runAction(action);
    feedback.dismissToast(toast.id);
  };
  const actions = [
    ...(report.remedy ? [report.remedy] : []),
    ...(report.actions ?? []),
  ];
  return (
    <div
      role={isFailure(report.outcome) ? "alert" : "status"}
      data-feedback-toast
      data-outcome={report.outcome}
      data-feedback-key={toast.key}
      data-feedback-count={toast.count}
      style={toastStyle}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            marginTop: 5,
            borderRadius: "50%",
            background: DOT[severity],
            flex: "none",
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div data-feedback-headline style={{ fontWeight: 600 }}>
            {text.headline}
            {toast.count > 1 && (
              <span data-feedback-repeat style={repeatStyle}>
                {strings.t(M.repeated, { count: toast.count })}
              </span>
            )}
          </div>
          {text.change && (
            <div data-feedback-change style={{ opacity: 0.8 }}>
              {text.change}
            </div>
          )}
          {(actions.length > 0 || report.detail) && (
            <div style={actionsStyle}>
              {actions.map((a, i) => (
                <button
                  key={i}
                  type="button"
                  data-feedback-action={a.command ?? a.label}
                  onClick={() => run(a)}
                  style={actionStyle}
                >
                  {a.label}
                </button>
              ))}
              {report.detail && (
                <button
                  type="button"
                  aria-expanded={details}
                  data-feedback-details-toggle
                  onClick={() => setDetails((d) => !d)}
                  style={{ ...actionStyle, color: "var(--pg-muted-fg)" }}
                >
                  {strings.t(M.details)}
                </button>
              )}
            </div>
          )}
          {details && report.detail && (
            <pre data-feedback-detail style={detailStyle}>
              {report.detail}
              {report.correlationId ? `\n#${report.correlationId}` : ""}
            </pre>
          )}
        </div>
        <button
          type="button"
          aria-label={strings.t(M.close)}
          data-feedback-close
          onClick={() => feedback.dismissToast(toast.id)}
          style={closeStyle}
        >
          <Icon name="ui-x" size={12} />
        </button>
      </div>
    </div>
  );
}

const regionStyle: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: 24,
  transform: "translateX(-50%)",
  zIndex: 61,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  width: "min(480px, calc(100vw - 32px))",
  pointerEvents: "none",
};

const toastStyle: React.CSSProperties = {
  pointerEvents: "auto",
  padding: "8px 10px 8px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--chrome-border)",
  background: "var(--chrome-panel-bg)",
  color: "var(--pg-fg)",
  boxShadow: "0 6px 24px rgb(0 0 0 / 0.25)",
  fontSize: 12.5,
  lineHeight: 1.45,
};

const repeatStyle: React.CSSProperties = {
  marginLeft: 6,
  fontFamily: "var(--font-mono)",
  fontWeight: 400,
  fontSize: 11,
  color: "var(--pg-muted-fg)",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  marginTop: 4,
};

const actionStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontWeight: 600,
  color: "var(--pg-primary)",
  cursor: "pointer",
};

const detailStyle: React.CSSProperties = {
  margin: "6px 0 0",
  maxHeight: 120,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--pg-muted-fg)",
};

const closeStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--pg-muted-fg)",
  cursor: "pointer",
  padding: 2,
  lineHeight: 1,
};
