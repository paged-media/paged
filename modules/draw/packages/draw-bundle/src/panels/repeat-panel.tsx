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
  humanize,
  PanelAbout,
  PanelIntro,
  Refusal,
  useActionFeedback,
} from "./panel-kit";

export const REPEAT_PANEL_ID = "media.paged.draw.panel.repeat";

/** What the panel is for, in one sentence (shown at the top). */
export const REPEAT_SUMMARY =
  "Repeat the selected artwork around a circle, in a grid or as a mirror " +
  "image; Update rebuilds the copies after you edit the original.";

/** The "About" text. Exported so the conformance spec pins the wording. */
export const REPEAT_PANEL_NOTE =
  "A repeat makes real copies of the artwork and remembers how it built " +
  "them. Editing the original does not move the copies until you choose " +
  "Update. Dragging the on-canvas handle changes one setting and shows a " +
  "guide; the copies are rebuilt when you let go, as one undo step. " +
  "Clipping puts the copies inside a frame that crops them; a clipped " +
  "repeat cannot be grouped, and the original stays outside the frame so " +
  "you can keep editing it. Building or updating a repeat is one undo " +
  "step, or two when it is clipped. Expand keeps the copies as ordinary " +
  "artwork; Release removes them and keeps the original. The saved " +
  "settings are kept outside undo.";

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: "12px var(--font-sans, sans-serif)",
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0 3px",
  font: "12px var(--font-sans, sans-serif)",
  color: "var(--pg-fg, currentColor)",
};
const sectionStyle: React.CSSProperties = {
  font: "11px var(--font-sans, sans-serif)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.65,
  paddingTop: 8,
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: "12px var(--font-sans, sans-serif)",
};
const inputStyle: React.CSSProperties = {
  width: 64,
  font: "12px var(--font-sans, sans-serif)",
};

/** The one-line summary a repeat row shows: its kind, what it asked for
 *  and how many instances are actually on the page. Pure — exported so
 *  the conformance spec pins the wording without a DOM. */
export function repeatRowLabel(record: RepeatRecord, placed: number): string {
  const p = record.params;
  const asked =
    p.kind === "radial"
      ? `${p.count} around ${Math.round(p.radiusPt)} pt`
      : p.kind === "grid"
        ? `${p.columns} × ${p.rows}`
        : `axis ${Math.round(p.angleDeg)}°`;
  return (
    `${humanize(p.kind)} · ${asked}${p.clip ? " · clipped" : ""} ` +
    `(${placed} cop${placed === 1 ? "y" : "ies"} placed)`
  );
}

export function makeRepeatPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const [records, setRecords] = React.useState<RepeatRecord[]>([]);
    const [active, setActive] = React.useState<string | null>(null);
    const [placed, setPlaced] = React.useState<Record<string, number>>({});
    const [hasSelection, setHasSelection] = React.useState(false);
    const [portable, setPortable] = React.useState(true);
    const [draft, setDraft, followDraft] =
      useFollowedDraft<RepeatParams>(REPEAT_DEFAULTS);

    // WHAT A RELOAD COSTS (`test/panels/repeat-panel.spec.tsx`, and it
    // may only go down): the recipe part once, and the document's links
    // once per document REVISION, tallied for every record in one pass.
    // It used to walk the whole document — and re-read the recipe — once
    // per RECORD, on every event.
    const reload = usePanelReload(host, "repeat", async ({ live, selection }) => {
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
    });

    const { refusal, run } = useActionFeedback(host, reload);

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
        <PanelIntro summary={REPEAT_SUMMARY} attr="data-draw-repeat-intro" />
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Repeats ({records.length})
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
                  ? `Build a ${kind} repeat from the selection`
                  : "Select artwork first"
              }
              data-draw-repeat-make={kind}
              disabled={!hasSelection}
              onClick={() =>
                void run(() => applyMakeRepeat(host, kind, { ...draft, kind }))
              }
            >
              + {humanize(kind)}
            </button>
          ))}
        </div>

        <Refusal text={refusal} />

        {!portable && (
          <div style={mutedStyle} data-draw-repeat-degraded>
            This editor cannot save data into the document, so repeat settings
            are not kept and clipping is not available.
          </div>
        )}

        <div style={sectionStyle}>Kind</div>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>Repeat</span>
          <select
            style={{ font: "12px var(--font-sans, sans-serif)" }}
            data-draw-repeat-kind
            value={draft.kind}
            onChange={(e) =>
              setDraft({ ...draft, kind: e.target.value as RepeatKind })
            }
          >
            {REPEAT_KINDS.map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
              </option>
            ))}
          </select>
        </div>

        {draft.kind === "radial" && (
          <>
            <div style={sectionStyle}>Radial</div>
            {numberRow(
              "Copies (including the original)",
              draft.count,
              (n) => setDraft({ ...draft, count: n }),
              "count",
            )}
            {numberRow(
              "Radius (pt)",
              draft.radiusPt,
              (n) => setDraft({ ...draft, radiusPt: n }),
              "radiusPt",
            )}
            {numberRow(
              "Start angle (°)",
              draft.startDeg,
              (n) => setDraft({ ...draft, startDeg: n }),
              "startDeg",
            )}
            {numberRow(
              "Arc (°, 360 = full ring)",
              draft.sweepDeg,
              (n) => setDraft({ ...draft, sweepDeg: n }),
              "sweepDeg",
            )}
            {checkRow(
              "Rotate copies to follow the arc",
              draft.rotateInstances,
              (b) => setDraft({ ...draft, rotateInstances: b }),
              "rotateInstances",
            )}
          </>
        )}

        {draft.kind === "grid" && (
          <>
            <div style={sectionStyle}>Grid</div>
            {numberRow(
              "Columns",
              draft.columns,
              (n) => setDraft({ ...draft, columns: n }),
              "columns",
            )}
            {numberRow(
              "Rows",
              draft.rows,
              (n) => setDraft({ ...draft, rows: n }),
              "rows",
            )}
            {numberRow(
              "Horizontal spacing (pt, negative overlaps)",
              draft.spacing[0],
              (n) => setDraft({ ...draft, spacing: [n, draft.spacing[1]] }),
              "spacingX",
            )}
            {numberRow(
              "Vertical spacing (pt, negative overlaps)",
              draft.spacing[1],
              (n) => setDraft({ ...draft, spacing: [draft.spacing[0], n] }),
              "spacingY",
            )}
            {checkRow(
              "Flip odd columns",
              draft.flipColumns,
              (b) => setDraft({ ...draft, flipColumns: b }),
              "flipColumns",
            )}
            {checkRow(
              "Flip odd rows",
              draft.flipRows,
              (b) => setDraft({ ...draft, flipRows: b }),
              "flipRows",
            )}
          </>
        )}

        {draft.kind === "mirror" && (
          <>
            <div style={sectionStyle}>Mirror</div>
            {numberRow(
              "Axis angle (°, 90 = vertical)",
              draft.angleDeg,
              (n) => setDraft({ ...draft, angleDeg: n }),
              "angleDeg",
            )}
            {numberRow(
              "Axis offset (pt, blank = the edge)",
              draft.offsetPt ?? 0,
              (n) => setDraft({ ...draft, offsetPt: n }),
              "offsetPt",
            )}
          </>
        )}

        <div style={sectionStyle}>Frame</div>
        {checkRow(
          "Clip the copies to a frame",
          draft.clip,
          (b) => setDraft({ ...draft, clip: b }),
          "clip",
        )}
        {checkRow(
          "Keep copies on the page",
          draft.fitToArtboard,
          (b) => setDraft({ ...draft, fitToArtboard: b }),
          "fitToArtboard",
        )}

        {records.length === 0 ? (
          <div style={mutedStyle}>
            No repeats yet. Select artwork and choose + Radial, + Grid or
            + Mirror.
          </div>
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
                  title="Rebuild the copies with the settings above and the original's current shape"
                  data-draw-repeat-update
                  onClick={() =>
                    void run(() => applyUpdateRepeat(host, { repeatId: record.id, ...draft }),
                    )
                  }
                >
                  Update
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Select this repeat's copies"
                  data-draw-repeat-select
                  onClick={() =>
                    void run(() => applySelectRepeatInstances(host, { repeatId: record.id }),
                    )
                  }
                >
                  Select
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Stop tracking and keep every copy as ordinary artwork"
                  data-draw-repeat-expand
                  onClick={() =>
                    void run(() => applyExpandRepeat(host, { repeatId: record.id }))
                  }
                >
                  Expand
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Remove every copy and keep the original"
                  data-draw-repeat-release
                  onClick={() =>
                    void run(() => applyReleaseRepeat(host, { repeatId: record.id }))
                  }
                >
                  Release
                </button>
              </div>
              <div style={mutedStyle}>
                {repeatRowLabel(record, placed[record.id] ?? 0)}
              </div>
            </div>
          ))
        )}

        <PanelAbout text={REPEAT_PANEL_NOTE} attr="data-draw-repeat-note" />
      </div>
    );
  };
  return {
    title: "Repeat options",
    component: Component,
    defaultDock: "right",
  };
}
