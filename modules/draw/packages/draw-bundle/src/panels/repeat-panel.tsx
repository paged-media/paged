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
  repeatLinks,
  resolveRepeat,
  REPEAT_CLIP_NOTE,
  REPEAT_DEFAULTS,
  REPEAT_FEATURE,
  REPEAT_KINDS,
  REPEAT_LIVE_NOTE,
  type RepeatParams,
  type RepeatRecord,
} from "../commands/repeat";

export const REPEAT_PANEL_ID = "media.paged.draw.panel.repeat";

/** What the panel says under the form, verbatim. Exported so the
 *  conformance spec pins the WORDING — an honesty note that can be
 *  edited away silently is not a guarantee. */
export const REPEAT_PANEL_NOTE =
  `${REPEAT_LIVE_NOTE} ${REPEAT_CLIP_NOTE} One more thing this form cannot ` +
  "hide: an UNCLIPPED repeat builds and updates in ONE undo step (the C-15 " +
  "bindCreated op names the ids a batch mints, so the inserts, the paint, " +
  "the links and the group all ride one batch), and a CLIPPED one costs " +
  "TWO — the pasteInto that clips is also what hides the instances from " +
  "the scene tree, so what was created has to be read back before it runs. " +
  "The recipe itself is a container write and is not on the undo stack at " +
  "all.";

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
const noteStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "6px 8px",
  border: "1px solid var(--pg-border, rgba(127,127,127,0.4))",
  borderRadius: 3,
  font: "11px/1.45 var(--font-sans, sans-serif)",
  opacity: 0.8,
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
    `${p.kind} · ${asked}${p.clip ? " · clipped" : ""} ` +
    `(${placed} instance${placed === 1 ? "" : "s"} placed)`
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
    const [draft, setDraft] = React.useState<RepeatParams>(REPEAT_DEFAULTS);

    const reload = React.useCallback(async () => {
      setPortable(host.supports(REPEAT_FEATURE));
      const library = await readRepeatLibrary(host);
      setRecords(library.repeats);
      setHasSelection(host.selection.get().length > 0);
      const id = await resolveRepeat(host, undefined);
      setActive(id);
      const tally: Record<string, number> = {};
      for (const record of library.repeats) {
        const links = await repeatLinks(host, record.id);
        tally[record.id] = links.instances.length;
      }
      setPlaced(tally);
      const saved = library.repeats.find((r) => r.id === id);
      if (saved) setDraft(saved.params);
    }, []);

    React.useEffect(() => {
      void reload();
      const subs = [
        host.selection.onDidChange(() => void reload()),
        host.document.onDidChange(() => void reload()),
      ];
      return () => {
        for (const s of subs) s.dispose();
      };
    }, [reload]);

    const run = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (e) {
        host.log.warn(`repeat panel: ${String(e)}`);
      }
      void reload();
    };

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
              title={`Build a ${kind} repeat from the selection`}
              data-draw-repeat-make={kind}
              disabled={!hasSelection}
              onClick={() =>
                void run(applyMakeRepeat(host, kind, { ...draft, kind }))
              }
            >
              + {kind}
            </button>
          ))}
        </div>

        {!portable && (
          <div style={mutedStyle} data-draw-repeat-degraded>
            This host wires no .paged container writer, so a repeat&apos;s
            parameters cannot be saved and CLIPPING is refused — a clipped
            instance is invisible to the scene tree, and the recipe is the only
            index that could find it again.
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
                {k}
              </option>
            ))}
          </select>
        </div>

        {draft.kind === "radial" && (
          <>
            <div style={sectionStyle}>Radial</div>
            {numberRow(
              "Instances (incl. the original)",
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
              "Rotate instances to the arc",
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
              "H spacing (pt, negative overlaps)",
              draft.spacing[0],
              (n) => setDraft({ ...draft, spacing: [n, draft.spacing[1]] }),
              "spacingX",
            )}
            {numberRow(
              "V spacing (pt, negative overlaps)",
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
          "Clip the instances to a frame",
          draft.clip,
          (b) => setDraft({ ...draft, clip: b }),
          "clip",
        )}
        {checkRow(
          "Keep instances on the page",
          draft.fitToArtboard,
          (b) => setDraft({ ...draft, fitToArtboard: b }),
          "fitToArtboard",
        )}

        {records.length === 0 ? (
          <div style={mutedStyle}>
            No repeats yet — select artwork and build one.
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
                  title="Rebuild this repeat with the parameters above and the sources' CURRENT geometry — every instance gets a new element id"
                  data-draw-repeat-update
                  onClick={() =>
                    void run(
                      applyUpdateRepeat(host, { repeatId: record.id, ...draft }),
                    )
                  }
                >
                  Update
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Select this repeat's instances"
                  data-draw-repeat-select
                  onClick={() =>
                    void run(
                      applySelectRepeatInstances(host, { repeatId: record.id }),
                    )
                  }
                >
                  Select
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Stop tracking and keep every instance as ordinary artwork"
                  data-draw-repeat-expand
                  onClick={() =>
                    void run(applyExpandRepeat(host, { repeatId: record.id }))
                  }
                >
                  Expand
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Remove every instance and keep the source exactly as it is"
                  data-draw-repeat-release
                  onClick={() =>
                    void run(applyReleaseRepeat(host, { repeatId: record.id }))
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

        <div style={noteStyle} data-draw-repeat-note>
          {REPEAT_PANEL_NOTE}
        </div>
      </div>
    );
  };
  return {
    title: "Repeat Options (draw)",
    component: Component,
    defaultDock: "right",
  };
}
