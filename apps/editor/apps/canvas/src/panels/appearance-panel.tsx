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

// Editor ADR 309 — the Appearance panel (Illustrator's): what a page item
// looks like, as one list from back to front of what draws it — its
// stroke, its fill, the effects of the whole object in the order they
// apply, and its opacity. A paint row opens to the effects of its own
// transparency target (the fill's and the stroke's stacks, InDesign's
// effects only, engine ADR 1008); the effects row is the object stack,
// with every kind core describes (the Add menu and Object ▸ Effects).
//
// The rows are SECTIONS (`APPEARANCE_SECTIONS`), each one component over
// the selection's object-model fields. Today an item has one fill and one
// stroke, so there is one row of each. Native multiple fills and strokes
// (engine ADR 1009, plan WP3.3) arrive as their own paint-layer rows
// through this list — a section reading the appearance rows the engine
// adds — without changing the rows that are here.

import { useState, type ComponentType, type ReactNode } from "react";

import {
  ObjectFieldFrame,
  useObjectBindings,
  useSelection,
  type ObjectField,
} from "@paged-media/shell";
import { ColorPicker, NumberInput } from "@paged-media/ui";
import { defineMessages, useStrings } from "@paged-media/strings";

import { EffectStackSection } from "./effect-stack-section";
import { schemaBlendModes } from "./effects-panel";
import { entriesOf } from "./effect-stack";

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
});

const PAINT = {
  fillColor: { path: "frameFillColor", scope: "element" as const },
  strokeColor: { path: "frameStrokeColor", scope: "element" as const },
  strokeWeight: { path: "frameStrokeWeight", scope: "element" as const },
  fillStack: { path: "frameFillEffectStack", scope: "element" as const },
  strokeStack: { path: "frameStrokeEffectStack", scope: "element" as const },
  opacity: { path: "frameOpacity", scope: "element" as const },
  blend: { path: "frameBlendMode", scope: "element" as const },
};

type Fields = Record<keyof typeof PAINT, ObjectField>;

const raw = (f: ObjectField): unknown =>
  f.state.state === "value" ? f.state.value : undefined;

/** How many effects a target's stack holds (the row's count badge). */
const stackCount = (f: ObjectField) => entriesOf(raw(f))?.length ?? 0;

function Section({
  id,
  title,
  meta,
  children,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className="-mx-3 flex flex-col gap-[6px] border-t border-input px-3 py-2"
      data-appearance-section={id}
    >
      <div className="flex items-center justify-between">
        <span className="pg-label">{title}</span>
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

/** One paint row (the stroke or the fill): its colour (and weight), and
 *  a disclosure to its own target's effect stack. */
function PaintSection({
  id,
  title,
  color,
  weight,
  stack,
}: {
  id: "stroke" | "fill";
  title: string;
  color: ObjectField;
  weight?: ObjectField;
  stack: ObjectField;
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
      meta={
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

function StrokeSection({ fields }: { fields: Fields }) {
  const strings = useStrings();
  return (
    <PaintSection
      id="stroke"
      title={strings.t(M.stroke)}
      color={fields.strokeColor}
      weight={fields.strokeWeight}
      stack={fields.strokeStack}
    />
  );
}

function FillSection({ fields }: { fields: Fields }) {
  const strings = useStrings();
  return (
    <PaintSection
      id="fill"
      title={strings.t(M.fill)}
      color={fields.fillColor}
      stack={fields.fillStack}
    />
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

/** The panel's rows, top to bottom as Illustrator lists them (front to
 *  back): paint layers, the object's effects, its opacity. A section for
 *  the engine's multiple fills and strokes joins this list. */
export const APPEARANCE_SECTIONS: readonly {
  id: string;
  component: ComponentType<{ fields: Fields }>;
}[] = [
  { id: "stroke", component: StrokeSection },
  { id: "fill", component: FillSection },
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
    </div>
  );
}
