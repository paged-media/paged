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

// SDK Phase 5 (v1 sweep) — Align panel.
//
// InDesign's Align panel: Align Objects (six edges and centres), Distribute
// Objects (the same six, spacing that edge evenly), Distribute Spacing
// (equal gaps), each against the scope in "Align to": the selection, a
// key object, the margins, the page or the spread. "Use spacing" fixes
// the step / gap to a typed distance. Per `docs/design/panel-catalog.md`
// §6 Tier 3 + §10 audit register: declares `writes: ["geometry"]`.
//
// ADR 323 — the panel computes and sends no geometry itself: each button
// invokes the TYPED command `paged.align.objects` with
// `{ kind, targets, to, key?, spacing? }` (align-plan.ts), which reads the
// targets' spread-space geometry and commits ONE batch — one undo step. A
// script invokes the same command.
//
// WP4.4 — the page scopes read the pages' placement and margins (engine
// WP2.7). With "Key object", the selection's first object is the key; a
// click on another selected object makes that one the key (the canvas
// click path, `clickKeyObject`), and the selection chrome draws it with a
// thicker outline. The scope and the key are per editor (ALIGN_SCOPE).

import { useState, useSyncExternalStore } from "react";

import {
  ALIGN_SCOPE,
  effectiveKeyObject,
  Icon,
  useObjectModel,
  useRegistries,
  useScoped,
  useSelection,
  type AlignTo,
} from "@paged-media/shell";
import { KitSelect, LengthInput } from "@paged-media/ui";
import { defineMessages, useStrings } from "@paged-media/strings";

import { ALIGN_COMMAND, type AlignArgs, type AlignKind } from "../align-plan";

const M = defineMessages("app.alignPanel", {
  alignLeft: "Align left",
  centerH: "Center horizontally",
  alignRight: "Align right",
  alignTop: "Align top",
  centerV: "Center vertically",
  alignBottom: "Align bottom",
  distributeLeft: "Distribute left edges",
  distributeH: "Distribute horizontal centers",
  distributeRight: "Distribute right edges",
  distributeTop: "Distribute top edges",
  distributeV: "Distribute vertical centers",
  distributeBottom: "Distribute bottom edges",
  spaceH: "Distribute horizontal space",
  spaceV: "Distribute vertical space",
  alignTo: "Align to",
  selection: "Selection",
  keyObject: "Key object",
  margins: "Margins",
  page: "Page",
  spread: "Spread",
  alignObjects: "Align objects",
  align: "Align",
  distribute: "Distribute objects",
  distributeSpacing: "Distribute spacing",
  spacingToggle: "Use spacing",
  spacingValue: "Spacing",
  selectToAlign: "Select 2 or more objects to align.",
  selectToAlignPage: "Select an object to align.",
  selectToDistribute: "Select 3 or more objects to distribute.",
  keyHint: "Click a selected object to make it the key object.",
});

type Button = { kind: AlignKind; icon: string; hint: string };

// Object-alignment glyphs (objects against a key edge), shared with the
// control bar. `hint` is a message key, shown through the editor's strings.
export const ALIGN_H: Button[] = [
  { kind: "left", icon: "ui-obj-align-left", hint: M.alignLeft },
  { kind: "centerH", icon: "ui-obj-align-center-h", hint: M.centerH },
  { kind: "right", icon: "ui-obj-align-right", hint: M.alignRight },
];
export const ALIGN_V: Button[] = [
  { kind: "top", icon: "ui-obj-align-top", hint: M.alignTop },
  { kind: "centerV", icon: "ui-obj-align-center-v", hint: M.centerV },
  { kind: "bottom", icon: "ui-obj-align-bottom", hint: M.alignBottom },
];

const DISTRIBUTE_H: Button[] = [
  { kind: "distributeLeft", icon: "ui-dist-left", hint: M.distributeLeft },
  { kind: "distributeH", icon: "ui-dist-center-h", hint: M.distributeH },
  { kind: "distributeRight", icon: "ui-dist-right", hint: M.distributeRight },
];
const DISTRIBUTE_V: Button[] = [
  { kind: "distributeTop", icon: "ui-dist-top", hint: M.distributeTop },
  { kind: "distributeV", icon: "ui-dist-center-v", hint: M.distributeV },
  {
    kind: "distributeBottom",
    icon: "ui-dist-bottom",
    hint: M.distributeBottom,
  },
];
const SPACING: Button[] = [
  { kind: "spaceH", icon: "ui-space-h", hint: M.spaceH },
  { kind: "spaceV", icon: "ui-space-v", hint: M.spaceV },
];

const SCOPE_LABEL: Record<AlignTo, string> = {
  selection: M.selection,
  keyObject: M.keyObject,
  margins: M.margins,
  page: M.page,
  spread: M.spread,
};
const SCOPES: AlignTo[] = [
  "selection",
  "keyObject",
  "margins",
  "page",
  "spread",
];

export function AlignPanel() {
  const strings = useStrings();
  const registries = useRegistries();
  const model = useObjectModel();
  const { elementSelection } = useSelection();
  const store = useScoped(ALIGN_SCOPE);
  const scope = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [useSpacing, setUseSpacing] = useState(false);
  const [spacingPt, setSpacingPt] = useState(0);

  const count = elementSelection.length;
  const pageScope =
    scope.to === "page" || scope.to === "margins" || scope.to === "spread";
  const alignEnabled = count >= (pageScope ? 1 : 2);
  const distributeEnabled = count >= (pageScope || useSpacing ? 2 : 3);
  const key = effectiveKeyObject(scope, elementSelection);

  async function align(kind: AlignKind) {
    if (!model || count === 0) return;
    const args: AlignArgs = {
      kind,
      targets: elementSelection.map((id) => model.addressOf(id)),
      to: scope.to,
      ...(key ? { key: model.addressOf(key) } : {}),
      ...(useSpacing &&
      (kind.startsWith("distribute") || kind.startsWith("space"))
        ? { spacing: spacingPt }
        : {}),
    };
    try {
      await registries.commands.invoke(ALIGN_COMMAND, args);
    } catch (err) {
      console.warn(`paged.align: ${kind} refused`, err);
    }
  }

  const iconBtn = (btn: Button, on: boolean) => (
    <button
      type="button"
      key={btn.kind}
      data-align-kind={btn.kind}
      disabled={!on}
      title={strings.t(btn.hint)}
      aria-label={strings.t(btn.hint)}
      className="flex h-[30px] w-[32px] items-center justify-center rounded-[6px] border border-input bg-background hover:bg-muted/60 disabled:opacity-50"
      style={{ color: "var(--chrome-icon)" }}
      onClick={() => {
        void align(btn.kind);
      }}
    >
      <Icon name={btn.icon} size={15} />
    </button>
  );
  const divider = (
    <div
      className="w-px self-stretch"
      style={{ background: "var(--pg-border)" }}
    />
  );

  return (
    <div className="p-3 flex flex-col gap-2" data-align-panel="ready">
      <div className="mb-px">
        <div
          className="text-[11.5px] mb-[5px]"
          style={{ color: "var(--pg-muted-fg)" }}
        >
          {strings.t(M.alignTo)}
        </div>
        <KitSelect
          aria-label={strings.t(M.alignTo)}
          value={scope.to}
          onChange={(e) => {
            store.set({ to: e.target.value as AlignTo, key: null });
          }}
          data-align-scope
        >
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {strings.t(SCOPE_LABEL[s])}
            </option>
          ))}
        </KitSelect>
        {scope.to === "keyObject" ? (
          <div
            className="mt-1 text-xs text-muted-foreground"
            data-key-object-hint
          >
            {strings.t(M.keyHint)}
          </div>
        ) : null}
      </div>
      <div className="pg-label pt-1">{strings.t(M.alignObjects)}</div>
      <div className="flex gap-2" role="group" aria-label={strings.t(M.align)}>
        <div className="flex gap-1">
          {ALIGN_H.map((b) => iconBtn(b, alignEnabled))}
        </div>
        {divider}
        <div className="flex gap-1">
          {ALIGN_V.map((b) => iconBtn(b, alignEnabled))}
        </div>
      </div>
      <div className="pg-label pt-2">{strings.t(M.distribute)}</div>
      <div
        className="flex gap-2"
        role="group"
        aria-label={strings.t(M.distribute)}
      >
        <div className="flex gap-1">
          {DISTRIBUTE_H.map((b) => iconBtn(b, distributeEnabled))}
        </div>
        {divider}
        <div className="flex gap-1">
          {DISTRIBUTE_V.map((b) => iconBtn(b, distributeEnabled))}
        </div>
      </div>
      <div className="pg-label pt-2">{strings.t(M.distributeSpacing)}</div>
      <div
        className="flex gap-1"
        role="group"
        aria-label={strings.t(M.distributeSpacing)}
      >
        {SPACING.map((b) => iconBtn(b, distributeEnabled))}
      </div>
      <div className="-mx-3 mt-1 flex items-center gap-2 border-t border-input px-3 pt-[10px]">
        <button
          type="button"
          role="switch"
          aria-checked={useSpacing}
          aria-label={strings.t(M.spacingToggle)}
          data-use-spacing
          onClick={() => setUseSpacing(!useSpacing)}
          className="relative w-[30px] h-[17px] shrink-0 rounded-full border-0"
          style={{
            background: useSpacing
              ? "var(--pg-primary, var(--chrome-accent))"
              : "var(--chrome-divider)",
          }}
        >
          <span
            className="absolute top-[2px] w-[13px] h-[13px] rounded-full bg-white shadow"
            style={{ left: useSpacing ? 15 : 2 }}
          />
        </button>
        <span className="flex-1 text-xs" style={{ color: "var(--pg-fg)" }}>
          {strings.t(M.spacingToggle)}
        </span>
        <span className="w-[92px]" data-spacing-value>
          <LengthInput
            aria-label={strings.t(M.spacingValue)}
            valuePt={spacingPt}
            disabled={!useSpacing}
            onChangePt={setSpacingPt}
          />
        </span>
      </div>
      {alignEnabled ? null : (
        <div className="text-xs text-muted-foreground" data-align-hint>
          {strings.t(pageScope ? M.selectToAlignPage : M.selectToAlign)}
        </div>
      )}
      {!distributeEnabled && alignEnabled ? (
        <div className="text-xs text-muted-foreground" data-distribute-hint>
          {strings.t(M.selectToDistribute)}
        </div>
      ) : null}
    </div>
  );
}
