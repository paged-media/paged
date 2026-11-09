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

// The BRUSHES panel (WP6.4, Illustrator's Brushes panel and Brush Options
// dialog in one, draw ADR 366). Three sections:
//
//   · BRUSHES — a library (Basic, Artistic, Decorative, the document's
//     own) and its brushes; a click applies the brush to the selection's
//     stroke as a live stroke style (engine ADR 1053), Remove takes it
//     off, New makes a brush of the selected artwork.
//   · BRUSH OPTIONS — the selected item's brush: size, spacing, scatter,
//     rotation, flips, tile proportion, bristles; Apply writes them (one
//     undo step for the selection).
//   · WIDTH PROFILES — the profile library; a click gives the selection's
//     stroke that live width profile (Uniform takes it off).

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { WIDTH_PROFILE_PRESETS } from "@paged-media/vector-geometry";
import {
  About,
  font,
  Refusal,
  useActionFeedback,
} from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";
import * as React from "react";

import {
  applyBrush,
  applyWidthProfileStyle,
  BRUSH_LIBRARIES,
  BRUSH_MESSAGES,
  BRUSH_OPTION_RANGES,
  BRUSH_TYPES,
  BUILTIN_BRUSHES,
  DEFAULT_BRUSH_OPTIONS,
  documentBrushes,
  newBrushFromSelection,
  readStroke,
  removeBrush,
  setBrushOptions,
  takesStrokeStyle,
  type BrushDef,
  type BrushOptions,
  type BrushType,
} from "../commands/brushes";
import { PanelIntro } from "./panel-parts";
import { usePanelReload } from "./use-panel-reload";

const M = defineMessages("draw.brushesPanel", {
  title: "Brushes",
  summary:
    "Brushes draw a path's stroke as artwork along it, and a width profile makes the stroke wider and narrower along the path. Both stay live: the path keeps its anchors.",
  library: "Library",
  remove: "Remove brush",
  newBrush: "New brush from the selection",
  newType: "Type",
  options: "Brush options",
  noBrush: "Select an object with a brush to change its options.",
  apply: "Apply options",
  widthProfiles: "Width profiles",
  art: "Art",
  scatter: "Scatter",
  pattern: "Pattern",
  bristle: "Bristle",
  scalePct: "Size (%)",
  spacingPct: "Spacing (%)",
  scatterPct: "Scatter (%)",
  rotateDeg: "Rotation (°)",
  rotateVariationDeg: "Rotation variation (°)",
  sizeMinPct: "Smallest size (%)",
  tileAspect: "Tile proportion",
  bristles: "Bristles",
  bristleThicknessPct: "Bristle thickness (%)",
  seed: "Seed",
  flipAlong: "Flip along",
  flipAcross: "Flip across",
  note: "A brush's artwork is painted with the stroke's colour. IDML has no brushes: an export writes the artwork as a path, keeps the brush in a label a paged reader restores, and lists it as a loss.",
});

export const BRUSHES_PANEL_NOTE = M.note;

const TYPE_NAMES: Record<BrushType, string> = {
  art: M.art,
  scatter: M.scatter,
  pattern: M.pattern,
  bristle: M.bristle,
};

/** The options each type reads, in form order. */
const OPTIONS_OF: Record<
  BrushType,
  readonly (keyof typeof BRUSH_OPTION_RANGES)[]
> = {
  art: ["scalePct"],
  pattern: ["scalePct", "spacingPct", "tileAspect"],
  scatter: [
    "scalePct",
    "spacingPct",
    "scatterPct",
    "rotateDeg",
    "rotateVariationDeg",
    "sizeMinPct",
    "seed",
  ],
  bristle: ["scalePct", "bristles", "bristleThicknessPct", "seed"],
};

/** The width profile library's names (vector-geometry's presets). */
const PROFILE_NAMES: Record<string, string> = defineMessages(
  "draw.widthProfiles",
  {
    uniform: "Uniform",
    lens: "Lens",
    taperEnd: "Taper to the end",
    taperStart: "Taper from the start",
    bulge: "Bulge",
    pinch: "Pinch",
    teardrop: "Teardrop",
  },
);

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 0",
  font: `12px ${font.sans}`,
};
const headStyle: React.CSSProperties = {
  ...rowStyle,
  fontWeight: 600,
  paddingTop: 8,
};

/** The selection's brush, as the panel edits it. */
interface Current {
  type: BrushType;
  options: BrushOptions;
}

function currentOf(stack: readonly Record<string, unknown>[]): Current | null {
  const e = stack.find((x) => x.kind === "brush");
  if (!e) return null;
  const type = (
    BRUSH_TYPES.includes(e.brushType as BrushType) ? e.brushType : "art"
  ) as BrushType;
  const options = { ...DEFAULT_BRUSH_OPTIONS };
  for (const k of Object.keys(options) as (keyof BrushOptions)[]) {
    const v = e[k];
    if (typeof v === typeof options[k])
      (options as Record<string, unknown>)[k] = v;
  }
  return { type, options };
}

export function makeBrushesPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    const [library, setLibrary] = React.useState("basic");
    const [docBrushes, setDocBrushes] = React.useState<BrushDef[]>([]);
    const [current, setCurrent] = React.useState<Current | null>(null);
    const [edit, setEdit] = React.useState<BrushOptions | null>(null);
    const [newType, setNewType] = React.useState<BrushType>("art");

    const reload = usePanelReload(host, "brushes", async ({ live }) => {
      const brushes = await documentBrushes(host);
      const id = host.selection.get().find(takesStrokeStyle);
      const read = id ? await readStroke(host, id) : null;
      if (!live()) return;
      setDocBrushes(brushes);
      const cur = read ? currentOf(read.stack) : null;
      setCurrent(cur);
      setEdit(cur ? cur.options : null);
    });
    const { refusal, run } = useActionFeedback(host, reload, "draw panel");

    const shown =
      library === "document"
        ? docBrushes
        : BUILTIN_BRUSHES.filter((b) => b.library === library);
    const name = (b: BrushDef) =>
      b.library === "document" ? b.name : s.t(b.name);

    return (
      <div style={{ padding: 12 }} data-draw-brushes-panel>
        <PanelIntro summary={s.t(M.summary)} attr="data-draw-brushes-intro" />
        <label style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.library)}</span>
          <select
            data-draw-brushes-library
            value={library}
            onChange={(e) => setLibrary(e.target.value)}
          >
            {BRUSH_LIBRARIES.map((l) => (
              <option key={l.id} value={l.id}>
                {s.t(l.name)}
              </option>
            ))}
            <option value="document">{s.t(BRUSH_MESSAGES.document)}</option>
          </select>
        </label>
        <div data-draw-brushes-list>
          {shown.map((b) => (
            <button
              key={b.id}
              type="button"
              style={{ ...rowStyle, width: "100%", textAlign: "left" }}
              data-draw-brush={b.id}
              data-draw-brush-type={b.type}
              onClick={() => void run(() => applyBrush(host, { brush: b.id }))}
            >
              <span style={{ flex: 1 }}>{name(b)}</span>
              <span style={{ opacity: 0.6 }}>{s.t(TYPE_NAMES[b.type])}</span>
            </button>
          ))}
        </div>
        <div style={rowStyle}>
          <button
            type="button"
            data-draw-brush-remove
            disabled={!current}
            onClick={() => void run(() => removeBrush(host))}
          >
            {s.t(M.remove)}
          </button>
        </div>
        <div style={rowStyle}>
          <select
            data-draw-brush-new-type
            aria-label={s.t(M.newType)}
            value={newType}
            onChange={(e) => setNewType(e.target.value as BrushType)}
          >
            {(["art", "scatter", "pattern"] as const).map((k) => (
              <option key={k} value={k}>
                {s.t(TYPE_NAMES[k])}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-draw-brush-new
            onClick={() =>
              void run(async () => {
                await newBrushFromSelection(host, { type: newType });
                setLibrary("document");
              })
            }
          >
            {s.t(M.newBrush)}
          </button>
        </div>

        <div style={headStyle}>{s.t(M.options)}</div>
        {!current || !edit ? (
          <div
            style={{ ...rowStyle, opacity: 0.6 }}
            data-draw-brush-options-none
          >
            {s.t(M.noBrush)}
          </div>
        ) : (
          <div data-draw-brush-options={current.type}>
            {OPTIONS_OF[current.type].map((k) => (
              <label key={k} style={rowStyle}>
                <span style={{ flex: 1 }}>{s.t(M[k])}</span>
                <input
                  type="number"
                  data-draw-brush-option={k}
                  min={BRUSH_OPTION_RANGES[k][0]}
                  max={BRUSH_OPTION_RANGES[k][1]}
                  value={edit[k]}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setEdit({ ...edit, [k]: v });
                  }}
                  style={{ width: 72 }}
                />
              </label>
            ))}
            {current.type !== "bristle"
              ? (["flipAlong", "flipAcross"] as const).map((k) => (
                  <label key={k} style={rowStyle}>
                    <input
                      type="checkbox"
                      data-draw-brush-option={k}
                      checked={edit[k]}
                      onChange={(e) =>
                        setEdit({ ...edit, [k]: e.target.checked })
                      }
                    />
                    <span>{s.t(M[k])}</span>
                  </label>
                ))
              : null}
            <div style={rowStyle}>
              <button
                type="button"
                data-draw-brush-options-apply
                onClick={() => void run(() => setBrushOptions(host, edit))}
              >
                {s.t(M.apply)}
              </button>
            </div>
          </div>
        )}

        <div style={headStyle}>{s.t(M.widthProfiles)}</div>
        <div data-draw-width-profiles>
          {WIDTH_PROFILE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              style={{ ...rowStyle, width: "100%", textAlign: "left" }}
              data-draw-width-profile={p.id}
              onClick={() =>
                void run(() => applyWidthProfileStyle(host, { profile: p.id }))
              }
            >
              {PROFILE_NAMES[p.id] ? s.t(PROFILE_NAMES[p.id]!) : p.name}
            </button>
          ))}
        </div>
        <Refusal text={refusal} />
        <About attr="data-draw-brushes-note">{s.t(BRUSHES_PANEL_NOTE)}</About>
      </div>
    );
  };
  return { title: t(M.title), component: Component, defaultDock: "right" };
}
