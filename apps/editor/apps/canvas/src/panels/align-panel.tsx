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
// Six-button alignment palette: align-left / -center-h / -right
// + align-top / -center-v / -bottom, distribute H / V; each aligns
// the selection to its own AABB edges or centre. Per
// `docs/design/panel-catalog.md` §6 Tier 3 + §10 audit
// register: declares `writes: ["geometry"]` since the commit set
// is a multi-target rewrite of frame bounds.
//
// ADR 323 — the panel no longer computes or sends geometry itself: each
// button invokes the TYPED command `paged.align.objects` with
// `{ kind, targets }` (declared args, align-plan.ts), which reads every
// target's `frameBounds` through `host.objects` and commits ONE batch —
// one undo step. A script invokes the same command.

import {
  Icon,
  useObjectModel,
  useRegistries,
  useSelection,
} from "@paged-media/shell";
import { KitSelect, useDocumentUnit } from "@paged-media/ui";
import { defineMessages, useStrings } from "@paged-media/strings";

import { ALIGN_COMMAND, type AlignKind } from "../align-plan";

const M = defineMessages("app.alignPanel", {
  alignLeft: "Align left",
  centerH: "Center horizontally",
  alignRight: "Align right",
  alignTop: "Align top",
  centerV: "Center vertically",
  alignBottom: "Align bottom",
  distributeH: "Distribute horizontally",
  distributeV: "Distribute vertically",
  alignTo: "Align to",
  selection: "Selection",
  page: "Page — awaiting engine support",
  margins: "Margins — awaiting engine support",
  spread: "Spread — awaiting engine support",
  alignObjects: "Align objects",
  align: "Align",
  distribute: "Distribute",
  spacingToggle: "Use spacing",
  selectToAlign: "Select 2 or more frames to align.",
  selectToDistribute: "Select 3 or more frames to distribute.",
});

// Object-alignment glyphs (objects against a key edge), shared with the
// control bar. `hint` is a message key, shown through the editor's strings.
export const ALIGN_H: Array<{ kind: AlignKind; icon: string; hint: string }> = [
  { kind: "left", icon: "ui-obj-align-left", hint: M.alignLeft },
  {
    kind: "centerH",
    icon: "ui-obj-align-center-h",
    hint: M.centerH,
  },
  { kind: "right", icon: "ui-obj-align-right", hint: M.alignRight },
];
export const ALIGN_V: Array<{ kind: AlignKind; icon: string; hint: string }> = [
  { kind: "top", icon: "ui-obj-align-top", hint: M.alignTop },
  { kind: "centerV", icon: "ui-obj-align-center-v", hint: M.centerV },
  { kind: "bottom", icon: "ui-obj-align-bottom", hint: M.alignBottom },
];

const DISTRIBUTE_BUTTONS: Array<{
  kind: AlignKind;
  icon: string;
  hint: string;
}> = [
  { kind: "distributeH", icon: "ui-cols-2", hint: M.distributeH },
  { kind: "distributeV", icon: "ui-rows", hint: M.distributeV },
];

export function AlignPanel() {
  const strings = useStrings();
  const unit = useDocumentUnit();
  const registries = useRegistries();
  const model = useObjectModel();
  const { elementSelection } = useSelection();
  const enabled = elementSelection.length >= 2;

  async function align(kind: AlignKind) {
    if (!model || elementSelection.length < 2) return;
    const targets = elementSelection.map((id) => model.addressOf(id));
    try {
      await registries.commands.invoke(ALIGN_COMMAND, { kind, targets });
    } catch (err) {
      console.warn(`paged.align: ${kind} refused`, err);
    }
  }

  const distributeEnabled = elementSelection.length >= 3;

  const iconBtn = (
    btn: { kind: AlignKind; icon: string; hint: string },
    on: boolean,
  ) => (
    <button
      type="button"
      key={btn.kind}
      data-align-kind={btn.kind}
      disabled={!on}
      title={strings.t(btn.hint)}
      className="flex h-[30px] w-[32px] items-center justify-center rounded-[6px] border border-input bg-background hover:bg-muted/60 disabled:opacity-50"
      style={{ color: "var(--chrome-icon)" }}
      onClick={() => {
        void align(btn.kind);
      }}
    >
      <Icon name={btn.icon} size={15} />
    </button>
  );

  return (
    <div className="p-3 flex flex-col gap-2" data-align-panel="ready">
      {/* Align-to scope — Selection is the live behaviour; Page /
          Margins / Spread wait on page-membership reads (gap 7). */}
      <div className="mb-px">
        <div
          className="text-[11.5px] mb-[5px]"
          style={{ color: "var(--pg-muted-fg)" }}
        >
          {strings.t(M.alignTo)}
        </div>
        <KitSelect
          aria-label={strings.t(M.alignTo)}
          value="selection"
          onChange={() => {}}
          data-align-scope
        >
          <option value="selection">{strings.t(M.selection)}</option>
          <option value="page" disabled>
            {strings.t(M.page)}
          </option>
          <option value="margins" disabled>
            {strings.t(M.margins)}
          </option>
          <option value="spread" disabled>
            {strings.t(M.spread)}
          </option>
        </KitSelect>
      </div>
      <div className="pg-label pt-1">{strings.t(M.alignObjects)}</div>
      <div className="flex gap-2" role="group" aria-label={strings.t(M.align)}>
        <div className="flex gap-1">
          {ALIGN_H.map((b) => iconBtn(b, enabled))}
        </div>
        <div
          className="w-px self-stretch"
          style={{ background: "var(--pg-border)" }}
        />
        <div className="flex gap-1">
          {ALIGN_V.map((b) => iconBtn(b, enabled))}
        </div>
      </div>
      <div className="pg-label pt-2">{strings.t(M.distribute)}</div>
      <div
        className="flex gap-1"
        role="group"
        aria-label={strings.t(M.distribute)}
      >
        {DISTRIBUTE_BUTTONS.map((b) => iconBtn(b, distributeEnabled))}
      </div>
      {/* Equal-spacing distribute — honest seam until the panel
          grows the spacing input's commit path. */}
      <div className="-mx-3 mt-1 flex items-center gap-2 border-t border-input px-3 pt-[10px]">
        <span data-seam className="contents">
          <button
            type="button"
            role="switch"
            aria-checked={false}
            aria-label={strings.t(M.spacingToggle)}
            disabled
            data-use-spacing
            className="relative w-[30px] h-[17px] shrink-0 rounded-full border-0 opacity-55"
            style={{ background: "var(--chrome-divider)" }}
          >
            <span className="absolute top-[2px] left-[2px] w-[13px] h-[13px] rounded-full bg-white shadow" />
          </button>
          <span className="flex-1 text-xs" style={{ color: "var(--pg-fg)" }}>
            {strings.t(M.spacingToggle)}
          </span>
          <span
            className="pg-value text-xs"
            style={{ color: "var(--pg-muted-fg)" }}
          >
            — {unit}
          </span>
        </span>
      </div>
      {enabled ? null : (
        <div className="text-xs text-muted-foreground" data-align-hint>
          {strings.t(M.selectToAlign)}
        </div>
      )}
      {!distributeEnabled && enabled ? (
        <div className="text-xs text-muted-foreground" data-distribute-hint>
          {strings.t(M.selectToDistribute)}
        </div>
      ) : null}
    </div>
  );
}
