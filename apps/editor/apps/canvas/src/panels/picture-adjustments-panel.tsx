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

// Picture adjustments (paged.picture-adjustments) — quick picture fixes on
// a placed image, in any module, without opening the image editor (engine
// ADR 1037). It edits the image frame's filter stack, `frameImageAdjustments`:
// an ordered list of ops (exposure, brightness/contrast, levels, curves,
// hue/saturation, recolor, duotone, black & white, sharpen, blur,
// posterize, threshold, invert) the engine evaluates when it draws and
// exports the picture.
//
//   [Add adjustment ⌄] [Preset ⌄]            appends to the stack
//   ── one row per op ──  name   ↑ ↓ ✕       reorder / remove
//      its fields (number, colour, curve points)
//   [Reset]  [Open in Image editor]
//
// The stack is ONE property: every change writes the whole list, one
// `host.objects` write, so one undo step (one batch over a
// multi-selection). A field commits on Enter or when it loses focus, not
// on every keystroke. The image module's own panel ("Image adjustments")
// edits pixels; this one never touches them, so it is named "Picture" to
// keep the two apart.
//
// "Open in Image editor" runs the image module's "Adjust image" command by
// id (it ingests the picture and enters its edit context); it is disabled
// when no bundle registered it. Converting the stack into adjustment
// layers needs a door the image module does not offer yet.

import { useState } from "react";

import {
  ObjectFieldFrame,
  useObjectBindings,
  useRegistries,
  useRegistryView,
  useSelection,
  type ObjectField,
} from "@paged-media/shell";
import type { Value } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.pictureAdjustmentsPanel", {
  empty: "No adjustments. The picture is drawn as placed.",
  nothing: "Select an image frame to adjust its picture.",
  mixed: "The selected pictures differ; a change replaces every stack.",
  add: "Add adjustment",
  preset: "Apply preset",
  reset: "Reset",
  openInImageEditor: "Open in Image editor",
  moveUp: "Move up",
  moveDown: "Move down",
  remove: "Remove",
  exposure: "Exposure",
  brightnessContrast: "Brightness/Contrast",
  levels: "Levels",
  curves: "Curves",
  hueSaturation: "Hue/Saturation",
  recolor: "Recolor",
  duotone: "Duotone",
  blackWhite: "Black & White",
  sharpen: "Sharpen",
  blur: "Blur",
  posterize: "Posterize",
  threshold: "Threshold",
  invert: "Invert",
  ev: "Stops",
  brightness: "Brightness",
  contrast: "Contrast",
  inBlack: "Input black",
  inWhite: "Input white",
  gamma: "Midtones",
  outBlack: "Output black",
  outWhite: "Output white",
  points: "Points (in out, …)",
  hue: "Hue",
  saturation: "Saturation",
  lightness: "Lightness",
  shadow: "Shadows",
  highlight: "Highlights",
  reds: "Reds",
  yellows: "Yellows",
  greens: "Greens",
  cyans: "Cyans",
  blues: "Blues",
  magentas: "Magentas",
  amount: "Amount",
  radius: "Radius (px)",
  levelsCount: "Levels",
  level: "Level",
  sepia: "Sepia",
  noir: "Noir",
  vintage: "Vintage",
  pop: "Pop art",
});

/** The image module's "Adjust image" command (modules/image glue). */
export const OPEN_IN_IMAGE_EDITOR_COMMAND_ID =
  "media.paged.image.command.adjustSelected";

/** One op of the stack, as the wire spells it (`paged_model::RasterOp`). */
export type RasterOp = { op: string } & Record<string, unknown>;

type MessageKey = keyof typeof M;

type FieldSpec =
  | {
      key: string;
      label: MessageKey;
      kind: "number";
      min: number;
      max: number;
      step: number;
    }
  | { key: string; label: MessageKey; kind: "color" }
  | { key: string; label: MessageKey; kind: "points" };

const num = (
  key: string,
  label: MessageKey,
  min: number,
  max: number,
  step: number,
): FieldSpec => ({ key, label, kind: "number", min, max, step });

/** Every op the panel adds: its name, a starting value and its fields. */
export const OPS: ReadonlyArray<{
  op: string;
  label: MessageKey;
  make: () => RasterOp;
  fields: readonly FieldSpec[];
}> = [
  {
    op: "exposure",
    label: "exposure",
    make: () => ({ op: "exposure", ev: 0.5 }),
    fields: [num("ev", "ev", -5, 5, 0.1)],
  },
  {
    op: "brightnessContrast",
    label: "brightnessContrast",
    make: () => ({
      op: "brightnessContrast",
      brightness: 0.05,
      contrast: 1.15,
    }),
    fields: [
      num("brightness", "brightness", -1, 1, 0.01),
      num("contrast", "contrast", 0, 3, 0.05),
    ],
  },
  {
    op: "levels",
    label: "levels",
    make: () => ({
      op: "levels",
      inBlack: 0.04,
      inWhite: 0.96,
      gamma: 1,
      outBlack: 0,
      outWhite: 1,
    }),
    fields: [
      num("inBlack", "inBlack", 0, 1, 0.01),
      num("inWhite", "inWhite", 0, 1, 0.01),
      num("gamma", "gamma", 0.1, 5, 0.05),
      num("outBlack", "outBlack", 0, 1, 0.01),
      num("outWhite", "outWhite", 0, 1, 0.01),
    ],
  },
  {
    op: "curves",
    label: "curves",
    make: () => ({
      op: "curves",
      points: [
        [0, 0],
        [0.25, 0.2],
        [0.75, 0.8],
        [1, 1],
      ],
    }),
    fields: [{ key: "points", label: "points", kind: "points" }],
  },
  {
    op: "hueSaturation",
    label: "hueSaturation",
    make: () => ({
      op: "hueSaturation",
      hue: 0,
      saturation: 0.2,
      lightness: 0,
    }),
    fields: [
      num("hue", "hue", -180, 180, 1),
      num("saturation", "saturation", -1, 1, 0.01),
      num("lightness", "lightness", -1, 1, 0.01),
    ],
  },
  {
    op: "recolor",
    label: "recolor",
    make: () => ({ op: "recolor", hue: 30, saturation: 0.5, lightness: 0 }),
    fields: [
      num("hue", "hue", 0, 360, 1),
      num("saturation", "saturation", 0, 1, 0.01),
      num("lightness", "lightness", -1, 1, 0.01),
    ],
  },
  {
    op: "duotone",
    label: "duotone",
    make: () => ({
      op: "duotone",
      shadow: [0.1, 0.12, 0.3],
      highlight: [1, 0.92, 0.75],
    }),
    fields: [
      { key: "shadow", label: "shadow", kind: "color" },
      { key: "highlight", label: "highlight", kind: "color" },
    ],
  },
  {
    op: "blackWhite",
    label: "blackWhite",
    make: () => ({
      op: "blackWhite",
      reds: 0.4,
      yellows: 0.6,
      greens: 0.4,
      cyans: 0.6,
      blues: 0.2,
      magentas: 0.8,
    }),
    fields: (
      ["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const
    ).map((k) => num(k, k, -2, 3, 0.01)),
  },
  {
    op: "sharpen",
    label: "sharpen",
    make: () => ({ op: "sharpen", amount: 0.8, radius: 1 }),
    fields: [
      num("amount", "amount", 0, 5, 0.05),
      num("radius", "radius", 0, 64, 0.1),
    ],
  },
  {
    op: "blur",
    label: "blur",
    make: () => ({ op: "blur", radius: 2 }),
    fields: [num("radius", "radius", 0, 64, 0.1)],
  },
  {
    op: "posterize",
    label: "posterize",
    make: () => ({ op: "posterize", levels: 4 }),
    fields: [num("levels", "levelsCount", 2, 255, 1)],
  },
  {
    op: "threshold",
    label: "threshold",
    make: () => ({ op: "threshold", level: 0.5 }),
    fields: [num("level", "level", 0, 1, 0.01)],
  },
  { op: "invert", label: "invert", make: () => ({ op: "invert" }), fields: [] },
];

/** The artistic presets: ready-made stacks of the ops above, so a preset
 *  stays editable once applied. */
export const PRESETS: ReadonlyArray<{
  id: string;
  label: MessageKey;
  ops: RasterOp[];
}> = [
  {
    id: "sepia",
    label: "sepia",
    ops: [
      { op: "duotone", shadow: [0.17, 0.1, 0.05], highlight: [1, 0.94, 0.8] },
    ],
  },
  {
    id: "noir",
    label: "noir",
    ops: [
      {
        op: "blackWhite",
        reds: 0.4,
        yellows: 0.6,
        greens: 0.4,
        cyans: 0.6,
        blues: 0.2,
        magentas: 0.8,
      },
      {
        op: "curves",
        points: [
          [0, 0],
          [0.25, 0.16],
          [0.75, 0.86],
          [1, 1],
        ],
      },
    ],
  },
  {
    id: "vintage",
    label: "vintage",
    ops: [
      { op: "hueSaturation", hue: 0, saturation: -0.35, lightness: 0 },
      {
        op: "levels",
        inBlack: 0,
        inWhite: 1,
        gamma: 1.1,
        outBlack: 0.08,
        outWhite: 0.94,
      },
      { op: "recolor", hue: 35, saturation: 0.25, lightness: 0 },
    ],
  },
  {
    id: "pop",
    label: "pop",
    ops: [
      { op: "hueSaturation", hue: 0, saturation: 0.5, lightness: 0 },
      { op: "posterize", levels: 5 },
    ],
  },
];

/** The stack a binding reads: its value is the list itself (the object
 *  model wraps it in whichever wire variant its row names). */
function unwrapStack(v: Value | null): RasterOp[] | null {
  const list = (v as { value?: unknown } | null)?.value;
  return Array.isArray(list) ? (list as RasterOp[]) : null;
}

const toHex = (c: unknown): string => {
  const rgb = Array.isArray(c) ? (c as number[]) : [0, 0, 0];
  return (
    "#" +
    rgb
      .slice(0, 3)
      .map((x) =>
        Math.round(Math.min(1, Math.max(0, Number(x) || 0)) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
};

const fromHex = (hex: string): number[] =>
  [1, 3, 5].map(
    (i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000,
  );

const pointsText = (p: unknown): string =>
  Array.isArray(p)
    ? (p as number[][]).map((pt) => `${pt[0]} ${pt[1]}`).join(", ")
    : "";

/** `"0 0, 0.5 0.6, 1 1"` → `[[0, 0], [0.5, 0.6], [1, 1]]`; `null` when a
 *  pair is not two numbers in 0..1. */
export function parsePoints(text: string): number[][] | null {
  const pairs = text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const out: number[][] = [];
  for (const pair of pairs) {
    const nums = pair.split(/\s+/).map(Number);
    if (nums.length !== 2 || nums.some((n) => !(n >= 0 && n <= 1))) {
      return null;
    }
    out.push(nums);
  }
  return out;
}

/** A field that commits on Enter or blur; `key` reseeds it whenever the
 *  stack changes underneath (undo, another selection). */
function CommitInput({
  value,
  label,
  type,
  min,
  max,
  step,
  onCommit,
  disabled,
  dataKey,
}: {
  value: string;
  label: string;
  type: "number" | "text" | "color";
  min?: number;
  max?: number;
  step?: number;
  onCommit: (text: string) => void;
  disabled: boolean;
  dataKey: string;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <label className="flex items-center justify-between gap-2 py-[2px]">
      <span className="text-[11px]" style={{ color: "var(--pg-muted-fg)" }}>
        {label}
      </span>
      <input
        data-adjust-field={dataKey}
        aria-label={label}
        type={type}
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          // A colour well has no Enter: it commits as it is picked.
          if (type === "color" && e.target.value !== value) {
            onCommit(e.target.value);
          }
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="h-[24px] w-[96px] rounded-[6px] border border-input bg-background px-1.5 text-[11px]"
      />
    </label>
  );
}

function OpRow({
  op,
  index,
  count,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  op: RasterOp;
  index: number;
  count: number;
  disabled: boolean;
  onChange: (next: RasterOp) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const strings = useStrings();
  const spec = OPS.find((o) => o.op === op.op);
  const title = spec ? strings.t(M[spec.label]) : op.op;
  const btn =
    "h-[22px] min-w-[22px] rounded-[5px] border border-input px-1 text-[11px] disabled:opacity-45";
  return (
    <div
      className="-mx-3 border-t border-input px-3 py-1.5"
      data-adjust-row={op.op}
      data-adjust-index={index}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: "var(--pg-fg)" }}>
          {title}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            className={btn}
            data-adjust-up=""
            aria-label={strings.t(M.moveUp)}
            title={strings.t(M.moveUp)}
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={btn}
            data-adjust-down=""
            aria-label={strings.t(M.moveDown)}
            title={strings.t(M.moveDown)}
            disabled={disabled || index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={btn}
            data-adjust-remove=""
            aria-label={strings.t(M.remove)}
            title={strings.t(M.remove)}
            disabled={disabled}
            onClick={onRemove}
          >
            ✕
          </button>
        </div>
      </div>
      {(spec?.fields ?? []).map((f) => {
        const label = strings.t(M[f.label]);
        const key = `${index}:${f.key}:${JSON.stringify(op[f.key])}`;
        if (f.kind === "number") {
          return (
            <CommitInput
              key={key}
              dataKey={f.key}
              label={label}
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={String(op[f.key] ?? 0)}
              disabled={disabled}
              onCommit={(text) => {
                const n = Number(text);
                if (!Number.isFinite(n)) return;
                onChange({
                  ...op,
                  [f.key]: Math.min(f.max, Math.max(f.min, n)),
                });
              }}
            />
          );
        }
        if (f.kind === "color") {
          return (
            <CommitInput
              key={key}
              dataKey={f.key}
              label={label}
              type="color"
              value={toHex(op[f.key])}
              disabled={disabled}
              onCommit={(hex) => onChange({ ...op, [f.key]: fromHex(hex) })}
            />
          );
        }
        return (
          <CommitInput
            key={key}
            dataKey={f.key}
            label={label}
            type="text"
            value={pointsText(op[f.key])}
            disabled={disabled}
            onCommit={(text) => {
              const points = parsePoints(text);
              if (points) onChange({ ...op, [f.key]: points });
            }}
          />
        );
      })}
    </div>
  );
}

function OpenInImageEditor() {
  const strings = useStrings();
  const registries = useRegistries();
  const commands = useRegistryView(registries.commands);
  const { elementSelection } = useSelection();
  const available =
    commands.get(OPEN_IN_IMAGE_EDITOR_COMMAND_ID) !== undefined &&
    (commands.offered?.(OPEN_IN_IMAGE_EDITOR_COMMAND_ID) ?? true);
  return (
    <button
      type="button"
      data-adjust-open-image=""
      disabled={!available || elementSelection.length !== 1}
      onClick={() => {
        void registries.commands.invoke(OPEN_IN_IMAGE_EDITOR_COMMAND_ID);
      }}
      className="h-[26px] rounded-[6px] border border-input px-2 text-[11px] disabled:opacity-55"
    >
      {strings.t(M.openInImageEditor)}
    </button>
  );
}

const BINDINGS = {
  stack: { scope: "element" as const, path: "frameImageAdjustments" },
};

function StackEditor({ field }: { field: ObjectField }) {
  const strings = useStrings();
  const live = unwrapStack(field.value);
  const stack = live ?? [];
  const inert = field.onCommit == null;
  const mixed = field.bindingState === "mixed";
  const write = (next: RasterOp[]) => {
    field.onCommit?.({
      type: "imageAdjustments",
      value: next,
    } as unknown as Value);
  };
  const select =
    "h-[26px] flex-1 rounded-[6px] border border-input bg-background px-1 text-[11px] disabled:opacity-55";
  return (
    <ObjectFieldFrame field={field}>
      <div data-adjust-stack="" data-adjust-count={stack.length}>
        <div className="flex gap-1.5 pb-2">
          <select
            data-adjust-add=""
            aria-label={strings.t(M.add)}
            className={select}
            disabled={inert}
            value=""
            onChange={(e) => {
              const spec = OPS.find((o) => o.op === e.target.value);
              if (spec) write([...stack, spec.make()]);
            }}
          >
            <option value="">{strings.t(M.add)}</option>
            {OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {strings.t(M[o.label])}
              </option>
            ))}
          </select>
          <select
            data-adjust-preset=""
            aria-label={strings.t(M.preset)}
            className={select}
            disabled={inert}
            value=""
            onChange={(e) => {
              const preset = PRESETS.find((p) => p.id === e.target.value);
              if (preset) write([...stack, ...preset.ops]);
            }}
          >
            <option value="">{strings.t(M.preset)}</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {strings.t(M[p.label])}
              </option>
            ))}
          </select>
        </div>
        {mixed && (
          <div
            className="pb-1 text-[11px]"
            data-adjust-mixed=""
            style={{ color: "var(--pg-muted-fg)" }}
          >
            {strings.t(M.mixed)}
          </div>
        )}
        {!mixed && stack.length === 0 && (
          <div
            className="pb-1 text-[11px]"
            data-adjust-empty=""
            style={{ color: "var(--pg-muted-fg)" }}
          >
            {strings.t(inert ? M.nothing : M.empty)}
          </div>
        )}
        {stack.map((op, i) => (
          <OpRow
            key={`${i}:${op.op}`}
            op={op}
            index={i}
            count={stack.length}
            disabled={inert}
            onChange={(next) =>
              write(stack.map((o, j) => (j === i ? next : o)))
            }
            onMove={(delta) => {
              const next = stack.slice();
              const [moved] = next.splice(i, 1);
              next.splice(i + delta, 0, moved);
              write(next);
            }}
            onRemove={() => write(stack.filter((_, j) => j !== i))}
          />
        ))}
        <div className="-mx-3 flex justify-between gap-2 border-t border-input px-3 pt-2">
          <button
            type="button"
            data-adjust-reset=""
            disabled={inert || (stack.length === 0 && !mixed)}
            onClick={() => write([])}
            className="h-[26px] rounded-[6px] border border-input px-2 text-[11px] disabled:opacity-55"
          >
            {strings.t(M.reset)}
          </button>
          <OpenInImageEditor />
        </div>
      </div>
    </ObjectFieldFrame>
  );
}

export function PictureAdjustmentsPanel() {
  const resolved = useObjectBindings(BINDINGS);
  return (
    <div className="flex flex-col p-3" data-picture-adjustments-panel="ready">
      <StackEditor field={resolved.stack} />
    </div>
  );
}
