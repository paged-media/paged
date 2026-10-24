/*
 * This file is part of paged (https://paged.media).
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

// The COLOR GUIDE panel (WP6.5, Illustrator §18.2) — the harmony of the
// selection's current FILL colour under a rule, and a grid of variations
// of each harmony colour: SHADES → TINTS, WARM → COOL or VIVID → MUTED
// (one row per harmony colour, the colour itself in the middle). Clicking
// any chip paints the selection's fill with it (Alt-click: its stroke)
// through `applyGuideColor` — one undo step, a swatch created or reused.
// "Save group" is not here: the contract's colour-group write is the
// Swatches panel's, and a second way to make one would drift from it.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import {
  harmonyOf,
  HARMONY_RULES,
  rgbToHex,
  variationsOf,
  VARIATION_KINDS,
  type HarmonyRule,
  type Rgb,
  type VariationKind,
} from "@paged-media/draw-geometry";
import {
  About,
  color,
  font,
  Refusal,
  useActionFeedback,
} from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";
import * as React from "react";

import { applyGuideColor, guideBaseOf } from "../commands/recolor";
import { harmonyRuleLabel } from "./recolor-panel";
import { PanelIntro } from "./panel-parts";
import { usePanelReload } from "./use-panel-reload";

const M = defineMessages("draw.colorGuidePanel", {
  title: "Color guide",
  summary:
    "Colours that go with the selection's fill: a harmony rule and variations of each of its colours. Click a colour to fill the selection with it.",
  none: "Select an object with a fill colour.",
  rule: "Harmony rule",
  variations: "Variations",
  tintsShades: "Shades and tints",
  warmCool: "Warm and cool",
  vividMuted: "Vivid and muted",
  chipHint: "{hex} — click to fill, Alt-click to stroke",
  note: "The base colour is the selection's fill as it shows on screen. A clicked colour becomes a swatch named for its value (an existing swatch of that name is reused) and is applied in one undo step.",
});

export const COLOR_GUIDE_PANEL_NOTE = M.note;

const VARIATION_NAMES: Record<VariationKind, typeof M.tintsShades> = {
  tintsShades: M.tintsShades,
  warmCool: M.warmCool,
  vividMuted: M.vividMuted,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 0",
  font: `12px ${font.sans}`,
};
const chipStyle = (c: Rgb, base = false): React.CSSProperties => ({
  width: base ? 22 : 18,
  height: base ? 22 : 18,
  borderRadius: 3,
  border: `1px solid ${color.border}`,
  background: rgbToHex(c),
  cursor: "pointer",
  padding: 0,
});

/** One clickable colour: click fills, Alt-click strokes. */
function GuideChip(props: {
  c: Rgb;
  base?: boolean;
  attr: string;
  title: string;
  onPick: (c: Rgb, stroke: boolean) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      style={chipStyle(props.c, props.base)}
      title={props.title}
      {...{ [props.attr]: rgbToHex(props.c) }}
      onClick={(e) => props.onPick(props.c, e.altKey)}
    />
  );
}

export function makeColorGuidePanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    const [base, setBase] = React.useState<Rgb | null>(null);
    const [rule, setRule] = React.useState<HarmonyRule>("complementary");
    const [kind, setKind] = React.useState<VariationKind>("tintsShades");

    const reload = usePanelReload(host, "color-guide", async ({ live }) => {
      const b = await guideBaseOf(host);
      if (!live()) return;
      setBase(b);
    });
    const { refusal, run } = useActionFeedback(host, reload, "draw panel");
    const harmony = base ? harmonyOf(base, rule) : [];
    const pick = (c: Rgb, stroke: boolean) =>
      void run(() => applyGuideColor(host, { hex: rgbToHex(c), stroke }));

    return (
      <div
        style={{ padding: 12 }}
        data-draw-color-guide-panel
        data-draw-color-guide-base={base ? rgbToHex(base) : ""}
      >
        <PanelIntro
          summary={s.t(M.summary)}
          attr="data-draw-color-guide-intro"
        />
        {!base ? (
          <div style={{ ...rowStyle, opacity: 0.6 }}>{s.t(M.none)}</div>
        ) : (
          <>
            <label style={rowStyle}>
              <span style={{ flex: 1 }}>{s.t(M.rule)}</span>
              <select
                data-draw-color-guide-rule
                value={rule}
                onChange={(e) => setRule(e.target.value as HarmonyRule)}
              >
                {HARMONY_RULES.map((r) => (
                  <option key={r} value={r}>
                    {harmonyRuleLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <div style={rowStyle} data-draw-color-guide-harmony>
              {harmony.map((c, i) => (
                <GuideChip
                  key={i}
                  c={c}
                  base={i === 0}
                  attr="data-draw-color-guide-harmony-chip"
                  title={s.t(M.chipHint, { hex: rgbToHex(c) })}
                  onPick={pick}
                />
              ))}
            </div>
            <label style={rowStyle}>
              <span style={{ flex: 1 }}>{s.t(M.variations)}</span>
              <select
                data-draw-color-guide-kind
                value={kind}
                onChange={(e) => setKind(e.target.value as VariationKind)}
              >
                {VARIATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {s.t(VARIATION_NAMES[k])}
                  </option>
                ))}
              </select>
            </label>
            {harmony.map((c, i) => (
              <div key={i} style={rowStyle} data-draw-color-guide-row={i}>
                {variationsOf(c, kind, 7).map((v, j) => (
                  <GuideChip
                    key={j}
                    c={v}
                    base={j === 3}
                    attr="data-draw-color-guide-chip"
                    title={s.t(M.chipHint, { hex: rgbToHex(v) })}
                    onPick={pick}
                  />
                ))}
              </div>
            ))}
          </>
        )}
        <Refusal text={refusal} />
        <About attr="data-draw-color-guide-note">
          {s.t(COLOR_GUIDE_PANEL_NOTE)}
        </About>
      </div>
    );
  };
  return { title: t(M.title), component: Component, defaultDock: "right" };
}
