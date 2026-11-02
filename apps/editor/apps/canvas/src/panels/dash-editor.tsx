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

// The Stroke panel's dash editor: Illustrator's "Dashed line" with up to
// three dash/gap pairs, the four presets, and a read-back that follows the
// selection. It edits `frameStrokeDashArray` beside the composition's
// generic list field ("Dashes & arrows", any run typed as "6, 3"): that
// field is the free-form entry, this is the structured one.
//
// WHY HERE AND NOT IN paged.draw. The property is a page item's and this
// panel is where a stroke is edited; paged.draw carried a second editor in
// its Path Options panel (PM-0017). The model (the pairs of an array, the
// array of the pairs) and the preset runs are `@paged-media/helpers`'.
//
//  1. THE FIELDS STAY WHEN THE SWITCH GOES OFF: "Dashed line" off writes a
//     solid stroke, the typed lengths are kept, and switching it on again
//     restores them. A fresh editor starts from the Dashed preset (6 / 3).
//  2. A DASH WITH MORE THAN THREE PAIRS shows the first three and says how
//     many it hides, because an edit rewrites the array with the three it
//     shows.
//  3. EVERY EDIT IS ONE WRITE (one undo step) through the field's commit,
//     for the whole selection.

import { useState } from "react";

import {
  TogglePill,
  useObjectBindings,
  type ObjectField,
} from "@paged-media/shell";
import {
  DASH_PRESET_LENGTHS,
  MAX_DASH_PAIRS,
  dashLengthsFromPairs,
  dashPairsFromLengths,
  type DashPair,
} from "@paged-media/helpers";
import { NumberInput } from "@paged-media/ui";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.dashEditor", {
  title: "Dashes",
  dashed: "Dashed line",
  dash: "Dash {n} (pt)",
  gap: "Gap {n} (pt)",
  solid: "Solid",
  dashedPreset: "Dashed",
  dotted: "Dotted",
  dashDot: "Dash-dot",
  hidden:
    "This stroke's dash has {count} pairs; the editor shows the first {shown}, and an edit writes only those.",
});

const BINDINGS = {
  dash: { path: "frameStrokeDashArray", scope: "element" as const },
};

/** The pairs a fresh editor starts from: the Dashed preset's 6 / 3. */
const FRESH: DashPair[] = [
  { dash: 6, gap: 3 },
  { dash: 0, gap: 0 },
  { dash: 0, gap: 0 },
];

/** The lengths a field holds: the list itself, or the wire's wrapped
 *  `{ type: "lengths", value }`. `null` when it holds neither. */
export function lengthsOf(f: ObjectField): number[] | null {
  if (f.state.state !== "value") return null;
  const v = f.state.value as unknown;
  if (Array.isArray(v)) return v as number[];
  const inner = (v as { value?: unknown } | null)?.value;
  return Array.isArray(inner) ? (inner as number[]) : null;
}

const padded = (pairs: readonly DashPair[]): DashPair[] =>
  Array.from(
    { length: MAX_DASH_PAIRS },
    (_, i) => pairs[i] ?? { dash: 0, gap: 0 },
  );

export function DashEditor() {
  const strings = useStrings();
  const { dash: field } = useObjectBindings(BINDINGS);
  // The pairs shown while the stroke is solid: kept so that switching the
  // line on again restores what was typed.
  const [kept, setKept] = useState<DashPair[]>(FRESH);

  const lengths = lengthsOf(field);
  const read = dashPairsFromLengths(lengths);
  const dashed = read != null;
  const pairs = padded(read ? read.pairs : kept);
  const mixed = field.state.state === "mixed";
  const disabled = field.commit == null || (lengths == null && !mixed);

  const write = (next: number[]) => void field.commit?.(next);

  const edit = (index: number, part: keyof DashPair, value: number) => {
    const next = pairs.map((p, i) =>
      i === index ? { ...p, [part]: Math.max(0, value) } : p,
    );
    setKept(next);
    // Editing a field of a solid stroke switches the line on.
    write(dashLengthsFromPairs(next));
  };

  const presets = [
    { key: "solid", label: M.solid, lengths: DASH_PRESET_LENGTHS.solid },
    {
      key: "dashed",
      label: M.dashedPreset,
      lengths: DASH_PRESET_LENGTHS.dashed,
    },
    { key: "dotted", label: M.dotted, lengths: DASH_PRESET_LENGTHS.dotted },
    { key: "dashDot", label: M.dashDot, lengths: DASH_PRESET_LENGTHS.dashDot },
  ] as const;

  return (
    <div
      className="mt-2 flex flex-col gap-[6px] border-t border-input pt-2"
      data-dash-editor={dashed ? "dashed" : "solid"}
    >
      <div className="pg-label">{strings.t(M.title)}</div>
      <div className="flex flex-wrap gap-1">
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            data-dash-preset={p.key}
            disabled={disabled}
            onClick={() => write([...p.lengths])}
            className="h-[24px] rounded border border-input px-2 text-xs disabled:opacity-40"
          >
            {strings.t(p.label)}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <TogglePill
          checked={dashed}
          mixed={mixed}
          disabled={disabled}
          testId="dash-dashed"
          label={strings.t(M.dashed)}
          onToggle={(on) => write(on ? dashLengthsFromPairs(kept) : [])}
        />
        {strings.t(M.dashed)}
      </label>
      {pairs.map((pair, i) => (
        <div key={i} className="grid grid-cols-2 gap-2">
          <NumberInput
            suffix="pt"
            value={mixed ? null : pair.dash}
            min={0}
            precision={2}
            disabled={disabled || !dashed}
            onChange={() => {}}
            onCommit={(v) => edit(i, "dash", v)}
            aria-label={strings.t(M.dash, { n: i + 1 })}
          />
          <NumberInput
            suffix="pt"
            value={mixed ? null : pair.gap}
            min={0}
            precision={2}
            disabled={disabled || !dashed}
            onChange={() => {}}
            onCommit={(v) => edit(i, "gap", v)}
            aria-label={strings.t(M.gap, { n: i + 1 })}
          />
        </div>
      ))}
      {read && read.hiddenPairs > 0 && (
        <div
          className="text-xs"
          style={{ color: "var(--pg-muted-fg)" }}
          data-dash-hidden=""
        >
          {strings.t(M.hidden, {
            count: MAX_DASH_PAIRS + read.hiddenPairs,
            shown: MAX_DASH_PAIRS,
          })}
        </div>
      )}
    </div>
  );
}
