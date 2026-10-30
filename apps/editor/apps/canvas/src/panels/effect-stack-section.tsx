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

// Engine ADR 1008 — the Effects panel's stack: the effects of the picked
// transparency target in the order they apply, each with its switch,
// move-up / move-down and remove; an Add menu with every kind the target
// takes; and, for a stack-only effect (blur, outline stroke, overlays,
// reflection, soft edge, noise, colour adjustment), its blend mode,
// opacity and parameters. InDesign's own effects keep their parameters
// in the disclosures below the stack (their per-field paths). Every
// gesture is one write of the whole stack, so one undo step.

import { useState } from "react";

import {
  ObjectFieldFrame,
  TogglePill,
  useObjectBindings,
  type ObjectField,
} from "@paged-media/shell";
import { ColorPicker, KitSelect, NumberInput } from "@paged-media/ui";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

import {
  PARAMS,
  STACK_PATHS,
  add,
  addable,
  entriesOf,
  isIndesign,
  move,
  remove,
  setEnabled,
  setParam,
  type EffectKind,
  type ParamSpec,
  type StackEntry,
  type StackTarget,
} from "./effect-stack";

const M = defineMessages("app.effectStack", {
  stack: "Stack",
  add: "Add effect…",
  moveUp: "Move up",
  moveDown: "Move down",
  remove: "Remove",
  empty: "No effects",
  mixed: "The selection's stacks differ",
  blend: "Blend",
  opacity: "Opacity",
  dropShadow: "Drop shadow",
  innerShadow: "Inner shadow",
  outerGlow: "Outer glow",
  innerGlow: "Inner glow",
  bevelEmboss: "Bevel and emboss",
  satin: "Satin",
  feather: "Feather",
  directionalFeather: "Directional feather",
  gradientFeather: "Gradient feather",
  gaussianBlur: "Gaussian blur",
  outlineStroke: "Outline stroke",
  colorOverlay: "Color overlay",
  gradientOverlay: "Gradient overlay",
  reflection: "Reflection",
  softEdge: "Soft edge",
  noise: "Noise",
  colorAdjust: "Color adjustment",
  radius: "Radius",
  size: "Size",
  position: "Position",
  outside: "Outside",
  inside: "Inside",
  center: "Center",
  color: "Color",
  gradient: "Gradient",
  angle: "Angle",
  reverse: "Reverse",
  distance: "Distance",
  startOpacity: "Start opacity",
  endOpacity: "End opacity",
  blur: "Blur",
  amount: "Amount",
  monochromatic: "Monochromatic",
  brightness: "Brightness",
  contrast: "Contrast",
  saturation: "Saturation",
  hue: "Hue",
  indesignParams: "Its settings are in its section below.",
});

/** The display name of a kind. */
export function effectName(strings: Strings, kind: EffectKind): string {
  return strings.t((M as Record<string, string>)[kind] ?? kind);
}

const STACK_BINDINGS = {
  object: { path: STACK_PATHS.object, scope: "element" as const },
  fill: { path: STACK_PATHS.fill, scope: "element" as const },
  stroke: { path: STACK_PATHS.stroke, scope: "element" as const },
  content: { path: STACK_PATHS.content, scope: "element" as const },
};

/** The blend modes the schema row lists, labelled. */
export type BlendOption = { value: string; label: string };

function ParamControl({
  spec,
  entry,
  disabled,
  onSet,
  strings,
}: {
  spec: ParamSpec;
  entry: StackEntry;
  disabled: boolean;
  onSet: (key: keyof StackEntry, value: unknown) => void;
  strings: Strings;
}) {
  const label = strings.t(
    (M as Record<string, string>)[spec.label] ?? spec.label,
  );
  const current = entry[spec.key];
  let control;
  switch (spec.control) {
    case "number":
      control = (
        <NumberInput
          value={typeof current === "number" ? current : null}
          min={spec.min}
          max={spec.max}
          precision={1}
          suffix={spec.suffix}
          disabled={disabled}
          onChange={() => {}}
          onCommit={(v) => onSet(spec.key, v)}
          aria-label={label}
        />
      );
      break;
    case "color":
    case "gradient":
      control = (
        <ColorPicker
          value={typeof current === "string" ? current : null}
          disabled={disabled}
          onCommit={(v) => onSet(spec.key, v)}
        />
      );
      break;
    case "position":
      control = (
        <KitSelect
          aria-label={label}
          value={typeof current === "string" ? current : "Outside"}
          disabled={disabled}
          onChange={(e) => onSet(spec.key, e.target.value)}
        >
          <option value="Outside">{strings.t(M.outside)}</option>
          <option value="Inside">{strings.t(M.inside)}</option>
          <option value="Center">{strings.t(M.center)}</option>
        </KitSelect>
      );
      break;
    case "bool":
      control = (
        <TogglePill
          checked={current === true}
          disabled={disabled}
          onToggle={(next) => onSet(spec.key, next)}
          label={label}
        />
      );
      break;
  }
  return (
    <div
      className="grid grid-cols-[84px_1fr] items-center gap-2"
      data-effect-param={spec.key}
    >
      <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
        {label}
      </span>
      {control}
    </div>
  );
}

function RowButton({
  label,
  glyph,
  hook,
  disabled,
  onClick,
}: {
  label: string;
  glyph: string;
  hook: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-effect-stack-action={hook}
      disabled={disabled}
      onClick={onClick}
      className="h-[20px] w-[20px] rounded text-xs disabled:opacity-40"
      style={{ color: "var(--pg-muted-fg)" }}
    >
      {glyph}
    </button>
  );
}

function StackRow({
  entry,
  index,
  count,
  disabled,
  blendModes,
  write,
  strings,
}: {
  entry: StackEntry;
  index: number;
  count: number;
  disabled: boolean;
  blendModes: readonly BlendOption[];
  write: (next: (entries: StackEntry[]) => StackEntry[]) => void;
  strings: Strings;
}) {
  const [open, setOpen] = useState(false);
  const name = effectName(strings, entry.kind);
  const own = !isIndesign(entry.kind);
  return (
    <div
      data-effect-stack-row={entry.kind}
      data-effect-stack-index={index}
      data-enabled={entry.enabled ? "true" : "false"}
    >
      <div className="flex items-center gap-[6px] py-[4px]">
        <TogglePill
          checked={entry.enabled}
          disabled={disabled}
          onToggle={(on) => write((e) => setEnabled(e, index, on))}
          testId={`stack:${entry.kind}`}
          label={name}
        />
        <button
          type="button"
          className="flex-1 text-left text-xs"
          aria-expanded={open}
          data-effect-stack-open=""
          onClick={() => setOpen(!open)}
          style={{
            color: entry.enabled ? "var(--pg-fg)" : "var(--pg-muted-fg)",
          }}
        >
          {name}
        </button>
        <RowButton
          label={strings.t(M.moveUp)}
          glyph="↑"
          hook="up"
          disabled={disabled || index === 0}
          onClick={() => write((e) => move(e, index, -1))}
        />
        <RowButton
          label={strings.t(M.moveDown)}
          glyph="↓"
          hook="down"
          disabled={disabled || index === count - 1}
          onClick={() => write((e) => move(e, index, 1))}
        />
        <RowButton
          label={strings.t(M.remove)}
          glyph="×"
          hook="remove"
          disabled={disabled}
          onClick={() => write((e) => remove(e, index))}
        />
      </div>
      {open && (
        <div
          className="mb-[6px] ml-1 flex flex-col gap-[6px] py-1 pl-3"
          data-effect-stack-fields={entry.kind}
          style={{ borderLeft: "2px solid var(--pg-primary-soft)" }}
        >
          {own ? (
            <>
              <div className="grid grid-cols-[84px_1fr] items-center gap-2">
                <span
                  className="text-xs"
                  style={{ color: "var(--pg-muted-fg)" }}
                >
                  {strings.t(M.blend)}
                </span>
                <KitSelect
                  aria-label={strings.t(M.blend)}
                  value={entry.blendMode || "Normal"}
                  disabled={disabled}
                  data-effect-param="blendMode"
                  onChange={(ev) =>
                    write((e) =>
                      setParam(e, index, "blendMode", ev.target.value),
                    )
                  }
                >
                  {blendModes.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </KitSelect>
              </div>
              <ParamControl
                spec={{
                  key: "opacityPct",
                  label: "opacity",
                  control: "number",
                  suffix: "%",
                  min: 0,
                  max: 100,
                }}
                entry={{ ...entry, opacityPct: entry.opacityPct ?? 100 }}
                disabled={disabled}
                onSet={(k, v) =>
                  write((e) => setParam(e, index, k, v as never))
                }
                strings={strings}
              />
              {(PARAMS[entry.kind] ?? []).map((spec) => (
                <ParamControl
                  key={spec.key}
                  spec={spec}
                  entry={entry}
                  disabled={disabled}
                  onSet={(k, v) =>
                    write((e) => setParam(e, index, k, v as never))
                  }
                  strings={strings}
                />
              ))}
            </>
          ) : (
            <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
              {strings.t(M.indesignParams)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The stack of `target` on the selection. */
export function EffectStackSection({
  target,
  blendModes,
}: {
  target: StackTarget;
  blendModes: readonly BlendOption[];
}) {
  const strings = useStrings();
  const fields = useObjectBindings(STACK_BINDINGS);
  const field: ObjectField = fields[target];
  const entries =
    field.state.state === "value" ? entriesOf(field.state.value) : null;
  const mixed = field.state.state === "mixed";
  const disabled = field.commit == null || entries == null;
  const write = (next: (e: StackEntry[]) => StackEntry[]) => {
    if (!entries || !field.commit) return;
    void field.commit(next([...entries]));
  };
  if (field.state.state === "absent" || field.state.state === "none")
    return null;
  return (
    <ObjectFieldFrame field={field} className="relative flex flex-col">
      <div
        className="flex flex-col"
        data-effect-stack={target}
        data-effect-stack-count={entries?.length ?? 0}
      >
        <div className="pg-label mb-1">{strings.t(M.stack)}</div>
        {mixed && (
          <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
            {strings.t(M.mixed)}
          </span>
        )}
        {entries && entries.length === 0 && (
          <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
            {strings.t(M.empty)}
          </span>
        )}
        {entries?.map((entry, i) => (
          <StackRow
            // The stack has no ids; an entry is its kind at its place.
            key={`${i}:${entry.kind}`}
            entry={entry}
            index={i}
            count={entries.length}
            disabled={disabled}
            blendModes={blendModes}
            write={write}
            strings={strings}
          />
        ))}
        <KitSelect
          aria-label={strings.t(M.add)}
          value=""
          disabled={disabled}
          data-effect-stack-add=""
          onChange={(ev) => {
            const kind = ev.target.value as EffectKind;
            if (kind) write((e) => add(e, kind));
          }}
        >
          <option value="">{strings.t(M.add)}</option>
          {(entries ? addable(entries, target) : []).map((k) => (
            <option key={k} value={k}>
              {effectName(strings, k)}
            </option>
          ))}
        </KitSelect>
      </div>
    </ObjectFieldFrame>
  );
}
