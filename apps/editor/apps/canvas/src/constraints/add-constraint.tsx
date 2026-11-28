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

// Object ▸ Add constraint… and the canvas context menu's row (editor ADR
// 1233): a constraint made from the selection. The dialog offers the kinds
// the selection can take, each with its one parameter, and says what a
// constraint is — a rule Paged checks, never one it enforces. Adding it is
// one document change (one undo step, the document label). The first
// selected item of an alignment is its key object (D-07).

import { useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import type { ElementId } from "@paged-media/client";
import {
  commandNeeds,
  createValueStore,
  ModalDialog,
  ModalDialogTitle,
  operationFeedbackOf,
  scoped,
  scopeOf,
  useEditorScope,
  useEscapeHandler,
  usePaged,
  useScoped,
  whenNeeds,
  type CommandContribution,
  type EditorScope,
  type MenuItemContribution,
  type PagedEditor,
} from "@paged-media/shell";
import { KitSelect, NumericField } from "@paged-media/ui";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";

import { constraintTitle, edgeLabel, kindLabel, marginLabel } from "./describe";
import {
  constraintsMutation,
  constraintsOfMeta,
  kindsFor,
  MAX_CONSTRAINTS,
  newConstraintId,
  type AlignEdge,
  type Constraint,
  type ConstraintKind,
  type ConstraintParams,
  type MarginEdge,
} from "./model";

export const PAGED_OBJECT_ADD_CONSTRAINT = "paged.object.addConstraint";

const M = defineMessages("app.addConstraint", {
  command: "Add constraint…",
  title: "Add constraint",
  forItems:
    "{count, plural, one {For the selected item} other {For the # selected items; the first is the key object}}",
  kind: "Constraint",
  edge: "Edge",
  margin: "Margin",
  axis: "Direction",
  across: "Across",
  down: "Down",
  lines: "Lines",
  gap: "Gap",
  note: "Paged checks this rule as you work and suggests fixes when it does not hold. It never moves anything by itself.",
  cancel: "Cancel",
  add: "Add",
  added: "Constraint added: {title}",
  addAction: "add the constraint",
  tooMany: "the document already keeps {max} constraints",
  refused: "the engine refused the change",
});

interface Draft {
  members: ElementId[];
}

const OPEN = scoped("addConstraintDialog", () =>
  createValueStore<Draft | null>(null),
);

/** The members `scope`'s Add constraint dialog is open for, or null. */
export function addConstraintDraftOf(scope: EditorScope): ElementId[] | null {
  return scope.get(OPEN).get()?.members ?? null;
}

/** Open `scope`'s Add constraint dialog for `members`. */
export function openAddConstraint(
  scope: EditorScope,
  members: readonly ElementId[],
): void {
  if (members.length === 0) return;
  scope.get(OPEN).set({ members: [...members] });
}

/** Add `constraint` to the document's constraints: one undo step. */
export async function addConstraint(
  paged: Pick<PagedEditor, "client">,
  draft: Omit<Constraint, "id">,
): Promise<
  { ok: true; constraint: Constraint } | { ok: false; reason: string }
> {
  const existing = constraintsOfMeta(await paged.client.documentMeta());
  if (existing.length >= MAX_CONSTRAINTS)
    return { ok: false, reason: t(M.tooMany, { max: MAX_CONSTRAINTS }) };
  const constraint: Constraint = {
    ...draft,
    id: newConstraintId(new Set(existing.map((c) => c.id))),
  };
  const reply = await paged.client.mutate(
    constraintsMutation([...existing, constraint]),
  );
  return reply.kind === "mutationApplied"
    ? { ok: true, constraint }
    : { ok: false, reason: t(M.refused) };
}

/** Remove the constraint `id`: one undo step. */
export async function removeConstraint(
  paged: Pick<PagedEditor, "client">,
  id: string,
): Promise<boolean> {
  const existing = constraintsOfMeta(await paged.client.documentMeta());
  const next = existing.filter((c) => c.id !== id);
  if (next.length === existing.length) return false;
  const reply = await paged.client.mutate(constraintsMutation(next));
  return reply.kind === "mutationApplied";
}

export const ADD_CONSTRAINT_COMMAND: CommandContribution = {
  id: PAGED_OBJECT_ADD_CONSTRAINT,
  get title() {
    return t(M.command);
  },
  category: "Object",
  when: whenNeeds("document", "noText", "selection"),
  applicability: commandNeeds("document", "noText", "selection"),
  handler: (paged) => {
    const editor = paged as PagedEditor;
    openAddConstraint(scopeOf(paged), editor.selection.elementSelection);
  },
};

/** Object ▸ Add constraint…, after the lock and hide band. */
export const CONSTRAINT_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "Object/Add constraint…",
    command: PAGED_OBJECT_ADD_CONSTRAINT,
    order: 29.6,
    group: "constraints",
  },
];

defineMessages("menu", {
  "Add constraint…": "Add constraint…",
});

const ALIGN_EDGES: AlignEdge[] = [
  "left",
  "right",
  "top",
  "bottom",
  "centerX",
  "centerY",
  "baseline",
];
const MARGIN_EDGES: MarginEdge[] = [
  "outer",
  "inner",
  "left",
  "right",
  "top",
  "bottom",
];

export function AddConstraintDialog() {
  const store = useScoped(OPEN);
  const draft = useSyncExternalStore(store.subscribe, store.get, store.get);
  return draft ? <AddConstraintForm draft={draft} /> : null;
}

function AddConstraintForm({ draft }: { draft: Draft }) {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const store = useScoped(OPEN);
  const kinds = kindsFor(draft.members);
  const [kind, setKind] = useState<ConstraintKind>(kinds[0] ?? "margin");
  const [edge, setEdge] = useState<AlignEdge>("left");
  const [margin, setMargin] = useState<MarginEdge>("outer");
  const [axis, setAxis] = useState<"horizontal" | "vertical">("horizontal");
  const [lines, setLines] = useState(3);
  const [gap, setGap] = useState(12);
  const [busy, setBusy] = useState(false);
  const close = () => store.set(null);
  useEscapeHandler({
    id: "paged.addConstraintDialog",
    tier: "modal",
    isActive: () => true,
    resolve: () => close(),
  });
  const allText = draft.members.every((m) => m.kind === "textFrame");
  const params = (): ConstraintParams => {
    switch (kind) {
      case "align":
        return { edge };
      case "margin":
        return { margin };
      case "equal-spacing":
        return { axis };
      case "max-lines":
        return { lines };
      case "min-gap":
        return { gap };
      case "fits":
        return {};
    }
  };
  const submit = () => {
    if (busy) return;
    setBusy(true);
    const constraint = { kind, members: draft.members, params: params() };
    void addConstraint(paged, constraint).then((result) => {
      setBusy(false);
      const feedback = operationFeedbackOf(scope);
      if (result.ok) {
        close();
        feedback.report({
          action: strings.t(M.addAction),
          outcome: "success",
          title: strings.t(M.added, {
            title: constraintTitle(result.constraint),
          }),
          source: "paged.constraints",
          key: "paged.constraints|add",
        });
      } else
        feedback.report({
          action: strings.t(M.addAction),
          outcome: "blocked",
          reason: result.reason,
          document: "unchanged",
          channel: "inline",
          source: "paged.constraints",
        });
    });
  };
  return (
    <ModalDialog
      onClose={close}
      dismissOnOutside
      data-add-constraint-dialog=""
      style={dialogStyle}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{ display: "grid", gap: 10 }}
      >
        <ModalDialogTitle id="add-constraint-title" style={titleStyle}>
          {strings.t(M.title)}
        </ModalDialogTitle>
        <p style={mutedStyle}>
          {strings.t(M.forItems, { count: draft.members.length })}
        </p>
        <label style={rowStyle}>
          <span>{strings.t(M.kind)}</span>
          <KitSelect
            data-add-constraint-kind=""
            value={kind}
            onChange={(e) => setKind(e.target.value as ConstraintKind)}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </KitSelect>
        </label>
        {kind === "align" && (
          <label style={rowStyle}>
            <span>{strings.t(M.edge)}</span>
            <KitSelect
              data-add-constraint-edge=""
              value={edge}
              onChange={(e) => setEdge(e.target.value as AlignEdge)}
            >
              {ALIGN_EDGES.filter((x) => x !== "baseline" || allText).map(
                (x) => (
                  <option key={x} value={x}>
                    {edgeLabel(x)}
                  </option>
                ),
              )}
            </KitSelect>
          </label>
        )}
        {kind === "margin" && (
          <label style={rowStyle}>
            <span>{strings.t(M.margin)}</span>
            <KitSelect
              data-add-constraint-margin=""
              value={margin}
              onChange={(e) => setMargin(e.target.value as MarginEdge)}
            >
              {MARGIN_EDGES.map((x) => (
                <option key={x} value={x}>
                  {marginLabel(x)}
                </option>
              ))}
            </KitSelect>
          </label>
        )}
        {kind === "equal-spacing" && (
          <label style={rowStyle}>
            <span>{strings.t(M.axis)}</span>
            <KitSelect
              data-add-constraint-axis=""
              value={axis}
              onChange={(e) =>
                setAxis(e.target.value as "horizontal" | "vertical")
              }
            >
              <option value="horizontal">{strings.t(M.across)}</option>
              <option value="vertical">{strings.t(M.down)}</option>
            </KitSelect>
          </label>
        )}
        {kind === "max-lines" && (
          <div style={rowStyle} data-add-constraint-lines="">
            <span>{strings.t(M.lines)}</span>
            <NumericField
              value={lines}
              min={1}
              max={999}
              precision={0}
              onCommit={(v) => setLines(Math.max(1, Math.round(v)))}
            />
          </div>
        )}
        {kind === "min-gap" && (
          <div style={rowStyle} data-add-constraint-gap="">
            <span>{strings.t(M.gap)}</span>
            <NumericField
              value={gap}
              length
              min={0}
              onCommit={(v) => setGap(Math.max(0, v))}
            />
          </div>
        )}
        <p data-add-constraint-note="" style={mutedStyle}>
          {strings.t(M.note)}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            data-add-constraint-cancel=""
            onClick={close}
            style={buttonStyle}
          >
            {strings.t(M.cancel)}
          </button>
          <button
            type="submit"
            data-add-constraint-confirm=""
            disabled={busy || kinds.length === 0}
            style={{ ...buttonStyle, ...primaryStyle }}
          >
            {strings.t(M.add)}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

const dialogStyle: CSSProperties = {
  width: "min(400px, 92vw)",
  padding: 16,
  borderRadius: radius.lg,
  border: `1px solid ${color.border}`,
  background: color.elevated,
  color: color.fg,
  boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
  fontSize: 12,
};

const titleStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 };

const mutedStyle: CSSProperties = {
  margin: 0,
  color: color.mutedFg,
  fontSize: 11,
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "88px 1fr",
  alignItems: "center",
  gap: 8,
};

const buttonStyle: CSSProperties = {
  padding: "4px 12px",
  borderRadius: radius.sm,
  border: `1px solid ${color.border}`,
  background: color.bg,
  color: color.fg,
  fontSize: 12,
  cursor: "pointer",
};

const primaryStyle: CSSProperties = {
  background: "var(--pg-primary)",
  borderColor: "var(--pg-primary)",
  color: "var(--pg-primary-fg, white)",
};
