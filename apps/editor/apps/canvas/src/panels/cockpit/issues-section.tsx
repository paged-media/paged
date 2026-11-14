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

// The publication's issues where they are (editor ADR 1223; the UX
// strategy's Concept B; UX audit F-09): a page overview ("1 2 3! 4 5 6!"),
// each issue in a list, a click takes you to it (the view you left kept to
// return to), selects it and shows its fixes — each fix says what it will
// do before it runs, and a fix that changes the document is one undo step.
// "Show issue markers" puts them on the page. Track WS's Issues lens shows
// `IssueOverview` too, so the overview is one component.

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  activateIssue,
  getViewToggle,
  issuesByPage,
  operationFeedbackOf,
  setViewToggle,
  subscribeViewToggles,
  takeReturnView,
  useCockpitActions,
  useEditorScope,
  usePaged,
  usePublicationIssues,
  type IssueSeverity,
  type PublicationIssue,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

import { fixesOf, type IssueFix } from "../../issue-fixes";
import { goToIssue } from "../../publication-issues";

const M = defineMessages("app.issuesSection", {
  title: "Issues",
  none: "No issues found.",
  pages: "Pages",
  page: "Page {n}",
  pageIssues:
    "{count, plural, one {Page {n}: # issue} other {Page {n}: # issues}}",
  document: "Document",
  markers: "Show issue markers on the page",
  returnView: "Return to the previous view",
  fixes: "Fixes",
  applied: "{fix}: applied. Undo takes it back.",
  undo: "Undo",
  fixFailed: "apply {fix}",
  fixRefused: "the engine refused the change",
});

const DOT: Record<IssueSeverity, string> = {
  error: "var(--status-error)",
  warning: "var(--status-review)",
  info: "var(--status-info)",
};

/** Pages with their issues: a strip of page numbers, a dot on the pages
 *  that have issues, coloured by the worst one; a click goes to the page's
 *  first issue. */
export function IssueOverview({
  pageCount,
  issues,
}: {
  pageCount: number;
  issues: readonly PublicationIssue[];
}) {
  const strings = useStrings();
  const scope = useEditorScope();
  const byPage = issuesByPage(issues);
  if (pageCount <= 0) return null;
  return (
    <div
      data-issue-overview
      role="list"
      aria-label={strings.t(M.pages)}
      style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
    >
      {Array.from({ length: pageCount }, (_, i) => {
        const list = byPage.get(i);
        const label = list
          ? strings.t(M.pageIssues, { n: i + 1, count: list.length })
          : strings.t(M.page, { n: i + 1 });
        return (
          <button
            key={i}
            type="button"
            role="listitem"
            data-issue-page={i}
            data-issue-count={list?.length ?? 0}
            data-issue-severity={list?.[0]?.severity}
            aria-label={label}
            title={list ? list.map((x) => x.label).join("\n") : label}
            disabled={!list}
            onClick={() => list && activateIssue(scope, list[0]!)}
            style={{
              minWidth: 26,
              height: 24,
              padding: "0 4px",
              borderRadius: 4,
              border: `1px solid ${list ? DOT[list[0]!.severity] : "var(--pg-border)"}`,
              background: list
                ? `color-mix(in srgb, ${DOT[list[0]!.severity]} 14%, transparent)`
                : "transparent",
              color: list ? "var(--pg-fg)" : "var(--pg-muted-fg)",
              font: "11px var(--font-mono)",
              cursor: list ? "pointer" : "default",
            }}
          >
            {i + 1}
            {list ? "!" : ""}
          </button>
        );
      })}
    </div>
  );
}

export function IssuesSection() {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const { issues, active, returnView } = usePublicationIssues();
  const markers = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "issueMarkers"),
    () => false,
  );
  const pageCount = paged.document.handle?.pageCount ?? 0;
  const rank = (s: IssueSeverity) =>
    s === "error" ? 0 : s === "warning" ? 1 : 2;
  const sorted = [...issues].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      (a.pageIndex ?? -1) - (b.pageIndex ?? -1),
  );
  return (
    <div
      data-issues-section
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <IssueOverview pageCount={pageCount} issues={issues} />
      <label
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
      >
        <input
          type="checkbox"
          data-issue-markers-toggle
          checked={markers}
          onChange={(e) =>
            setViewToggle(scope, "issueMarkers", e.target.checked)
          }
        />
        {strings.t(M.markers)}
      </label>
      {returnView && (
        <button
          type="button"
          data-issue-return
          onClick={() => {
            const view = takeReturnView(scope);
            if (view) paged.camera.setCamera(view);
          }}
          style={linkStyle}
        >
          {strings.t(M.returnView)}
        </button>
      )}
      {sorted.length === 0 ? (
        <span data-issues-none className="pg-ui-xs">
          {strings.t(M.none)}
        </span>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {sorted.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              active={issue.id === active}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueRow({
  issue,
  active,
}: {
  issue: PublicationIssue;
  active: boolean;
}) {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const [fixes, setFixes] = useState<IssueFix[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fixesOf(paged, issue).then((f) => {
      if (!cancelled) setFixes(f);
    });
    return () => {
      cancelled = true;
    };
  }, [active, paged, issue]);
  return (
    <li
      data-issue={issue.id}
      data-issue-kind={issue.kind}
      data-issue-severity={issue.severity}
      data-active={active ? "true" : undefined}
      style={{
        borderBottom: "1px solid var(--pg-border)",
        padding: "5px 0",
      }}
    >
      <button
        type="button"
        data-issue-go
        onClick={() => activateIssue(scope, issue)}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          width: "100%",
          border: "none",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          fontSize: 12,
          textAlign: "left",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: DOT[issue.severity],
            flex: "none",
          }}
        />
        <span style={{ flex: 1 }}>{issue.label}</span>
        <span className="pg-ui-xs" style={{ flex: "none" }}>
          {issue.pageIndex !== undefined
            ? strings.t(M.page, { n: issue.pageIndex + 1 })
            : strings.t(M.document)}
        </span>
      </button>
      {active && fixes && fixes.length > 0 && (
        <div
          data-issue-fixes
          aria-label={strings.t(M.fixes)}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "6px 0 2px 15px",
          }}
        >
          {fixes.map((fix) => (
            <FixButton key={fix.id} issue={issue} fix={fix} />
          ))}
        </div>
      )}
    </li>
  );
}

function FixButton({ issue, fix }: { issue: PublicationIssue; fix: IssueFix }) {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const actions = useCockpitActions();
  const run = () => {
    if (fix.run.kind === "panel") {
      actions.openPanel?.(fix.run.panel);
      return;
    }
    void fix.run.apply(paged).then((ok) => {
      const feedback = operationFeedbackOf(scope);
      if (ok) {
        feedback.report({
          action: fix.label,
          outcome: "success",
          title: strings.t(M.applied, { fix: fix.label }),
          prominent: true,
          actions: [{ label: strings.t(M.undo), command: "paged.editor.undo" }],
          key: `paged.issue-fix|${issue.id}`,
          source: "paged.issues",
        });
        // The item may have moved or changed: go to it again.
        void goToIssue(
          paged,
          (id, payload) => paged.registries.commands.invoke(id, payload),
          issue,
        );
      } else
        feedback.report({
          action: strings.t(M.fixFailed, { fix: fix.label.toLowerCase() }),
          outcome: "blocked",
          reason: strings.t(M.fixRefused),
          document: "unchanged",
          key: `paged.issue-fix|${issue.id}`,
          source: "paged.issues",
        });
    });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <button
        type="button"
        data-issue-fix={fix.id}
        onClick={run}
        style={linkStyle}
      >
        {fix.label}
      </button>
      {fix.preview && (
        <span data-issue-fix-preview className="pg-ui-xs">
          {fix.preview}
        </span>
      )}
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "600 12px var(--font-sans)",
  color: "var(--pg-primary)",
  cursor: "pointer",
  alignSelf: "flex-start",
  textAlign: "left",
};
