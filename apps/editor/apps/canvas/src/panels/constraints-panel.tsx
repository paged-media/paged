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

// The Design constraints panel (editor ADR 1233): the document's
// constraints, each with whether it holds and by how much it misses, the
// items it names one click away, and Remove (one undo step). A constraint
// that does not hold is also one of the publication's issues, where its
// suggested fix is offered; this panel is where constraints are kept.

import {
  activateIssue,
  operationFeedbackOf,
  useEditorScope,
  usePaged,
  usePublicationIssues,
} from "@paged-media/shell";
import { color, font } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  openAddConstraint,
  removeConstraint,
} from "../constraints/add-constraint";
import { constraintTitle, resultText } from "../constraints/describe";
import { constraintIssueId } from "../constraints/source";
import { useConstraintState } from "../constraints/store";
import { revealItems } from "../reveal-targets";

const M = defineMessages("app.constraintsPanel", {
  empty:
    "No constraints yet. Select items and choose Add constraint… from the context menu or the Object menu.",
  add: "Add constraint…",
  addTitle: "Make a constraint from the selection",
  intro:
    "Rules this document keeps. Paged checks them as you work and suggests fixes; it never moves anything by itself.",
  select: "Select",
  remove: "Remove",
  removeAction: "remove the constraint",
  removed: "Constraint removed",
  refused: "the engine refused the change",
  checking: "Checking…",
  goTo: "Go to it and see the fix",
});

const DOT = {
  holds: "var(--status-ok, #16a34a)",
  broken: "var(--status-review)",
  unknown: "var(--pg-muted-fg)",
} as const;

export function ConstraintsPanel() {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const { constraints, results, pending } = useConstraintState();
  const { issues } = usePublicationIssues();
  const selection = paged.selection.elementSelection;
  const remove = (id: string) => {
    void removeConstraint(paged, id).then((ok) => {
      const feedback = operationFeedbackOf(scope);
      if (ok)
        feedback.report({
          action: strings.t(M.removeAction),
          outcome: "success",
          title: strings.t(M.removed),
          source: "paged.constraints",
          key: "paged.constraints|remove",
        });
      else
        feedback.report({
          action: strings.t(M.removeAction),
          outcome: "blocked",
          reason: strings.t(M.refused),
          document: "unchanged",
          source: "paged.constraints",
        });
    });
  };
  return (
    <div
      data-constraints-panel=""
      data-constraints-pending={pending ? "true" : undefined}
      style={{ padding: 12, font: `12px ${font.sans}`, color: "var(--pg-fg)" }}
    >
      <p style={{ margin: "0 0 8px", color: "var(--pg-muted-fg)" }}>
        {strings.t(M.intro)}
      </p>
      <button
        type="button"
        data-constraints-add=""
        title={strings.t(M.addTitle)}
        disabled={selection.length === 0}
        onClick={() => openAddConstraint(scope, selection)}
        style={buttonStyle}
      >
        {strings.t(M.add)}
      </button>
      {constraints.length === 0 ? (
        <p
          data-constraints-empty=""
          style={{ margin: "10px 0 0", color: "var(--pg-muted-fg)" }}
        >
          {strings.t(M.empty)}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
          {constraints.map((c) => {
            const r = results.get(c.id);
            const status = r?.status ?? "unknown";
            const issue = issues.find((i) => i.id === constraintIssueId(c.id));
            return (
              <li
                key={c.id}
                data-constraint-row={c.id}
                data-constraint-kind={c.kind}
                data-constraint-status={r ? status : "pending"}
                style={{
                  padding: "6px 0",
                  borderTop: `1px solid ${color.border}`,
                  display: "grid",
                  gap: 3,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "baseline", gap: 8 }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flex: "none",
                      background: DOT[status],
                    }}
                  />
                  {issue ? (
                    <button
                      type="button"
                      data-constraint-go=""
                      title={strings.t(M.goTo)}
                      onClick={() => activateIssue(scope, issue)}
                      style={linkStyle}
                    >
                      {constraintTitle(c)}
                    </button>
                  ) : (
                    <span style={{ flex: 1 }}>{constraintTitle(c)}</span>
                  )}
                </div>
                <span
                  data-constraint-state=""
                  style={{ paddingLeft: 15, color: "var(--pg-muted-fg)" }}
                >
                  {r ? resultText(r) : strings.t(M.checking)}
                </span>
                <div style={{ display: "flex", gap: 6, paddingLeft: 15 }}>
                  <button
                    type="button"
                    data-constraint-select=""
                    onClick={() =>
                      void revealItems(
                        paged,
                        {
                          invoke: (id, p) =>
                            paged.registries.commands.invoke(id, p),
                        },
                        c.members,
                      )
                    }
                    style={buttonStyle}
                  >
                    {strings.t(M.select)}
                  </button>
                  <button
                    type="button"
                    data-constraint-remove=""
                    onClick={() => remove(c.id)}
                    style={buttonStyle}
                  >
                    {strings.t(M.remove)}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  font: `11px ${font.sans}`,
  cursor: "pointer",
  background: "transparent",
  color: "var(--pg-fg)",
  border: `1px solid ${color.border}`,
  borderRadius: 4,
  padding: "2px 8px",
};

const linkStyle: React.CSSProperties = {
  flex: 1,
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  color: "var(--pg-primary)",
  cursor: "pointer",
  textAlign: "left",
};
