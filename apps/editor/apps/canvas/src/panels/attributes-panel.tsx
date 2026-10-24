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

// SDK Phase 5 / gallery pixel-parity — Attributes panel, composed
// to the deep1 card (gallery-deep1.jsx `Attributes`):
//
//   Visible / Locked       check rows            LIVE  (W2.5)
//   Nonprinting            check row             LIVE
//   ── OVERPRINT kicker ──
//   Overprint fill/stroke  check rows            LIVE  (W2.3)
//   Gap color               label-left swatch    seam
//   ── PATH kicker ──
//   Fill rule              two-segment toggle    LIVE  (engine ADR 1006)
//   Reverse path direction button                paged.draw's command
//
// The LIVE pills bind `selectionProperty:frame{Nonprinting,
// OverprintFill,OverprintStroke}` + the element-level
// `element{Visible,Locked}` (W2.5, 2026-06-07). Kind coverage:
// element visible/locked are on every CommonAttrs-bearing page-item
// kind; nonprinting + overprint as before. On a kind without the
// PropertyEntry the binding reads null → the pill shows the mixed
// (em-dash) sentinel, disabled.
//
// FILL RULE (Illustrator's Attributes ▸ Use Non-Zero / Even-Odd Fill
// Rule) binds `frameFillRule`, a native engine property on every frame
// kind with an outline (Text frame, Rectangle, Oval, Polygon, Graphic
// line). It is a property, not a command: the toggle is one
// `host.objects` write (one batch over a multi-selection = one undo
// step), read back through the same field. A group has no outline of
// its own, so a selection holding one reads mixed.
//
// REVERSE PATH DIRECTION sits beside it because, under non-zero, the
// direction of each contour is what makes a hole. The engine has no
// reversal op; the reversal is paged.draw's command (draw-geometry's
// `reverseContour`, written through `framePath`), so the button invokes
// that command by id and is disabled when no bundle registered it (an
// editor without draw) or nothing is selected.

import { useMemo, useState } from "react";

import {
  Icon,
  ObjectFieldFrame,
  PropertyField,
  TogglePill,
  useObjectBindings,
  useObjectField,
  useObjectModel,
  useRegistries,
  useRegistryView,
  useSelection,
  type ObjectField,
} from "@paged-media/shell";
import type { Value } from "@paged-media/client";

import { useAddressOfElement } from "../object-model";
import { Segment, refusalText, status } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.attributesPanel", {
  visible: "Visible",
  locked: "Locked",
  nonprinting: "Nonprinting",
  overprint: "Overprint",
  overprintFill: "Overprint fill",
  overprintStroke: "Overprint stroke",
  gapColor: "Gap color",
  labels: "Labels",
  noLabels: "No labels on this object.",
  onlyPagedLabels: "Only x-paged: labels are written here",
  addLabel: "Add label",
  path: "Path",
  fillRule: "Fill rule",
  nonZero: "Use non-zero fill rule",
  evenOdd: "Use even-odd fill rule",
  reversePath: "Reverse path direction",
});

/** paged.draw's Reverse Path Direction (draw-bundle
 *  `commands/reverse-path.ts`): it reverses every contour of every
 *  selected path in one undo step. */
export const REVERSE_PATH_COMMAND_ID =
  "media.paged.draw.command.reversePathDirection";

/** The two values of `frameFillRule` (engine ADR 1006). */
const FILL_RULES = [
  { value: "NonZero", glyph: "ui-fill-rule-nonzero", label: "nonZero" },
  { value: "EvenOdd", glyph: "ui-fill-rule-evenodd", label: "evenOdd" },
] as const;

// ADR 323 — every pill is an object-model field: reads/writes through
// `host.objects` (one batch over a multi-selection = one undo step),
// each row an `ObjectFieldFrame` ("Bind to data…" + badges).
const BINDINGS = {
  visible: { scope: "element" as const, path: "elementVisible" },
  locked: { scope: "element" as const, path: "elementLocked" },
  nonprinting: { scope: "element" as const, path: "frameNonprinting" },
  overprintFill: { scope: "element" as const, path: "frameOverprintFill" },
  overprintStroke: { scope: "element" as const, path: "frameOverprintStroke" },
  fillRule: { scope: "element" as const, path: "frameFillRule" },
};

function unwrapBool(v: Value | null): boolean | null {
  if (!v) return null;
  if (v.type !== "bool") return null;
  return v.value as boolean;
}

function unwrapText(v: Value | null): string | null {
  if (!v) return null;
  if (v.type !== "text") return null;
  return v.value as string;
}

/** The fill-rule toggle: two joined segments, one per rule, the active
 *  one pressed. A mixed selection presses neither; a selection with no
 *  write path (nothing selected, a kind without an outline) disables
 *  both. */
function FillRuleRow({ field }: { field: ObjectField }) {
  const strings = useStrings();
  const rule = unwrapText(field.value);
  // An unset rule reads as the engine's default.
  const current = rule === "" ? "NonZero" : rule;
  const inert = field.onCommit == null;
  return (
    <ObjectFieldFrame field={field}>
      <div
        className="flex items-center justify-between py-[6px]"
        data-fill-rule-row=""
        data-mixed={current === null ? "" : undefined}
      >
        <span className="text-xs" style={{ color: "var(--pg-fg)" }}>
          {strings.t(M.fillRule)}
        </span>
        <div
          role="group"
          aria-label={strings.t(M.fillRule)}
          className="inline-flex overflow-hidden rounded-[6px] border border-input"
          style={{ opacity: inert ? 0.55 : 1 }}
        >
          {FILL_RULES.map((opt, i) => {
            const active = current === opt.value;
            const label = strings.t(M[opt.label]);
            return (
              <Segment
                key={opt.value}
                pressed={active}
                disabled={inert}
                data-fill-rule={opt.value}
                aria-label={label}
                title={label}
                className="flex h-[26px] w-[32px] cursor-pointer items-center justify-center border-0 disabled:cursor-default"
                style={{
                  borderRight:
                    i < FILL_RULES.length - 1
                      ? "1px solid var(--pg-border)"
                      : "none",
                  background: active
                    ? "var(--chrome-slot-active)"
                    : "var(--pg-bg)",
                  color: active
                    ? "var(--chrome-icon-active)"
                    : "var(--pg-muted-fg)",
                }}
                onClick={() => {
                  if (active) return;
                  field.onCommit?.({ type: "text", value: opt.value } as Value);
                }}
              >
                <Icon name={opt.glyph} size={15} />
              </Segment>
            );
          })}
        </div>
      </div>
    </ObjectFieldFrame>
  );
}

/** Reverse Path Direction: paged.draw's command, invoked by id. */
function ReversePathButton() {
  const strings = useStrings();
  const registries = useRegistries();
  const commands = useRegistryView(registries.commands);
  const { elementSelection } = useSelection();
  const available =
    commands.get(REVERSE_PATH_COMMAND_ID) !== undefined &&
    (commands.offered?.(REVERSE_PATH_COMMAND_ID) ?? true);
  return (
    <div className="flex justify-end pb-1 pt-[2px]">
      <button
        type="button"
        data-reverse-path=""
        disabled={!available || elementSelection.length === 0}
        onClick={() => {
          void registries.commands.invoke(REVERSE_PATH_COMMAND_ID);
        }}
        className="h-[26px] rounded-[6px] border border-input px-2 text-[11px] disabled:opacity-55"
      >
        {strings.t(M.reversePath)}
      </button>
    </div>
  );
}

function CheckRow({
  field,
  row,
  label,
  on,
  mixed,
  seam,
  disabled,
  onToggle,
}: {
  field: ObjectField;
  /** The row's name for tests (English); `label` is what it shows. */
  row: string;
  label: string;
  on: boolean;
  mixed?: boolean;
  seam?: boolean;
  disabled?: boolean;
  onToggle?: (next: boolean) => void;
}) {
  return (
    <ObjectFieldFrame field={field}>
      <label
        className="flex items-center justify-between py-[6px]"
        data-check-row={row}
        data-seam={seam ? "true" : undefined}
      >
        <span className="text-xs" style={{ color: "var(--pg-fg)" }}>
          {label}
        </span>
        <TogglePill
          checked={on}
          mixed={mixed}
          disabled={seam || disabled}
          onToggle={onToggle}
        />
      </label>
    </ObjectFieldFrame>
  );
}

export function AttributesPanel() {
  const strings = useStrings();
  const resolved = useObjectBindings(BINDINGS);
  const vis = resolved.visible;
  const visChecked = unwrapBool(vis.value);
  const lock = resolved.locked;
  const lockChecked = unwrapBool(lock.value);
  const np = resolved.nonprinting;
  const checked = unwrapBool(np.value);
  const opFill = resolved.overprintFill;
  const opFillChecked = unwrapBool(opFill.value);
  const opStroke = resolved.overprintStroke;
  const opStrokeChecked = unwrapBool(opStroke.value);

  return (
    <div className="p-3 flex flex-col" data-attributes-panel="ready">
      {/* W2.5 — element-level Visible / Locked. Default visible=true,
          so the unset state shows checked; mixed selections read null
          → the em-dash sentinel. */}
      <CheckRow
        field={vis}
        row="Visible"
        label={strings.t(M.visible)}
        on={visChecked === true}
        mixed={visChecked === null}
        disabled={vis.onCommit == null}
        onToggle={(next) => {
          vis.onCommit?.({ type: "bool", value: next } as Value);
        }}
      />
      <CheckRow
        field={lock}
        row="Locked"
        label={strings.t(M.locked)}
        on={lockChecked === true}
        mixed={lockChecked === null}
        disabled={lock.onCommit == null}
        onToggle={(next) => {
          lock.onCommit?.({ type: "bool", value: next } as Value);
        }}
      />
      <CheckRow
        field={np}
        row="Nonprinting"
        label={strings.t(M.nonprinting)}
        on={checked === true}
        mixed={checked === null}
        disabled={np.onCommit == null}
        onToggle={(next) => {
          np.onCommit?.({ type: "bool", value: next } as Value);
        }}
      />
      <div className="-mx-3 mt-2 border-t border-input px-3 pt-2">
        <div className="pg-label mb-1">{strings.t(M.overprint)}</div>
        <CheckRow
          field={opFill}
          row="Overprint fill"
          label={strings.t(M.overprintFill)}
          on={opFillChecked === true}
          mixed={opFillChecked === null}
          disabled={opFill.onCommit == null}
          onToggle={(next) => {
            opFill.onCommit?.({ type: "bool", value: next } as Value);
          }}
        />
        <CheckRow
          field={opStroke}
          row="Overprint stroke"
          label={strings.t(M.overprintStroke)}
          on={opStrokeChecked === true}
          mixed={opStrokeChecked === null}
          disabled={opStroke.onCommit == null}
          onToggle={(next) => {
            opStroke.onCommit?.({ type: "bool", value: next } as Value);
          }}
        />
      </div>
      {/* Gap color is live (PN-258): the engine reads and writes
          frameStrokeGapColor, as the Stroke panel does; it was a seam
          "awaiting engine support" after the engine had it. */}
      <div className="mt-1">
        <PropertyField
          path="frameStrokeGapColor"
          label={strings.t(M.gapColor)}
          scope="element"
        />
      </div>
      <div
        className="-mx-3 mt-2 border-t border-input px-3 pt-2"
        data-section="Path"
      >
        <div className="pg-label mb-1">{strings.t(M.path)}</div>
        <FillRuleRow field={resolved.fillRule} />
        <ReversePathButton />
      </div>
      <LabelsSection />
    </div>
  );
}

/** A new label starts as an empty envelope (plugin-sdk's label shape). */
const EMPTY_ENVELOPE = '{"v":1,"data":{}}';
const LABEL_NS = "x-paged:";

/**
 * ADR 323 §4 — the element's script labels (`labels[key]`, IDML
 * `Properties/Label` KeyValuePairs). Every label is READ (the `labels`
 * map); only the `x-paged:` namespace is WRITTEN — core refuses any
 * other key, so a foreign label (InDesign's own, another tool's) stays
 * read-only here rather than offering a write that cannot land. Each
 * value is a PropertyField on `labels[<key>]` (one write = one undo
 * step, "Bind to data…").
 */
function LabelsSection() {
  const addressOfElement = useAddressOfElement();
  const strings = useStrings();
  const { elementSelection } = useSelection();
  const model = useObjectModel();
  const first = elementSelection.length === 1 ? elementSelection[0] : null;
  // eslint-disable-next-line no-restricted-syntax -- handed to a component that may compare it (ADR 229)
  const address = useMemo(
    () => (first ? addressOfElement(first) : null),
    [addressOfElement, first],
  );
  const targets = address ? [address] : [];
  const map = useObjectField({
    path: "labels",
    targets,
    schemaKind: address ?? "frame",
  });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!address) return null;
  const labels =
    map.state.state === "value" &&
    map.state.value &&
    typeof map.state.value === "object"
      ? Object.keys(map.state.value as Record<string, unknown>).sort()
      : [];
  const add = async () => {
    const key = draft.startsWith(LABEL_NS) ? draft : `${LABEL_NS}${draft}`;
    if (!model || draft.trim() === "") return;
    const r = await model.objects.set(
      address,
      `labels[${key}]`,
      EMPTY_ENVELOPE,
      { label: "labels" },
    );
    setError(r.applied ? null : refusalText(r));
    if (r.applied) setDraft("");
  };
  return (
    <div
      className="-mx-3 mt-2 border-t border-input px-3 pt-2"
      data-section="Labels"
      data-labels-target={address}
    >
      <div className="pg-label mb-1">{strings.t(M.labels)}</div>
      {labels.length === 0 ? (
        <div
          className="pb-1 text-xs"
          style={{ color: "var(--pg-muted-fg)" }}
          data-labels-empty=""
        >
          {strings.t(M.noLabels)}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 pb-1" data-labels-list="">
          {labels.map((key) =>
            key.startsWith(LABEL_NS) ? (
              <PropertyField
                key={key}
                path={`labels[${key}]`}
                label={key.slice(LABEL_NS.length)}
                labelPosition="stack"
                targets={targets}
                schemaKind={address}
              />
            ) : (
              <div
                key={key}
                className="text-xs"
                data-label-readonly={key}
                title={strings.t(M.onlyPagedLabels)}
              >
                <span className="font-mono">{key}</span>
              </div>
            ),
          )}
        </div>
      )}
      <div className="flex items-center gap-[5px] pb-1">
        <input
          data-label-new-key=""
          placeholder="x-paged:plugin.id"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-[26px] flex-1 rounded-[6px] border border-input bg-background px-2 font-mono text-[11px]"
        />
        <button
          type="button"
          data-label-add=""
          disabled={draft.trim() === ""}
          onClick={() => void add()}
          className="h-[26px] rounded-[6px] border border-input px-2 text-[11px]"
        >
          {strings.t(M.addLabel)}
        </button>
      </div>
      {error && (
        <div
          data-label-error=""
          className="text-[10.5px]"
          style={{ color: status.error }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
