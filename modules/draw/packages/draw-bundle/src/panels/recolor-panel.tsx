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

// The RECOLOR ARTWORK panel (WP6.5) — Illustrator's Recolor Artwork
// dialog as a panel (the contract has no modal dialog door; the menu row
// raises this panel, the "…" rule). It shows the selection's COLOUR
// GROUP — every swatch its fills, strokes, gradient stops and appearance
// layers use, heaviest first — and, row by row, what each becomes under
// the chosen way:
//   · HARMONY — a rule and an HSB WHEEL. The harmony's colours sit on the
//     wheel as handles; dragging any of them turns the whole harmony (the
//     relations hold), which is what the base handle does in Illustrator;
//   · REDUCE — to N colours (deterministic Lab k-means);
//   · LIBRARY — to the nearest swatch of a colour group, or of every
//     document swatch.
// The preview IS the plan Apply sends (`recolorTargetsFor`, pure), and
// Apply is one batch: one undo step.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import {
  HARMONY_RULES,
  rgbToHex,
  wheelColor,
  wheelDragDelta,
  wheelPoint,
  type HarmonyRule,
  type Rgb,
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

import {
  applyRecolorArtwork,
  readArtworkColors,
  recolorTargetsFor,
  requestHarmony,
  RECOLOR_DEFAULTS,
  type ArtworkColor,
  type RecolorMode,
  type RecolorRequest,
} from "../commands/recolor";
import { PanelIntro } from "./panel-parts";
import { usePanelReload } from "./use-panel-reload";

const M = defineMessages("draw.recolorPanel", {
  title: "Recolor artwork",
  summary:
    "Recolour the selection: pick a harmony and turn it on the wheel, reduce it to fewer colours, or map it onto a swatch library.",
  colors: "{n, plural, one {# colour} other {# colours}} in the selection",
  none: "Select artwork to recolour.",
  mode: "Recolour by",
  harmony: "Harmony",
  reduce: "Reduce colours",
  library: "Library",
  rule: "Rule",
  rotate: "Rotation",
  neutrals: "Recolour black, white and greys too",
  count: "Number of colours",
  group: "Swatches",
  allSwatches: "All document swatches",
  current: "Current",
  next: "New",
  unchanged: "unchanged",
  apply: "Apply",
  applyHint: "Recolour the selection as previewed (one undo step)",
  reset: "Reset",
  note: "Each colour in the selection is replaced in the selection only: new swatches are created and the selection's fills, strokes, gradients and appearance layers are pointed at them, so other artwork keeps its colours. An object's tint is kept, so a tint of a spot colour becomes the same tint of its replacement, and a spot colour's replacement is a spot colour. Reducing and library recolouring reuse existing swatches.",
});

const RULE_NAMES = defineMessages("draw.harmonyRule", {
  complementary: "Complementary",
  analogous: "Analogous",
  triadic: "Triad",
  splitComplementary: "Split complementary",
  tetradic: "Tetrad",
  monochromatic: "Monochromatic",
  shades: "Shades",
  tints: "Tints",
});

export const RECOLOR_PANEL_NOTE = M.note;
export const harmonyRuleLabel = (rule: HarmonyRule): string =>
  t(RULE_NAMES[rule]);

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: `12px ${font.sans}`,
};
const chip = (c: Rgb | null): React.CSSProperties => ({
  width: 18,
  height: 18,
  borderRadius: 3,
  border: `1px solid ${color.border}`,
  background: c ? rgbToHex(c) : "transparent",
  flex: "none",
});

const WHEEL = 150;
const R = WHEEL / 2 - 6;

/** The wheel's hue ring, as 72 wedges (SVG has no conic gradient). */
function WheelRing(): React.ReactElement {
  const wedges: React.ReactElement[] = [];
  for (let i = 0; i < 72; i++) {
    const a0 = (i * 5 * Math.PI) / 180;
    const a1 = ((i + 1) * 5 * Math.PI) / 180;
    const c = wheelColor(Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2), 1);
    const p = (a: number, r: number) =>
      `${WHEEL / 2 + Math.cos(a) * r},${WHEEL / 2 - Math.sin(a) * r}`;
    wedges.push(
      <path
        key={i}
        d={`M${p(a0, 0)} L${p(a0, R)} A${R},${R} 0 0,0 ${p(a1, R)} Z`}
        fill={rgbToHex(c)}
        stroke={rgbToHex(c)}
      />,
    );
  }
  return <g>{wedges}</g>;
}

export function makeRecolorPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    const [colors, setColors] = React.useState<ArtworkColor[]>([]);
    const [library, setLibrary] = React.useState<{ ref: string; rgb: Rgb }[]>(
      [],
    );
    const [groups, setGroups] = React.useState<
      { selfId: string; name: string; members?: string[] }[]
    >([]);
    const [request, setRequest] = React.useState<RecolorRequest>({
      ...RECOLOR_DEFAULTS,
      map: {},
    });
    const [drag, setDrag] = React.useState<[number, number] | null>(null);

    const reload = usePanelReload(host, "recolor", async ({ live }) => {
      const read = await readArtworkColors(host);
      if (!live()) return;
      const cg = await host.document
        .collection<{ selfId: string; name: string; members?: string[] }>(
          "colorGroups",
        )
        .catch(() => []);
      if (!live()) return;
      setColors(read.colors);
      setLibrary(read.swatches);
      setGroups([...cg]);
    });
    const { refusal, run } = useActionFeedback(host, reload, "draw panel");

    const libraryFor = (): { ref: string; rgb: Rgb }[] => {
      if (!request.colorGroup) return library;
      const members = new Set(
        groups.find((g) => g.selfId === request.colorGroup)?.members ?? [],
      );
      return library.filter((l) => members.has(l.ref));
    };
    const targets = recolorTargetsFor(colors, request, libraryFor());
    const harmony =
      request.mode === "harmony" ? requestHarmony(colors, request) : [];
    const set = (patch: Partial<RecolorRequest>) =>
      setRequest({ ...request, ...patch });
    const toUnit = (e: React.PointerEvent<SVGSVGElement>): [number, number] => {
      const box = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - box.left - WHEEL / 2) / R;
      const y = -(e.clientY - box.top - WHEEL / 2) / R;
      return [x, y];
    };
    const swatchRgb = (ref: string): Rgb | null =>
      library.find((l) => l.ref === ref)?.rgb ??
      colors.find((c) => c.ref === ref)?.rgb ??
      null;

    return (
      <div
        style={{ padding: 12 }}
        data-draw-recolor-panel={colors.length}
        data-draw-recolor-mode={request.mode}
        data-draw-recolor-changes={targets.size}
      >
        <PanelIntro summary={s.t(M.summary)} attr="data-draw-recolor-intro" />
        <div style={rowStyle} data-draw-recolor-count>
          {colors.length === 0
            ? s.t(M.none)
            : s.t(M.colors, { n: colors.length })}
        </div>
        <label style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.mode)}</span>
          <select
            data-draw-recolor-mode-select
            value={request.mode}
            onChange={(e) => set({ mode: e.target.value as RecolorMode })}
          >
            <option value="harmony">{s.t(M.harmony)}</option>
            <option value="reduce">{s.t(M.reduce)}</option>
            <option value="library">{s.t(M.library)}</option>
          </select>
        </label>
        {request.mode === "harmony" && (
          <>
            <label style={rowStyle}>
              <span style={{ flex: 1 }}>{s.t(M.rule)}</span>
              <select
                data-draw-recolor-rule
                value={request.rule}
                onChange={(e) => set({ rule: e.target.value as HarmonyRule })}
              >
                {HARMONY_RULES.map((rule) => (
                  <option key={rule} value={rule}>
                    {s.t(RULE_NAMES[rule])}
                  </option>
                ))}
              </select>
            </label>
            <svg
              width={WHEEL}
              height={WHEEL}
              style={{
                display: "block",
                margin: "6px auto",
                touchAction: "none",
              }}
              data-draw-recolor-wheel
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                setDrag(toUnit(e));
              }}
              onPointerMove={(e) => {
                if (!drag) return;
                const now = toUnit(e);
                set({ rotate: request.rotate + wheelDragDelta(drag, now) });
                setDrag(now);
              }}
              onPointerUp={() => setDrag(null)}
            >
              <WheelRing />
              {harmony.map((c, i) => {
                const [x, y] = wheelPoint(c);
                return (
                  <circle
                    key={i}
                    data-draw-recolor-handle={i}
                    cx={WHEEL / 2 + x * R}
                    cy={WHEEL / 2 - y * R}
                    r={i === 0 ? 7 : 5}
                    fill={rgbToHex(c)}
                    stroke="#fff"
                    strokeWidth={2}
                  />
                );
              })}
            </svg>
            <label style={rowStyle}>
              <span style={{ flex: 1 }}>{s.t(M.rotate)}</span>
              <input
                type="number"
                style={{ width: 64 }}
                data-draw-recolor-rotate
                value={Math.round(request.rotate)}
                onChange={(e) => set({ rotate: Number(e.target.value) || 0 })}
              />
            </label>
            <label style={rowStyle}>
              <input
                type="checkbox"
                data-draw-recolor-neutrals
                checked={request.recolorNeutrals}
                onChange={(e) => set({ recolorNeutrals: e.target.checked })}
              />
              <span>{s.t(M.neutrals)}</span>
            </label>
          </>
        )}
        {request.mode === "reduce" && (
          <label style={rowStyle}>
            <span style={{ flex: 1 }}>{s.t(M.count)}</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, colors.length)}
              style={{ width: 64 }}
              data-draw-recolor-reduce
              value={request.count}
              onChange={(e) =>
                set({ count: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </label>
        )}
        {request.mode === "library" && (
          <label style={rowStyle}>
            <span style={{ flex: 1 }}>{s.t(M.group)}</span>
            <select
              data-draw-recolor-library
              value={request.colorGroup ?? ""}
              onChange={(e) => set({ colorGroup: e.target.value || null })}
            >
              <option value="">{s.t(M.allSwatches)}</option>
              {groups.map((g) => (
                <option key={g.selfId} value={g.selfId}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div style={{ ...rowStyle, opacity: 0.65 }}>
          <span style={{ flex: 1 }}>{s.t(M.current)}</span>
          <span>{s.t(M.next)}</span>
        </div>
        {colors.map((c) => {
          const target = targets.get(c.ref);
          const next = !target
            ? null
            : target.kind === "rgb"
              ? target.rgb
              : swatchRgb(target.ref);
          return (
            <div
              key={c.ref}
              style={rowStyle}
              data-draw-recolor-row={c.ref}
              data-draw-recolor-to={next ? rgbToHex(next) : ""}
            >
              <span style={chip(c.rgb)} title={c.name} />
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.name} ×{c.weight}
              </span>
              <span>→</span>
              {next ? (
                <span style={chip(next)} />
              ) : (
                <span style={{ opacity: 0.6 }}>{s.t(M.unchanged)}</span>
              )}
            </div>
          );
        })}
        <div style={{ ...rowStyle, paddingTop: 8 }}>
          <button
            type="button"
            title={s.t(M.applyHint)}
            data-draw-recolor-apply
            disabled={targets.size === 0}
            onClick={() => void run(() => applyRecolorArtwork(host, request))}
          >
            {s.t(M.apply)}
          </button>
          <button
            type="button"
            data-draw-recolor-reset
            onClick={() => setRequest({ ...RECOLOR_DEFAULTS, map: {} })}
          >
            {s.t(M.reset)}
          </button>
        </div>
        <Refusal text={refusal} />
        <About attr="data-draw-recolor-note">{s.t(RECOLOR_PANEL_NOTE)}</About>
      </div>
    );
  };
  return { title: t(M.title), component: Component, defaultDock: "right" };
}
