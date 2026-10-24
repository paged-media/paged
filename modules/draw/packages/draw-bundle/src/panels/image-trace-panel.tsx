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

// The IMAGE TRACE panel (WP6.6) — where the Draw ▸ Image trace… row's
// ellipsis asks its question: a PRESET (Illustrator's names), the options
// it sets (any of which can be changed — the preset then reads "Custom"),
// LIVE (re-trace when the image's link changes) and the two verbs: Trace
// the selected image, or Re-trace the selected traced image / artwork
// with these options, which replaces the previous result in one undo
// step. A selected traced image shows the options its record keeps.
//
// It writes through the exact appliers the commands use.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
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
  applyImageTrace,
  applyRetraceImage,
  imageTraceOf,
  retraceSourceOf,
} from "../commands/image-trace";
import {
  presetMatching,
  tracePresetOptions,
  TRACE_PRESET_IDS,
  TRACE_PRESET_NAMES,
  type TracePresetId,
} from "../commands/trace-presets";
import { linkIndex } from "../link-index";
import { TRACE_DEFAULTS, type TraceOptions } from "../trace-engine";
import { PanelIntro } from "./panel-parts";
import { usePanelReload } from "./use-panel-reload";

const M = defineMessages("draw.imageTracePanel", {
  title: "Image trace",
  summary:
    "Turn the selected placed image into vector paths, starting from a preset; Re-trace replaces a trace with new options in one undo step.",
  preset: "Preset",
  custom: "Custom",
  mode: "Mode",
  modeColor: "Colour",
  modeBw: "Black and white",
  modeCenterline: "Centreline (strokes)",
  paths: "Paths",
  pathsSpline: "Curves",
  pathsPolygon: "Corners",
  maxColors: "Colours (0 = automatic)",
  grayscale: "Greys only",
  threshold: "Threshold",
  speckle: "Ignore areas smaller than (px)",
  ignoreWhite: "Ignore white",
  live: "Re-trace when the image's link changes",
  trace: "Trace",
  traceHint: "Trace the selected placed image with these options",
  retrace: "Re-trace",
  retraceHint:
    "Trace the selected traced image again with these options and replace its previous result",
  traced: "Selected trace: {preset}",
  notTraced: "The selection is not a traced image.",
  note: "A trace is ordinary artwork: its regions can be edited, but a Re-trace replaces them. Centreline presets trace the middle of the ink as open strokes at the ink's average width. Colour counts snap the image to that many colours first. A live trace is traced again inside the edit that changes the image's link, so one Undo takes both back.",
});

export const IMAGE_TRACE_PANEL_NOTE = M.note;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: `12px ${font.sans}`,
};
const buttonStyle: React.CSSProperties = {
  font: `12px ${font.sans}`,
  padding: "2px 10px",
  color: color.fg,
};
const numStyle: React.CSSProperties = { width: 64, font: `12px ${font.sans}` };

export function makeImageTracePanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    const [options, setOptions] = React.useState<Required<TraceOptions>>({
      ...TRACE_DEFAULTS,
    });
    const [live, setLive] = React.useState(false);
    const [traced, setTraced] = React.useState<string | null>(null);
    const [followed, setFollowed] = React.useState<string | null>(null);

    const reload = usePanelReload(
      host,
      "image-trace",
      async ({ live: alive }) => {
        const source = await retraceSourceOf(host);
        if (!alive()) return;
        if (!source) {
          setTraced(null);
          return;
        }
        const record = imageTraceOf(
          await linkIndex(host)
            .envelopeOf(source)
            .catch(() => null),
        );
        if (!alive()) return;
        const key = record
          ? `${String(source.id)}|${JSON.stringify(record.options)}`
          : null;
        setTraced(record ? (record.preset ?? "") : null);
        // Follow a newly selected trace's own options once, not on every
        // reload (a typed change must survive a selection reload).
        if (record && key !== followed) {
          setFollowed(key);
          setOptions({ ...record.options });
          setLive(record.live === true);
        }
      },
    );
    const { refusal, run } = useActionFeedback(host, reload, "draw panel");

    const preset: TracePresetId | null = presetMatching(options);
    const set = <K extends keyof TraceOptions>(
      k: K,
      v: Required<TraceOptions>[K],
    ) => setOptions({ ...options, [k]: v });
    const payload = () => ({ ...options, live, ...(preset ? { preset } : {}) });
    const presetName = (id: TracePresetId | null): string =>
      id ? s.t(TRACE_PRESET_NAMES[id]) : s.t(M.custom);

    return (
      <div
        style={{ padding: 12 }}
        data-draw-image-trace-panel
        data-draw-image-trace-preset={preset ?? "custom"}
        data-draw-image-trace-traced={traced === null ? "" : "true"}
      >
        <PanelIntro
          summary={s.t(M.summary)}
          attr="data-draw-image-trace-intro"
        />
        <label style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.preset)}</span>
          <select
            data-draw-image-trace-preset-select
            value={preset ?? ""}
            onChange={(e) => {
              const id = e.target.value as TracePresetId;
              if (TRACE_PRESET_IDS.includes(id))
                setOptions(tracePresetOptions(id));
            }}
          >
            {preset === null && <option value="">{s.t(M.custom)}</option>}
            {TRACE_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {s.t(TRACE_PRESET_NAMES[id])}
              </option>
            ))}
          </select>
        </label>
        <label style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.mode)}</span>
          <select
            data-draw-image-trace-mode
            value={options.mode}
            onChange={(e) =>
              set("mode", e.target.value as Required<TraceOptions>["mode"])
            }
          >
            <option value="color">{s.t(M.modeColor)}</option>
            <option value="bw">{s.t(M.modeBw)}</option>
            <option value="centerline">{s.t(M.modeCenterline)}</option>
          </select>
        </label>
        <label style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.paths)}</span>
          <select
            data-draw-image-trace-paths
            value={options.pathMode}
            onChange={(e) =>
              set(
                "pathMode",
                e.target.value as Required<TraceOptions>["pathMode"],
              )
            }
          >
            <option value="spline">{s.t(M.pathsSpline)}</option>
            <option value="polygon">{s.t(M.pathsPolygon)}</option>
          </select>
        </label>
        {options.mode === "color" ? (
          <>
            <label style={rowStyle}>
              <span style={{ flex: 1 }}>{s.t(M.maxColors)}</span>
              <input
                type="number"
                min={0}
                max={256}
                style={numStyle}
                data-draw-image-trace-colors
                value={options.maxColors}
                onChange={(e) =>
                  set("maxColors", Math.max(0, Number(e.target.value) || 0))
                }
              />
            </label>
            <label style={rowStyle}>
              <input
                type="checkbox"
                data-draw-image-trace-grayscale
                checked={options.grayscale}
                onChange={(e) => set("grayscale", e.target.checked)}
              />
              <span>{s.t(M.grayscale)}</span>
            </label>
          </>
        ) : (
          <label style={rowStyle}>
            <span style={{ flex: 1 }}>{s.t(M.threshold)}</span>
            <input
              type="number"
              min={0}
              max={255}
              style={numStyle}
              data-draw-image-trace-threshold
              value={options.bwThreshold}
              onChange={(e) => set("bwThreshold", Number(e.target.value) || 0)}
            />
          </label>
        )}
        <label style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.speckle)}</span>
          <input
            type="number"
            min={0}
            style={numStyle}
            data-draw-image-trace-speckle
            value={options.filterSpeckle}
            onChange={(e) =>
              set("filterSpeckle", Math.max(0, Number(e.target.value) || 0))
            }
          />
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            data-draw-image-trace-ignore-white
            checked={options.ignoreWhite}
            onChange={(e) => set("ignoreWhite", e.target.checked)}
          />
          <span>{s.t(M.ignoreWhite)}</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            data-draw-image-trace-live
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          <span>{s.t(M.live)}</span>
        </label>
        <div style={{ ...rowStyle, paddingTop: 8 }}>
          <button
            type="button"
            style={buttonStyle}
            title={s.t(M.traceHint)}
            data-draw-image-trace-run
            onClick={() => void run(() => applyImageTrace(host, payload()))}
          >
            {s.t(M.trace)}
          </button>
          <button
            type="button"
            style={buttonStyle}
            title={s.t(M.retraceHint)}
            data-draw-image-trace-retrace
            disabled={traced === null}
            onClick={() => void run(() => applyRetraceImage(host, payload()))}
          >
            {s.t(M.retrace)}
          </button>
        </div>
        <div style={{ ...rowStyle, opacity: 0.7 }} data-draw-image-trace-status>
          {traced === null
            ? s.t(M.notTraced)
            : s.t(M.traced, {
                preset: presetName(
                  traced === "" ? null : (traced as TracePresetId),
                ),
              })}
        </div>
        <Refusal text={refusal} />
        <About attr="data-draw-image-trace-note">
          {s.t(IMAGE_TRACE_PANEL_NOTE)}
        </About>
      </div>
    );
  };
  return { title: t(M.title), component: Component, defaultDock: "right" };
}
