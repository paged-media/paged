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

// The REPEAT OPTIONS panel — §12.4's parameters, the three make verbs,
// and the two that take a repeat apart again. Every knob here is a real
// `RepeatParams` field the recipe persists, and the buttons drive the
// SAME appliers the commands do — no second write path to drift from.
//
// An expert-leaf REACT panel for the Layers / Appearance / Graphic
// Styles / Symbols / Live Paint / Pattern reason (B-01): a list of
// records with per-row actions, plus an enum + numeric form, is above
// the v1 schema panel's scalar binding ceiling.
//
// The panel is ALSO where the two honesty notes are put in front of the
// user, because the word "repeat" promises a live linked object this
// engine has no node for, and "clipping" hides artwork from the scene
// tree. `REPEAT_LIVE_NOTE` and `REPEAT_CLIP_NOTE` say so verbatim and
// their wording is pinned by a conformance test.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import type { RepeatKind } from "@paged-media/draw-geometry";
import * as React from "react";

import {
  applyExpandRepeat,
  applyMakeRepeat,
  applyReleaseRepeat,
  applySelectRepeatInstances,
  applyUpdateRepeat,
  readRepeatLibrary,
  repeatInstanceCounts,
  resolveRepeat,
  REPEAT_DEFAULTS,
  REPEAT_FEATURE,
  REPEAT_KINDS,
  type RepeatParams,
  type RepeatRecord,
} from "../commands/repeat";
import { useFollowedDraft, usePanelReload } from "./use-panel-reload";
import {
  About,
  color,
  font,
  Refusal,
  useActionFeedback,
} from "@paged-media/panel-kit";
import { RecipeAutoUpdateToggle } from "./recipe-auto-update-toggle";
import { PanelIntro, tokenLabel } from "./panel-parts";
import { defineMessages, t, useStrings } from "@paged-media/strings";

const M = defineMessages("draw.repeatPanel", {
  summary:
    "Repeat the selected artwork around a circle, in a grid or as a mirror image; Update rebuilds the copies after you edit the original.",
  note: "A repeat makes real copies of the artwork and remembers how it built them. While Update automatically is on, editing the original rebuilds the copies in the same undo step; with it off, they move only when you choose Update. Dragging the on-canvas handle changes one setting and shows a guide; the copies are rebuilt when you let go, as one undo step. Clipping puts the copies inside a frame that crops them; a clipped repeat cannot be grouped, and the original stays outside the frame so you can keep editing it. Building or updating a repeat is one undo step, or two when it is clipped. Expand keeps the copies as ordinary artwork; Release removes them and keeps the original. The saved settings are kept outside undo.",
  rowAround: "{count} around {radius} pt",
  rowAxis: "axis {angle}°",
  rowClipped: " · clipped",
  rowPlaced: "({count, plural, one {# copy} other {# copies}} placed)",
  heading: "Repeats",
  buildHint: "Build a {kind} repeat from the selection",
  selectArtwork: "Select artwork first",
  degraded:
    "This editor cannot save data into the document, so repeat settings are not kept and clipping is not available.",
  kind: "Kind",
  repeat: "Repeat",
  radial: "Radial",
  copiesIncl: "Copies (including the original)",
  radius: "Radius (pt)",
  startAngle: "Start angle (°)",
  arc: "Arc (°, 360 = full ring)",
  rotate: "Rotate copies to follow the arc",
  grid: "Grid",
  columns: "Columns",
  rows: "Rows",
  hSpacing: "Horizontal spacing (pt, negative overlaps)",
  vSpacing: "Vertical spacing (pt, negative overlaps)",
  flipColumns: "Flip odd columns",
  flipRows: "Flip odd rows",
  mirror: "Mirror",
  axisAngle: "Axis angle (°, 90 = vertical)",
  axisOffset: "Axis offset (pt, blank = the edge)",
  frame: "Frame",
  clip: "Clip the copies to a frame",
  keepOnPage: "Keep copies on the page",
  empty:
    "No repeats yet. Select artwork and choose + Radial, + Grid or + Mirror.",
  updateHint:
    "Rebuild the copies with the settings above and the original's current shape",
  update: "Update",
  selectHint: "Select this repeat's copies",
  select: "Select",
  expandHint: "Stop tracking and keep every copy as ordinary artwork",
  expand: "Expand",
  releaseHint: "Remove every copy and keep the original",
  release: "Release",
  title: "Repeat options",
});

export const REPEAT_PANEL_ID = "media.paged.draw.panel.repeat";

/** What the panel is for, in one sentence (shown at the top). */
export const REPEAT_SUMMARY = M.summary;

/** The "About" text. Exported so the conformance spec pins the wording. */
export const REPEAT_PANEL_NOTE = M.note;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: `12px ${font.sans}`,
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0 3px",
  font: `12px ${font.sans}`,
  color: color.fg,
};
const sectionStyle: React.CSSProperties = {
  font: `11px ${font.sans}`,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.65,
  paddingTop: 8,
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: `12px ${font.sans}`,
};
const inputStyle: React.CSSProperties = {
  width: 64,
  font: `12px ${font.sans}`,
};

/** The one-line summary a repeat row shows: its kind, what it asked for
 *  and how many instances are actually on the page. Pure — exported so
 *  the conformance spec pins the wording without a DOM. */
export function repeatRowLabel(record: RepeatRecord, placed: number): string {
  const p = record.params;
  const asked =
    p.kind === "radial"
      ? t(M.rowAround, { count: p.count, radius: Math.round(p.radiusPt) })
      : p.kind === "grid"
        ? `${p.columns} × ${p.rows}`
        : t(M.rowAxis, { angle: Math.round(p.angleDeg) });
  return (
    `${tokenLabel(p.kind)} · ${asked}${p.clip ? t(M.rowClipped) : ""} ` +
    t(M.rowPlaced, { count: placed })
  );
}

export function makeRepeatPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    const [records, setRecords] = React.useState<RepeatRecord[]>([]);
    const [active, setActive] = React.useState<string | null>(null);
    const [placed, setPlaced] = React.useState<Record<string, number>>({});
    const [hasSelection, setHasSelection] = React.useState(false);
    const [portable, setPortable] = React.useState(true);
    const [draft, setDraft, followDraft] =
      useFollowedDraft<RepeatParams>(REPEAT_DEFAULTS);

    // WHAT A RELOAD COSTS (`test/panels/repeat-panel.dom.test.tsx`, and it
    // may only go down): the recipe part once, and the document's links
    // once per document REVISION, tallied for every record in one pass.
    // It used to walk the whole document — and re-read the recipe — once
    // per RECORD, on every event.
    const reload = usePanelReload(
      host,
      "repeat",
      async ({ live, selection }) => {
        const library = await readRepeatLibrary(host);
        if (!live()) return;
        const id = await resolveRepeat(host, undefined, library);
        if (!live()) return;
        const tally = await repeatInstanceCounts(host, library);
        if (!live()) return;
        setPortable(host.supports(REPEAT_FEATURE));
        setRecords(library.repeats);
        setHasSelection(selection.length > 0);
        setActive(id);
        setPlaced(tally);
        const saved = library.repeats.find((r) => r.id === id);
        if (saved) followDraft(saved.id, saved.params);
      },
    );

    const { refusal, run } = useActionFeedback(host, reload, "draw panel");

    const numberRow = (
      label: string,
      value: number,
      onChange: (n: number) => void,
      attr: string,
      step = 1,
    ) => (
      <div style={rowStyle}>
        <span style={{ flex: 1 }}>{label}</span>
        <input
          type="number"
          step={step}
          style={inputStyle}
          data-draw-repeat-field={attr}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    );

    const checkRow = (
      label: string,
      value: boolean,
      onChange: (b: boolean) => void,
      attr: string,
    ) => (
      <div style={rowStyle}>
        <label style={{ flex: 1 }} htmlFor={`draw-repeat-${attr}`}>
          {label}
        </label>
        <input
          id={`draw-repeat-${attr}`}
          type="checkbox"
          data-draw-repeat-toggle={attr}
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
      </div>
    );

    return (
      <div
        style={{ padding: 12 }}
        data-draw-repeat-panel={records.length}
        data-draw-repeat-portable={portable ? "true" : "false"}
        data-draw-repeat-active={active ?? ""}
      >
        <PanelIntro
          summary={s.t(REPEAT_SUMMARY)}
          attr="data-draw-repeat-intro"
        />
        <RecipeAutoUpdateToggle host={host} panel="repeat" />
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            {s.t(M.heading)} ({records.length})
          </span>
        </div>
        <div style={rowStyle}>
          {REPEAT_KINDS.map((kind: RepeatKind) => (
            <button
              key={kind}
              type="button"
              style={iconBtn}
              title={
                hasSelection
                  ? s.t(M.buildHint, { kind: tokenLabel(kind) })
                  : s.t(M.selectArtwork)
              }
              data-draw-repeat-make={kind}
              disabled={!hasSelection}
              onClick={() =>
                void run(() => applyMakeRepeat(host, kind, { ...draft, kind }))
              }
            >
              + {tokenLabel(kind)}
            </button>
          ))}
        </div>

        <Refusal text={refusal} />

        {!portable && (
          <div style={mutedStyle} data-draw-repeat-degraded>
            {s.t(M.degraded)}
          </div>
        )}

        <div style={sectionStyle}>{s.t(M.kind)}</div>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.repeat)}</span>
          <select
            style={{ font: `12px ${font.sans}` }}
            data-draw-repeat-kind
            value={draft.kind}
            onChange={(e) =>
              setDraft({ ...draft, kind: e.target.value as RepeatKind })
            }
          >
            {REPEAT_KINDS.map((k) => (
              <option key={k} value={k}>
                {tokenLabel(k)}
              </option>
            ))}
          </select>
        </div>

        {draft.kind === "radial" && (
          <>
            <div style={sectionStyle}>{s.t(M.radial)}</div>
            {numberRow(
              s.t(M.copiesIncl),
              draft.count,
              (n) => setDraft({ ...draft, count: n }),
              "count",
            )}
            {numberRow(
              s.t(M.radius),
              draft.radiusPt,
              (n) => setDraft({ ...draft, radiusPt: n }),
              "radiusPt",
            )}
            {numberRow(
              s.t(M.startAngle),
              draft.startDeg,
              (n) => setDraft({ ...draft, startDeg: n }),
              "startDeg",
            )}
            {numberRow(
              s.t(M.arc),
              draft.sweepDeg,
              (n) => setDraft({ ...draft, sweepDeg: n }),
              "sweepDeg",
            )}
            {checkRow(
              s.t(M.rotate),
              draft.rotateInstances,
              (b) => setDraft({ ...draft, rotateInstances: b }),
              "rotateInstances",
            )}
          </>
        )}

        {draft.kind === "grid" && (
          <>
            <div style={sectionStyle}>{s.t(M.grid)}</div>
            {numberRow(
              s.t(M.columns),
              draft.columns,
              (n) => setDraft({ ...draft, columns: n }),
              "columns",
            )}
            {numberRow(
              s.t(M.rows),
              draft.rows,
              (n) => setDraft({ ...draft, rows: n }),
              "rows",
            )}
            {numberRow(
              s.t(M.hSpacing),
              draft.spacing[0],
              (n) => setDraft({ ...draft, spacing: [n, draft.spacing[1]] }),
              "spacingX",
            )}
            {numberRow(
              s.t(M.vSpacing),
              draft.spacing[1],
              (n) => setDraft({ ...draft, spacing: [draft.spacing[0], n] }),
              "spacingY",
            )}
            {checkRow(
              s.t(M.flipColumns),
              draft.flipColumns,
              (b) => setDraft({ ...draft, flipColumns: b }),
              "flipColumns",
            )}
            {checkRow(
              s.t(M.flipRows),
              draft.flipRows,
              (b) => setDraft({ ...draft, flipRows: b }),
              "flipRows",
            )}
          </>
        )}

        {draft.kind === "mirror" && (
          <>
            <div style={sectionStyle}>{s.t(M.mirror)}</div>
            {numberRow(
              s.t(M.axisAngle),
              draft.angleDeg,
              (n) => setDraft({ ...draft, angleDeg: n }),
              "angleDeg",
            )}
            {numberRow(
              s.t(M.axisOffset),
              draft.offsetPt ?? 0,
              (n) => setDraft({ ...draft, offsetPt: n }),
              "offsetPt",
            )}
          </>
        )}

        <div style={sectionStyle}>{s.t(M.frame)}</div>
        {checkRow(
          s.t(M.clip),
          draft.clip,
          (b) => setDraft({ ...draft, clip: b }),
          "clip",
        )}
        {checkRow(
          s.t(M.keepOnPage),
          draft.fitToArtboard,
          (b) => setDraft({ ...draft, fitToArtboard: b }),
          "fitToArtboard",
        )}

        {records.length === 0 ? (
          <div style={mutedStyle}>{s.t(M.empty)}</div>
        ) : (
          records.map((record) => (
            <div key={record.id} data-draw-repeat-row={record.id}>
              <div style={{ ...rowStyle, paddingTop: 8 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={repeatRowLabel(record, placed[record.id] ?? 0)}
                >
                  {record.name}
                </span>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.updateHint)}
                  data-draw-repeat-update
                  onClick={() =>
                    void run(() =>
                      applyUpdateRepeat(host, {
                        repeatId: record.id,
                        ...draft,
                      }),
                    )
                  }
                >
                  {s.t(M.update)}
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.selectHint)}
                  data-draw-repeat-select
                  onClick={() =>
                    void run(() =>
                      applySelectRepeatInstances(host, { repeatId: record.id }),
                    )
                  }
                >
                  {s.t(M.select)}
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.expandHint)}
                  data-draw-repeat-expand
                  onClick={() =>
                    void run(() =>
                      applyExpandRepeat(host, { repeatId: record.id }),
                    )
                  }
                >
                  {s.t(M.expand)}
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.releaseHint)}
                  data-draw-repeat-release
                  onClick={() =>
                    void run(() =>
                      applyReleaseRepeat(host, { repeatId: record.id }),
                    )
                  }
                >
                  {s.t(M.release)}
                </button>
              </div>
              <div style={mutedStyle}>
                {repeatRowLabel(record, placed[record.id] ?? 0)}
              </div>
            </div>
          ))
        )}

        <About attr="data-draw-repeat-note">{s.t(REPEAT_PANEL_NOTE)}</About>
      </div>
    );
  };
  return {
    title: t(M.title),
    component: Component,
    defaultDock: "right",
  };
}
