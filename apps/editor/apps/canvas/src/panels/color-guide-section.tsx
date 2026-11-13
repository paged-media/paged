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

// The Color Wheel panel's Color Guide section (see `../color-guide.ts`): the
// harmony of the selection's fill under a rule, and a row of variations of
// each harmony colour. Click a chip to paint the selection's fill with it,
// Alt-click for its stroke.

import { useEffect, useState } from "react";

import { useCanvasClient, useSelection } from "@paged-media/shell";
import type { ElementId } from "@paged-media/client";
import {
  HARMONY_RULES,
  VARIATION_KINDS,
  harmonyOf,
  rgbToHex,
  variationsOf,
  type HarmonyRule,
  type Rgb,
  type VariationKind,
} from "@paged-media/vector-geometry";
import { defineMessages, useStrings } from "@paged-media/strings";

import { applyGuideColor, readGuideBase } from "../color-guide";

const M = defineMessages("app.colorGuide", {
  title: "Color guide",
  none: "Select an object with a fill color.",
  rule: "Harmony rule",
  variations: "Variations",
  chipHint: "{hex}: click to fill, Alt-click to stroke",
  complementary: "Complementary",
  analogous: "Analogous",
  triadic: "Triad",
  splitComplementary: "Split complementary",
  tetradic: "Tetrad",
  monochromatic: "Monochromatic",
  shades: "Shades",
  tints: "Tints",
  tintsShades: "Shades and tints",
  warmCool: "Warm and cool",
  vividMuted: "Vivid and muted",
});

const RULE_LABEL: Record<HarmonyRule, string> = {
  complementary: M.complementary,
  analogous: M.analogous,
  triadic: M.triadic,
  splitComplementary: M.splitComplementary,
  tetradic: M.tetradic,
  monochromatic: M.monochromatic,
  shades: M.shades,
  tints: M.tints,
};

const KIND_LABEL: Record<VariationKind, string> = {
  tintsShades: M.tintsShades,
  warmCool: M.warmCool,
  vividMuted: M.vividMuted,
};

function Chip({
  c,
  base,
  hook,
  title,
  onPick,
}: {
  c: Rgb;
  base?: boolean;
  hook: string;
  title: string;
  onPick: (c: Rgb, stroke: boolean) => void;
}) {
  const size = base ? 22 : 18;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      {...{ [hook]: rgbToHex(c) }}
      onClick={(e) => onPick(c, e.altKey)}
      className="rounded-[3px] border border-input p-0"
      style={{ width: size, height: size, background: rgbToHex(c) }}
    />
  );
}

export function ColorGuideSection() {
  const strings = useStrings();
  const client = useCanvasClient();
  const { elementSelection } = useSelection();
  const [base, setBase] = useState<Rgb | null>(null);
  const [rule, setRule] = useState<HarmonyRule>("complementary");
  const [kind, setKind] = useState<VariationKind>("tintsShades");
  const [refusal, setRefusal] = useState<string | null>(null);

  const selection = elementSelection as ElementId[];
  useEffect(() => {
    let live = true;
    void readGuideBase(client, selection).then((b) => {
      if (live) setBase(b);
    });
    return () => {
      live = false;
    };
  }, [client, selection]);

  const pick = (c: Rgb, stroke: boolean) =>
    void applyGuideColor(client, selection, c, stroke).then(setRefusal);

  const harmony = base ? harmonyOf(base, rule) : [];
  return (
    <div
      className="mt-3 flex flex-col gap-2 border-t border-input pt-3"
      data-color-guide={base ? rgbToHex(base) : ""}
    >
      <div className="pg-label">{strings.t(M.title)}</div>
      {!base ? (
        <div className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
          {strings.t(M.none)}
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2 text-xs">
            <span className="flex-1">{strings.t(M.rule)}</span>
            <select
              data-color-guide-rule=""
              value={rule}
              onChange={(e) => setRule(e.target.value as HarmonyRule)}
            >
              {HARMONY_RULES.map((r) => (
                <option key={r} value={r}>
                  {strings.t(RULE_LABEL[r])}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1" data-color-guide-harmony="">
            {harmony.map((c, i) => (
              <Chip
                key={i}
                c={c}
                base={i === 0}
                hook="data-color-guide-harmony-chip"
                title={strings.t(M.chipHint, { hex: rgbToHex(c) })}
                onPick={pick}
              />
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <span className="flex-1">{strings.t(M.variations)}</span>
            <select
              data-color-guide-kind=""
              value={kind}
              onChange={(e) => setKind(e.target.value as VariationKind)}
            >
              {VARIATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {strings.t(KIND_LABEL[k])}
                </option>
              ))}
            </select>
          </label>
          {harmony.map((c, i) => (
            <div
              key={i}
              className="flex items-center gap-1"
              data-color-guide-row={i}
            >
              {variationsOf(c, kind, 7).map((v, j) => (
                <Chip
                  key={j}
                  c={v}
                  base={j === 3}
                  hook="data-color-guide-chip"
                  title={strings.t(M.chipHint, { hex: rgbToHex(v) })}
                  onPick={pick}
                />
              ))}
            </div>
          ))}
        </>
      )}
      {refusal && (
        <div
          className="text-xs"
          style={{ color: "var(--pg-danger, #c33)" }}
          data-color-guide-refusal=""
        >
          {refusal}
        </div>
      )}
    </div>
  );
}
