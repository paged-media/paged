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

// The publication's issues on the page (editor ADR 1223; the UX strategy's
// Concept B): with View ▸ Show issue markers on, every issue that stands
// on an item gets a marker at the item's top-right corner, and every issue
// that stands on a page (a preflight finding, an import loss on a page)
// one at the page's top-left. The marker's colour is the worst severity
// there; several issues on one item share one marker with their count. A
// click goes to the issue (it is selected, its fixes shown). Overlay
// chrome: it never prints or exports, and it is off by default.

import { useSyncExternalStore } from "react";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useEditorScope } from "../state/editor-scope";
import {
  activateIssue,
  usePublicationIssues,
  type IssueSeverity,
  type PublicationIssue,
} from "../state/publication-issues";
import { getViewToggle, subscribeViewToggles } from "../state/view-toggles";

const FILL: Record<IssueSeverity, string> = {
  error: "var(--status-error)",
  warning: "var(--status-review)",
  info: "var(--status-info)",
};

const rank = (s: IssueSeverity) =>
  s === "error" ? 0 : s === "warning" ? 1 : 2;

/** One marker: the issues that share an anchor. */
export interface IssueMarker {
  key: string;
  pageId: string;
  /** Page-local points. */
  at: [number, number];
  issues: PublicationIssue[];
  severity: IssueSeverity;
}

/** The markers of `issues`: one per item, one per page for page issues;
 *  an issue on no page draws none. PURE. */
export function issueMarkersOf(
  issues: readonly PublicationIssue[],
): IssueMarker[] {
  const by = new Map<string, IssueMarker>();
  for (const issue of issues) {
    if (!issue.pageId) continue;
    const box = issue.element ? issue.box : undefined;
    const key = box
      ? `item:${issue.element!.kind}:${String(issue.element!.id)}`
      : `page:${issue.pageId}`;
    const at: [number, number] = box ? [box[0] + box[2], box[1]] : [0, 0];
    const marker = by.get(key);
    if (marker) {
      marker.issues.push(issue);
      if (rank(issue.severity) < rank(marker.severity))
        marker.severity = issue.severity;
    } else {
      by.set(key, {
        key,
        pageId: issue.pageId,
        at,
        issues: [issue],
        severity: issue.severity,
      });
    }
  }
  return [...by.values()];
}

function IssueMarkersRender(props: OverlayProps) {
  const scope = useEditorScope();
  const on = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "issueMarkers"),
    () => false,
  );
  const { issues, active } = usePublicationIssues();
  if (!on) return null;
  const markers = issueMarkersOf(issues);
  const inv = 1 / props.camera.scale;
  return (
    <g data-issue-markers={markers.length > 0 ? "ready" : "empty"}>
      {markers.map((m) => {
        const pr = props.pageRects.get(m.pageId as never);
        if (!pr) return null;
        const first = [...m.issues].sort(
          (a, b) => rank(a.severity) - rank(b.severity),
        )[0]!;
        const isActive = m.issues.some((i) => i.id === active);
        return (
          <g
            key={m.key}
            data-issue-marker={m.key}
            data-issue-kinds={[...new Set(m.issues.map((i) => i.kind))].join(
              " ",
            )}
            data-issue-severity={m.severity}
            data-active={isActive ? "true" : undefined}
            transform={`translate(${pr.x + m.at[0]}, ${pr.y + m.at[1]}) scale(${inv})`}
            style={{ cursor: "pointer", pointerEvents: "all" }}
            onPointerDown={(e) => {
              // Win the pointer before the canvas starts a marquee.
              e.preventDefault();
              e.stopPropagation();
              activateIssue(scope, first);
            }}
          >
            <title>{m.issues.map((i) => i.label).join("\n")}</title>
            <circle
              r={8}
              fill={FILL[m.severity]}
              stroke={isActive ? "var(--overlay-selection)" : "white"}
              strokeWidth={isActive ? 2 : 1.25}
            />
            <text
              y={3.5}
              textAnchor="middle"
              fontSize={10}
              fontWeight={700}
              fontFamily="var(--font-sans)"
              fill="white"
              pointerEvents="none"
            >
              {m.issues.length > 1 ? String(m.issues.length) : "!"}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export const issueMarkersContribution: OverlayContribution = {
  id: "paged.overlay.issueMarkers",
  render: IssueMarkersRender,
  // Above the comment pins (60), under the selection chrome (z 100).
  z: 62,
};
