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

// Engine ADR 1008, editor ADR 309 — the stack section the Effects and
// Appearance panels share: the effects of the picked transparency target
// in the order they apply, each with its switch, move-up / move-down and
// remove; an Add menu grouped as the Effect menu is, with every kind the
// target takes; and, for a stack-only effect, its blend mode, opacity and
// parameters. The kinds, their groups and their parameter forms are core's
// catalog (`effect-stack.ts`); a parameter's label and an enum member are
// translated here when the catalogue knows them and shown as core names
// them otherwise. InDesign's own effects keep their parameters in the
// Effects panel's disclosures (their per-field paths). Every gesture is
// one write of the whole stack, so one undo step.

import { useState, type ReactNode } from "react";

import {
  ObjectFieldFrame,
  TogglePill,
  useObjectBindings,
  type ObjectField,
} from "@paged-media/shell";
import { ColorPicker, KitSelect, NumberInput } from "@paged-media/ui";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";
import type { EffectParamDescriptor } from "@paged-media/plugin-api";

import {
  STACK_PATHS,
  add,
  addable,
  controlOf,
  effectMenu,
  entriesOf,
  isIndesign,
  kindOf,
  move,
  paramsOf,
  remove,
  setEnabled,
  setParam,
  suffixOf,
  type EffectKind,
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
  outlineStroke: "Stroke (layer style)",
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

/** The Effect menu's groups (core's `effectCategories`), in the add menu
 *  and the panel; the menu bar shows them through its `menu.*` words. */
const C = defineMessages("app.effectCategory", {
  stylize: "Stylize",
  blur: "Blur",
  noise: "Noise",
  color: "Color",
  distortAndTransform: "Distort and transform",
  path: "Path",
  pathfinder: "Pathfinder",
  warp: "Warp",
  convertToShape: "Convert to shape",
  rasterize: "Rasterize",
});

const known = M as Record<string, string>;

/** The display name of a kind: the catalogue's, else core's title. */
export function effectName(strings: Strings, kind: EffectKind): string {
  const key = known[kind];
  return key ? strings.t(key) : (kindOf(kind)?.title ?? kind);
}

/** The display name of an Effect menu group. */
export function categoryName(strings: Strings, category: string): string {
  const key = (C as Record<string, string>)[category];
  return key ? strings.t(key) : category;
}

/** A parameter's label: the catalogue's word for its field, with the unit
 *  suffix dropped (`radiusPt` → Radius), else core's title. */
function paramLabel(strings: Strings, p: EffectParamDescriptor): string {
  const key = known[p.field] ?? known[p.field.replace(/(Pt|Pct|Deg)$/, "")];
  return key ? strings.t(key) : p.title;
}

/** An enum member's word (`Outside`), else the member itself. */
function memberLabel(strings: Strings, member: string): string {
  const key = known[member.charAt(0).toLowerCase() + member.slice(1)];
  return key ? strings.t(key) : member;
}

const STACK_BINDINGS = {
  object: { path: STACK_PATHS.object, scope: "element" as const },
  fill: { path: STACK_PATHS.fill, scope: "element" as const },
  stroke: { path: STACK_PATHS.stroke, scope: "element" as const },
  content: { path: STACK_PATHS.content, scope: "element" as const },
};

/** The blend modes the schema row lists, labelled. */
export type BlendOption = { value: string; label: string };

function ParamRow({
  label,
  field,
  children,
}: {
  label: string;
  field: string;
  children: ReactNode;
}) {
  return (
    <div
      className="grid grid-cols-[84px_1fr] items-center gap-2"
      data-effect-param={field}
    >
      <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function ParamControl({
  param,
  entry,
  disabled,
  onSet,
  strings,
}: {
  param: EffectParamDescriptor;
  entry: StackEntry;
  disabled: boolean;
  onSet: (key: string, value: unknown) => void;
  strings: Strings;
}) {
  const label = paramLabel(strings, param);
  const current = entry[param.field] ?? param.default ?? null;
  let control;
  switch (controlOf(param)) {
    case "number":
      control = (
        <NumberInput
          value={typeof current === "number" ? current : null}
          min={param.range?.min}
          max={param.range?.max}
          precision={1}
          suffix={suffixOf(param)}
          disabled={disabled}
          onChange={() => {}}
          onCommit={(v) => onSet(param.field, v)}
          aria-label={label}
        />
      );
      break;
    case "color":
    case "swatch":
      control = (
        <ColorPicker
          value={typeof current === "string" ? current : null}
          disabled={disabled}
          onCommit={(v) => onSet(param.field, v)}
        />
      );
      break;
    case "enum": {
      const members =
        param.type.kind === "enum" ? param.type.members : ([] as string[]);
      control = (
        <KitSelect
          aria-label={label}
          value={typeof current === "string" ? current : (members[0] ?? "")}
          disabled={disabled}
          onChange={(e) => onSet(param.field, e.target.value)}
        >
          {members.map((m) => (
            <option key={m} value={m}>
              {memberLabel(strings, m)}
            </option>
          ))}
        </KitSelect>
      );
      break;
    }
    case "bool":
      control = (
        <TogglePill
          checked={current === true}
          disabled={disabled}
          onToggle={(next) => onSet(param.field, next)}
          label={label}
        />
      );
      break;
  }
  return (
    <ParamRow label={label} field={param.field}>
      {control}
    </ParamRow>
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

/** A stack-only entry's own fields: blend, opacity, then core's params. */
function OwnFields({
  entry,
  index,
  disabled,
  blendModes,
  write,
  strings,
}: {
  entry: StackEntry;
  index: number;
  disabled: boolean;
  blendModes: readonly BlendOption[];
  write: (next: (entries: StackEntry[]) => StackEntry[]) => void;
  strings: Strings;
}) {
  const opacity = entry.opacityPct ?? 100;
  return (
    <>
      {kindOf(entry.kind)?.blend !== false && (
        <>
          <ParamRow label={strings.t(M.blend)} field="blendMode">
            <KitSelect
              aria-label={strings.t(M.blend)}
              value={entry.blendMode || "Normal"}
              disabled={disabled}
              onChange={(ev) =>
                write((e) => setParam(e, index, "blendMode", ev.target.value))
              }
            >
              {blendModes.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </KitSelect>
          </ParamRow>
          <ParamRow label={strings.t(M.opacity)} field="opacityPct">
            <NumberInput
              value={opacity}
              min={0}
              max={100}
              precision={1}
              suffix="%"
              disabled={disabled}
              onChange={() => {}}
              onCommit={(v) =>
                write((e) => setParam(e, index, "opacityPct", v))
              }
              aria-label={strings.t(M.opacity)}
            />
          </ParamRow>
        </>
      )}
      {paramsOf(entry.kind).map((param) => (
        <ParamControl
          key={param.field}
          param={param}
          entry={entry}
          disabled={disabled}
          onSet={(k, v) => write((e) => setParam(e, index, k, v))}
          strings={strings}
        />
      ))}
    </>
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
          {isIndesign(entry.kind) ? (
            <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
              {strings.t(M.indesignParams)}
            </span>
          ) : (
            <OwnFields
              entry={entry}
              index={index}
              disabled={disabled}
              blendModes={blendModes}
              write={write}
              strings={strings}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The Add menu: the kinds the target takes, grouped as the Effect menu. */
function AddMenu({
  entries,
  target,
  disabled,
  onAdd,
  strings,
}: {
  entries: readonly StackEntry[] | null;
  target: StackTarget;
  disabled: boolean;
  onAdd: (kind: EffectKind) => void;
  strings: Strings;
}) {
  const offered = new Set(entries ? addable(entries, target) : []);
  return (
    <KitSelect
      aria-label={strings.t(M.add)}
      value=""
      disabled={disabled}
      data-effect-stack-add=""
      onChange={(ev) => {
        const kind = ev.target.value;
        if (kind) onAdd(kind);
      }}
    >
      <option value="">{strings.t(M.add)}</option>
      {effectMenu().map((group) => {
        const kinds = group.kinds.filter((k) => offered.has(k.kind));
        if (kinds.length === 0) return null;
        return (
          <optgroup
            key={group.category}
            label={categoryName(strings, group.category)}
            data-effect-category={group.category}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {effectName(strings, k.kind)}
              </option>
            ))}
          </optgroup>
        );
      })}
    </KitSelect>
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
        <AddMenu
          entries={entries}
          target={target}
          disabled={disabled}
          onAdd={(kind) => write((e) => add(e, kind))}
          strings={strings}
        />
      </div>
    </ObjectFieldFrame>
  );
}
