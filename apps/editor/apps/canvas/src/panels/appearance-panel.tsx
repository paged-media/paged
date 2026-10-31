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

// Editor ADR 309, amended by editor ADR 312 — the Appearance panel
// (Illustrator's): what a page item looks like, as one list from front to
// back of what draws it — every fill and stroke of its appearance, the
// effects of the whole object in the order they apply, and its opacity.
//
// The paint rows are the item's native appearance (engine ADR 1043,
// `frameAppearance`): a bottom-to-top list of fill and stroke layers in
// which two placeholders stand for the item's own fill and stroke. The
// panel lists it front-most first; the placeholders are the Stroke and
// Fill rows (their colour and weight on the frame's own paths, and a
// disclosure to their own target's effects, InDesign's only, engine ADR
// 1008), every other layer a row of its own (switch, colour, opacity,
// blend mode, a stroke's weight; move, duplicate, delete). Add new fill,
// Add new stroke and Clear appearance close the list. Every gesture is a
// pure function over the list (`appearance-layers.ts`) and one write of
// it, so one undo step. An item without an appearance row (a line, a
// group) shows its one stroke and one fill as before.
//
// The rows are SECTIONS (`APPEARANCE_SECTIONS`), each one component over
// the selection's object-model fields; the paint layers are one section
// whose rows are the layers.

import { useState, type ComponentType, type ReactNode } from "react";

import {
  Icon,
  ObjectFieldFrame,
  useObjectBindings,
  useSelection,
  type ObjectField,
} from "@paged-media/shell";
import { ColorPicker, KitSelect, NumberInput } from "@paged-media/ui";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

import { EffectStackSection, type BlendOption } from "./effect-stack-section";
import { schemaBlendModes } from "./effects-panel";
import { entriesOf } from "./effect-stack";
import {
  addFill,
  addStroke,
  clear,
  duplicate,
  isEnabled,
  isFillKind,
  isPlaceholder,
  layersOf,
  move,
  remove,
  setEnabled,
  setField,
  viewOrder,
  type FrameSeed,
  type LayerField,
  type PaintLayer,
} from "./appearance-layers";

const M = defineMessages("app.appearancePanel", {
  stroke: "Stroke",
  fill: "Fill",
  effects: "Effects",
  opacity: "Opacity",
  weight: "Weight",
  color: "Color",
  nothing: "Select an item to see its appearance.",
  show: "Show its effects",
  hide: "Hide its effects",
  blend: "Blend",
  visible: "Visible",
  moveUp: "Move up",
  moveDown: "Move down",
  duplicate: "Duplicate",
  remove: "Delete",
  addFill: "Add new fill",
  addStroke: "Add new stroke",
  clear: "Clear appearance",
  mixed: "The selection's appearances differ",
});

const PAINT = {
  fillColor: { path: "frameFillColor", scope: "element" as const },
  strokeColor: { path: "frameStrokeColor", scope: "element" as const },
  strokeWeight: { path: "frameStrokeWeight", scope: "element" as const },
  fillStack: { path: "frameFillEffectStack", scope: "element" as const },
  strokeStack: { path: "frameStrokeEffectStack", scope: "element" as const },
  opacity: { path: "frameOpacity", scope: "element" as const },
  blend: { path: "frameBlendMode", scope: "element" as const },
  appearance: { path: "frameAppearance", scope: "element" as const },
};

type Fields = Record<keyof typeof PAINT, ObjectField>;

const raw = (f: ObjectField): unknown =>
  f.state.state === "value" ? f.state.value : undefined;

/** How many effects a target's stack holds (the row's count badge). */
const stackCount = (f: ObjectField) => entriesOf(raw(f))?.length ?? 0;

/** The selection's appearance: the layers read (`null` when the items'
 *  lists differ or the read is not one), whether the item has the row at
 *  all, and the one write a gesture makes. */
function appearanceOf(fields: Fields) {
  const f = fields.appearance;
  const present = f.state.state !== "absent" && f.state.state !== "none";
  const layers = layersOf(raw(f));
  const disabled = f.commit == null || layers == null;
  const write = (next: (l: PaintLayer[]) => PaintLayer[]) => {
    if (!layers || !f.commit) return;
    void f.commit(next([...layers]));
  };
  const w = raw(fields.strokeWeight);
  const seed: FrameSeed = {
    fillColor:
      typeof raw(fields.fillColor) === "string"
        ? (raw(fields.fillColor) as string)
        : null,
    strokeColor:
      typeof raw(fields.strokeColor) === "string"
        ? (raw(fields.strokeColor) as string)
        : null,
    strokeWeight: typeof w === "number" ? w : null,
  };
  return {
    present,
    mixed: f.state.state === "mixed",
    layers,
    disabled,
    write,
    seed,
  };
}

function Section({
  id,
  title,
  meta,
  layer,
  children,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  /** The row's layer in the bottom-to-top appearance list. */
  layer?: { index: number; kind: string; enabled: boolean };
  children?: ReactNode;
}) {
  return (
    <div
      className="-mx-3 flex flex-col gap-[6px] border-t border-input px-3 py-2"
      data-appearance-section={id}
      data-appearance-layer={layer?.index}
      data-appearance-kind={layer?.kind}
      data-enabled={layer ? (layer.enabled ? "true" : "false") : undefined}
    >
      <div className="flex items-center justify-between gap-1">
        <span
          className="pg-label"
          style={layer && !layer.enabled ? { color: "var(--pg-muted-fg)" } : {}}
        >
          {title}
        </span>
        {meta}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center gap-2">
      <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function LayerButton({
  label,
  hook,
  disabled,
  onClick,
  pressed,
  children,
}: {
  label: string;
  hook: string;
  disabled: boolean;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-appearance-action={hook}
      disabled={disabled}
      onClick={onClick}
      className="flex h-[20px] w-[20px] items-center justify-center rounded text-xs disabled:opacity-40"
      style={{ color: "var(--pg-muted-fg)" }}
    >
      {children}
    </button>
  );
}

type Appearance = ReturnType<typeof appearanceOf>;

/** A layer row's switch, move-up / move-down, duplicate and delete. The
 *  panel lists front-most first, so "up" is one place towards the front
 *  (+1 in the bottom-to-top list). */
function LayerControls({
  layer,
  index,
  count,
  appearance: a,
  strings,
}: {
  layer: PaintLayer;
  index: number;
  count: number;
  appearance: Appearance;
  strings: Strings;
}) {
  const on = isEnabled(layer);
  return (
    <div className="flex items-center gap-[2px]">
      <LayerButton
        label={strings.t(M.visible)}
        hook="toggle"
        pressed={on}
        disabled={a.disabled}
        onClick={() => a.write((l) => setEnabled(l, index, !on))}
      >
        <Icon name={on ? "ui-eye" : "ui-eye-off"} size={14} />
      </LayerButton>
      <LayerButton
        label={strings.t(M.moveUp)}
        hook="up"
        disabled={a.disabled || index === count - 1}
        onClick={() => a.write((l) => move(l, index, 1))}
      >
        ↑
      </LayerButton>
      <LayerButton
        label={strings.t(M.moveDown)}
        hook="down"
        disabled={a.disabled || index === 0}
        onClick={() => a.write((l) => move(l, index, -1))}
      >
        ↓
      </LayerButton>
      <LayerButton
        label={strings.t(M.duplicate)}
        hook="duplicate"
        disabled={a.disabled}
        onClick={() => a.write((l) => duplicate(l, index, a.seed))}
      >
        <Icon name="ui-plus" size={12} />
      </LayerButton>
      <LayerButton
        label={strings.t(M.remove)}
        hook="remove"
        disabled={a.disabled || isPlaceholder(layer)}
        onClick={() => a.write((l) => remove(l, index))}
      >
        ×
      </LayerButton>
    </div>
  );
}

/** One of the item's own paint rows (the stroke or the fill): its colour
 *  (and weight) on the frame's own paths, and a disclosure to its own
 *  target's effect stack. In an appearance it carries the layer controls
 *  of its placeholder. */
function PaintSection({
  id,
  title,
  color,
  weight,
  stack,
  controls,
  layer,
}: {
  id: "stroke" | "fill";
  title: string;
  color: ObjectField;
  weight?: ObjectField;
  stack: ObjectField;
  controls?: ReactNode;
  layer?: { index: number; kind: string; enabled: boolean };
}) {
  const strings = useStrings();
  const [open, setOpen] = useState(false);
  const count = stackCount(stack);
  const current = raw(color);
  const w = weight ? raw(weight) : undefined;
  return (
    <Section
      id={id}
      title={title}
      layer={layer}
      meta={
        <div className="flex items-center gap-1">
          {controls}
          <button
            type="button"
            className="text-xs"
            aria-expanded={open}
            data-appearance-target-toggle={id}
            title={strings.t(open ? M.hide : M.show)}
            onClick={() => setOpen(!open)}
            style={{ color: "var(--pg-muted-fg)" }}
          >
            fx {count}
          </button>
        </div>
      }
    >
      <ObjectFieldFrame field={color} className="relative">
        <Row label={strings.t(M.color)}>
          <ColorPicker
            value={typeof current === "string" && current ? current : null}
            disabled={color.commit == null}
            onCommit={(v) => void color.commit?.(v)}
          />
        </Row>
      </ObjectFieldFrame>
      {weight && (
        <ObjectFieldFrame field={weight} className="relative">
          <Row label={strings.t(M.weight)}>
            <NumberInput
              value={typeof w === "number" ? w : null}
              min={0}
              precision={2}
              suffix="pt"
              disabled={weight.commit == null}
              onChange={() => {}}
              onCommit={(v) => void weight.commit?.(v)}
              aria-label={strings.t(M.weight)}
            />
          </Row>
        </ObjectFieldFrame>
      )}
      {open && (
        <div
          className="ml-1 pl-3"
          style={{ borderLeft: "2px solid var(--pg-primary-soft)" }}
          data-appearance-target-stack={id}
        >
          <EffectStackSection
            target={id}
            blendModes={schemaBlendModes(strings, null)}
          />
        </div>
      )}
    </Section>
  );
}

function StrokeSection({
  fields,
  controls,
  layer,
}: {
  fields: Fields;
  controls?: ReactNode;
  layer?: { index: number; kind: string; enabled: boolean };
}) {
  const strings = useStrings();
  return (
    <PaintSection
      id="stroke"
      title={strings.t(M.stroke)}
      color={fields.strokeColor}
      weight={fields.strokeWeight}
      stack={fields.strokeStack}
      controls={controls}
      layer={layer}
    />
  );
}

function FillSection({
  fields,
  controls,
  layer,
}: {
  fields: Fields;
  controls?: ReactNode;
  layer?: { index: number; kind: string; enabled: boolean };
}) {
  const strings = useStrings();
  return (
    <PaintSection
      id="fill"
      title={strings.t(M.fill)}
      color={fields.fillColor}
      stack={fields.fillStack}
      controls={controls}
      layer={layer}
    />
  );
}

/** A fill or stroke layer of the appearance's own: its colour, opacity,
 *  blend mode and, for a stroke, its weight — each one write of the list. */
function LayerSection({
  layer,
  index,
  count,
  appearance: a,
  blendModes,
}: {
  layer: PaintLayer;
  index: number;
  count: number;
  appearance: Appearance;
  blendModes: readonly BlendOption[];
}) {
  const strings = useStrings();
  const fill = isFillKind(layer);
  const set = (field: LayerField, value: unknown) =>
    a.write((l) => setField(l, index, field, value));
  return (
    <Section
      id="layer"
      title={strings.t(fill ? M.fill : M.stroke)}
      layer={{ index, kind: layer.kind, enabled: isEnabled(layer) }}
      meta={
        <LayerControls
          layer={layer}
          index={index}
          count={count}
          appearance={a}
          strings={strings}
        />
      }
    >
      <Row label={strings.t(M.color)}>
        <ColorPicker
          value={typeof layer.color === "string" ? layer.color : null}
          disabled={a.disabled}
          onCommit={(v) => set("color", v)}
        />
      </Row>
      {!fill && (
        <Row label={strings.t(M.weight)}>
          <NumberInput
            value={typeof layer.weight === "number" ? layer.weight : 1}
            min={0}
            precision={2}
            suffix="pt"
            disabled={a.disabled}
            onChange={() => {}}
            onCommit={(v) => set("weight", v)}
            aria-label={strings.t(M.weight)}
          />
        </Row>
      )}
      <Row label={strings.t(M.opacity)}>
        <NumberInput
          value={typeof layer.opacityPct === "number" ? layer.opacityPct : 100}
          min={0}
          max={100}
          precision={0}
          suffix="%"
          disabled={a.disabled}
          onChange={() => {}}
          onCommit={(v) => set("opacityPct", v)}
          aria-label={strings.t(M.opacity)}
        />
      </Row>
      <Row label={strings.t(M.blend)}>
        <KitSelect
          aria-label={strings.t(M.blend)}
          value={layer.blendMode || "Normal"}
          disabled={a.disabled}
          onChange={(ev) => set("blendMode", ev.target.value)}
        >
          {blendModes.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </KitSelect>
      </Row>
    </Section>
  );
}

/** The paint layers, front-most first: the item's own stroke and fill as
 *  the Stroke and Fill rows wherever its appearance puts them, every other
 *  layer a row of its own. */
function PaintLayersSection({ fields }: { fields: Fields }) {
  const strings = useStrings();
  const a = appearanceOf(fields);
  if (!a.present)
    return (
      <>
        <StrokeSection fields={fields} />
        <FillSection fields={fields} />
      </>
    );
  const rows = viewOrder(a.layers ?? []);
  const blendModes = schemaBlendModes(strings, fields.blend.row);
  return (
    <ObjectFieldFrame field={fields.appearance} className="relative">
      <div className="flex flex-col" data-appearance-layers={rows.length}>
        {a.mixed && (
          <span
            className="py-1 text-xs"
            style={{ color: "var(--pg-muted-fg)" }}
          >
            {strings.t(M.mixed)}
          </span>
        )}
        {rows.map(({ layer, index }) => {
          const place = {
            index,
            kind: layer.kind,
            enabled: isEnabled(layer),
          };
          const controls = (
            <LayerControls
              layer={layer}
              index={index}
              count={rows.length}
              appearance={a}
              strings={strings}
            />
          );
          // The list has no ids; a layer is its kind at its place.
          const key = `${index}:${layer.kind}`;
          if (layer.kind === "frameStroke")
            return (
              <StrokeSection
                key={key}
                fields={fields}
                controls={controls}
                layer={place}
              />
            );
          if (layer.kind === "frameFill")
            return (
              <FillSection
                key={key}
                fields={fields}
                controls={controls}
                layer={place}
              />
            );
          return (
            <LayerSection
              key={key}
              layer={layer}
              index={index}
              count={rows.length}
              appearance={a}
              blendModes={blendModes}
            />
          );
        })}
      </div>
    </ObjectFieldFrame>
  );
}

/** The object's effects, in the order they apply. */
function EffectsSection({ fields }: { fields: Fields }) {
  const strings = useStrings();
  return (
    <Section id="effects" title={strings.t(M.effects)}>
      <EffectStackSection
        target="object"
        blendModes={schemaBlendModes(strings, fields.blend.row)}
      />
    </Section>
  );
}

function OpacitySection({ fields }: { fields: Fields }) {
  const strings = useStrings();
  const o = raw(fields.opacity);
  return (
    <Section id="opacity" title={strings.t(M.opacity)}>
      <ObjectFieldFrame field={fields.opacity} className="relative">
        <NumberInput
          value={
            fields.opacity.state.state === "value"
              ? typeof o === "number"
                ? o
                : 100
              : null
          }
          min={0}
          max={100}
          precision={0}
          suffix="%"
          disabled={fields.opacity.commit == null}
          onChange={() => {}}
          onCommit={(v) => void fields.opacity.commit?.(v)}
          aria-label={strings.t(M.opacity)}
        />
      </ObjectFieldFrame>
    </Section>
  );
}

/** Illustrator's panel foot: Add New Stroke, Add New Fill, Clear
 *  Appearance — each one write of the list. */
function AppearanceActions({ fields }: { fields: Fields }) {
  const strings = useStrings();
  const a = appearanceOf(fields);
  if (!a.present) return null;
  const action = (
    hook: string,
    label: string,
    next: (l: PaintLayer[]) => PaintLayer[],
  ) => (
    <button
      type="button"
      className="h-[24px] rounded border border-input px-2 text-xs disabled:opacity-40"
      data-appearance-action={hook}
      disabled={a.disabled}
      onClick={() => a.write(next)}
    >
      {label}
    </button>
  );
  return (
    <div
      className="-mx-3 flex flex-wrap gap-1 border-t border-input px-3 pt-2"
      data-appearance-actions=""
    >
      {action("add-stroke", strings.t(M.addStroke), (l) =>
        addStroke(l, a.seed),
      )}
      {action("add-fill", strings.t(M.addFill), (l) => addFill(l, a.seed))}
      {action("clear", strings.t(M.clear), () => clear())}
    </div>
  );
}

/** The panel's rows, top to bottom as Illustrator lists them (front to
 *  back): the paint layers (one section whose rows are the item's fills
 *  and strokes, editor ADR 312), the object's effects, its opacity. */
export const APPEARANCE_SECTIONS: readonly {
  id: string;
  component: ComponentType<{ fields: Fields }>;
}[] = [
  { id: "paint", component: PaintLayersSection },
  { id: "effects", component: EffectsSection },
  { id: "opacity", component: OpacitySection },
];

export function AppearancePanel() {
  const strings = useStrings();
  const { elementSelection } = useSelection();
  const fields = useObjectBindings(PAINT);
  if (elementSelection.length === 0) {
    return (
      <div className="p-3" data-appearance-panel="empty">
        <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
          {strings.t(M.nothing)}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col px-3 pb-3" data-appearance-panel="ready">
      {APPEARANCE_SECTIONS.map(({ id, component: S }) => (
        <S key={id} fields={fields} />
      ))}
      <AppearanceActions fields={fields} />
    </div>
  );
}
