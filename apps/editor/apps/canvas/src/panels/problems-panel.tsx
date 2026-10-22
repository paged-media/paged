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

// Problems panel (paged.web W-05) — the host surface that consumes
// `host.diagnostics`. Every loaded bundle's `diagnostics.set/clear`
// fans out (via the injected sink) into `problems-store`; this panel
// lists them — (severity, source, message, location) — in one place,
// closing the "diagnostics only surfaced inline in the plugin's own
// panel" gap.
//
// Click-to-focus: clicking a problem focuses the OWNING bundle's panel
// (resolved from the panel registry by namespace). Document-location
// focus (jump the canvas to the offending frame/line) is a follow-up —
// the `Diagnostic` location type carries `source`/`line`, not a
// document ref, so there is nothing to navigate to yet (noted in
// BREAKAGE_LOG W-05).

import { useSyncExternalStore } from "react";

import {
  cockpitActions,
  useCollection,
  useRegistries,
} from "@paged-media/shell";
import type { FontSummary, LinkSummary } from "@paged-media/client";

import {
  getProblemsSnapshot,
  subscribeProblems,
  type ProblemEntry,
} from "./problems-store";
import { font, radius, space } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.problemsPanel", {
  missingLink: "Missing link: {name}",
  missingFont: "Missing font: {family}",
  title: "Problems",
  empty: "No problems detected.",
  summary:
    "{errors, plural, one {# error} other {# errors}}, {warnings, plural, one {# warning} other {# warnings}}",
});

const DOT: Record<ProblemEntry["severity"], string> = {
  error: "var(--status-error)",
  warning: "var(--status-review)",
  info: "var(--status-info)",
};

const kicker: React.CSSProperties = {
  font: `700 10px ${font.sans}`,
  letterSpacing: font.trackingWide,
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: `0 0 ${space[2]}`,
};

/** A problem the document itself has, with the panel that fixes it. */
type ListedProblem = ProblemEntry & { panel?: string };

/** The bundle id the document's own findings are listed under. */
const DOCUMENT_SOURCE = "paged.document";

function fileName(uri: string): string {
  const path = uri.replace(/[?#].*$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name) || uri;
  } catch {
    return name || uri;
  }
}

/**
 * PN-350 (UX F-09): the document's own findings, as InDesign's preflight
 * lists them: every missing link and every missing font, each opening
 * the panel that fixes it (Links, Fonts). Read from the same collections
 * Publication health and the Links and Fonts panels count.
 */
function useDocumentProblems(): ListedProblem[] {
  const strings = useStrings();
  const links = useCollection<LinkSummary>("links") ?? [];
  const fonts = useCollection<FontSummary>("fonts") ?? [];
  const out: ListedProblem[] = [];
  for (const l of links) {
    if (l.status !== "missing") continue;
    out.push({
      severity: "error",
      message: strings.t(M.missingLink, { name: fileName(l.uri) }),
      source: "links",
      bundleId: DOCUMENT_SOURCE,
      key: "links",
      panel: "paged.links",
    });
  }
  for (const f of fonts) {
    if (!f.isMissing) continue;
    out.push({
      severity: "error",
      message: strings.t(M.missingFont, { family: f.family }),
      source: "fonts",
      bundleId: DOCUMENT_SOURCE,
      key: "fonts",
      panel: "paged.fonts",
    });
  }
  return out;
}

export function ProblemsPanel() {
  const strings = useStrings();
  const reported = useSyncExternalStore(
    subscribeProblems,
    getProblemsSnapshot,
    getProblemsSnapshot,
  );
  const documentProblems = useDocumentProblems();
  const problems: ListedProblem[] = [...documentProblems, ...reported];
  const registries = useRegistries();

  // The bundle's primary panel: first registered panel whose id sits
  // under the bundle namespace (`media.paged.web` → `…web.panel.…`).
  const panelForBundle = (bundleId: string): string | undefined =>
    registries.panels.list().find((p) => p.id.startsWith(bundleId + "."))?.id;

  const focus = (entry: ListedProblem) => {
    const panelId = entry.panel ?? panelForBundle(entry.bundleId);
    if (panelId) cockpitActions.openPanel?.(panelId);
  };

  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;

  return (
    <div
      data-problems-panel
      style={{
        padding: space[3],
        font: `12px ${font.sans}`,
        color: "var(--pg-fg)",
      }}
    >
      <div style={kicker}>{strings.t(M.title)}</div>
      {problems.length === 0 ? (
        <p
          data-problems-empty
          style={{ margin: 0, color: "var(--pg-muted-fg)" }}
        >
          {strings.t(M.empty)}
        </p>
      ) : (
        <>
          <p
            data-problems-summary
            style={{
              margin: `0 0 ${space[2]}`,
              color: "var(--pg-muted-fg)",
              font: `11px ${font.mono}`,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {strings.t(M.summary, { errors, warnings })}
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {problems.map((p, i) => (
              <li key={i}>
                <button
                  type="button"
                  data-problem
                  data-problem-severity={p.severity}
                  data-problem-bundle={p.bundleId}
                  onClick={() => focus(p)}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: space[2],
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    padding: "4px 2px",
                    borderRadius: radius.sm,
                    font: `11px/1.5 ${font.mono}`,
                    color: "var(--pg-fg)",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: radius.full,
                      background: DOT[p.severity],
                      flex: "none",
                      transform: "translateY(1px)",
                    }}
                  />
                  <span style={{ flex: 1 }}>
                    <span data-problem-message>{p.message}</span>
                    <span
                      data-problem-location
                      style={{ color: "var(--pg-muted-fg)", marginLeft: 6 }}
                    >
                      {p.source ?? p.key}
                      {p.line !== undefined ? `:${p.line}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
