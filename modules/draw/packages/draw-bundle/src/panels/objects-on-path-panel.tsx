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

// The OBJECTS ON PATH panel — §16.3's distribution form. It exists as a
// panel for the B-01 reason the other expert-leaf panels do (a record
// list with per-row actions plus enums and numerics is above the schema
// panel's scalar binding ceiling), and it carries one thing the form
// itself cannot: `OBJECTS_ON_PATH_NOTE`, which states that this row
// MOVES your objects rather than copying them — the opposite of every
// other arranging feature in this bundle — and what the page rect costs
// if you switch the artboard fit off. Its wording is pinned by a
// conformance test.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import * as React from "react";

import {
  applyExpandObjectsOnPath,
  applyMakeObjectsOnPath,
  applyReleaseObjectsOnPath,
  applySelectObjectsOnPath,
  applyUpdateObjectsOnPath,
  objectsOnPathLinks,
  readObjectsOnPathLibrary,
  resolveObjectsOnPath,
  OBJECTS_ON_PATH_DEFAULTS,
  OBJECTS_ON_PATH_FEATURE,
  OBJECTS_ON_PATH_NOTE,
  ON_PATH_DISTRIBUTIONS,
  ON_PATH_PIVOTS,
  type ObjectsOnPathParams,
  type ObjectsOnPathRecord,
  type OnPathDistribute,
  type OnPathPivot,
} from "../commands/objects-on-path";

export const OBJECTS_ON_PATH_PANEL_ID = "media.paged.draw.panel.objectsOnPath";

/** What the panel says under the form, verbatim. Pinned by a test. */
export const OBJECTS_ON_PATH_PANEL_NOTE =
  `${OBJECTS_ON_PATH_NOTE} The undo arithmetic: make, update, expand and ` +
  "release are ONE undo step each — this lane never creates anything, so " +
  "there is no second batch anywhere on it and no bindCreated in sight. " +
  "The recipe itself is a container write and is not on the undo stack.";

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

/** The one-line summary a row shows. Pure — exported so the conformance
 *  spec pins the wording without a DOM. */
export function objectsOnPathRowLabel(
  record: ObjectsOnPathRecord,
  placed: number,
): string {
  const p = record.params;
  const how =
    p.distribute === "count"
      ? `${record.objects.length} even`
      : `every ${p.spacingPt} pt`;
  return (
    `${how}${p.alignToPath ? " · aligned" : ""} · pivot ${p.pivot}` +
    `${p.startOffsetPt !== 0 ? ` · offset ${p.startOffsetPt} pt` : ""}` +
    `${p.reverseOrder ? " · reversed" : ""} ` +
    `(${placed} object${placed === 1 ? "" : "s"} on the path)`
  );
}

export function makeObjectsOnPathPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const [records, setRecords] = React.useState<ObjectsOnPathRecord[]>([]);
    const [active, setActive] = React.useState<string | null>(null);
    const [placed, setPlaced] = React.useState<Record<string, number>>({});
    const [selected, setSelected] = React.useState(0);
    const [portable, setPortable] = React.useState(true);
    const [draft, setDraft] = React.useState<ObjectsOnPathParams>(
      OBJECTS_ON_PATH_DEFAULTS,
    );

    const reload = React.useCallback(async () => {
      setPortable(host.supports(OBJECTS_ON_PATH_FEATURE));
      const library = await readObjectsOnPathLibrary(host);
      setRecords(library.associations);
      setSelected(host.selection.get().length);
      const id = await resolveObjectsOnPath(host, undefined);
      setActive(id);
      const tally: Record<string, number> = {};
      for (const record of library.associations) {
        const links = await objectsOnPathLinks(host, record.id);
        tally[record.id] = links.objects.length;
      }
      setPlaced(tally);
      const saved = library.associations.find((r) => r.id === id);
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
        host.log.warn(`objects-on-path panel: ${String(e)}`);
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
          data-draw-onpath-field={attr}
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
        <label style={{ flex: 1 }} htmlFor={`draw-onpath-${attr}`}>
          {label}
        </label>
        <input
          id={`draw-onpath-${attr}`}
          type="checkbox"
          data-draw-onpath-toggle={attr}
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
      </div>
    );

    return (
      <div
        style={{ padding: 12 }}
        data-draw-onpath-panel={records.length}
        data-draw-onpath-portable={portable ? "true" : "false"}
        data-draw-onpath-active={active ?? ""}
      >
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Objects on Path ({records.length})
          </span>
          <button
            type="button"
            style={iconBtn}
            title="Put the selected objects on the LAST selected item — they MOVE onto it; nothing is copied"
            data-draw-onpath-make
            disabled={selected < 2}
            onClick={() => void run(applyMakeObjectsOnPath(host, { ...draft }))}
          >
            + On path
          </button>
        </div>

        <div style={mutedStyle}>
          Select the objects, then the PATH last — or pass a pathId.
        </div>

        {!portable && (
          <div style={mutedStyle} data-draw-onpath-degraded>
            This host wires no .paged container writer, so only the
            PARAMETERS are lost — each object remembers its own way home on
            its own link, so release and update still work.
          </div>
        )}

        <div style={sectionStyle}>Distribute</div>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>By</span>
          <select
            style={{ font: "12px var(--font-sans, sans-serif)" }}
            data-draw-onpath-distribute
            value={draft.distribute}
            onChange={(e) =>
              setDraft({
                ...draft,
                distribute: e.target.value as OnPathDistribute,
              })
            }
          >
            {ON_PATH_DISTRIBUTIONS.map((d) => (
              <option key={d} value={d}>
                {d === "count" ? "Count (evenly)" : "Spacing"}
              </option>
            ))}
          </select>
        </div>
        {draft.distribute === "count" ? (
          <div style={mutedStyle}>
            The count IS the number of associated objects — nothing here
            duplicates artwork. For more copies, use a Repeat.
          </div>
        ) : (
          numberRow(
            "Spacing (pt)",
            draft.spacingPt,
            (n) => setDraft({ ...draft, spacingPt: n }),
            "spacingPt",
          )
        )}
        {numberRow(
          "Move along path (pt)",
          draft.startOffsetPt,
          (n) => setDraft({ ...draft, startOffsetPt: n }),
          "startOffsetPt",
        )}

        <div style={sectionStyle}>Placement</div>
        {checkRow(
          "Align to the path",
          draft.alignToPath,
          (b) => setDraft({ ...draft, alignToPath: b }),
          "alignToPath",
        )}
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>Pivot</span>
          <select
            style={{ font: "12px var(--font-sans, sans-serif)" }}
            data-draw-onpath-pivot
            value={draft.pivot}
            onChange={(e) =>
              setDraft({ ...draft, pivot: e.target.value as OnPathPivot })
            }
          >
            {ON_PATH_PIVOTS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        {checkRow(
          "Reverse the order",
          draft.reverseOrder,
          (b) => setDraft({ ...draft, reverseOrder: b }),
          "reverseOrder",
        )}
        {checkRow(
          "Keep objects on the page",
          draft.fitToArtboard,
          (b) => setDraft({ ...draft, fitToArtboard: b }),
          "fitToArtboard",
        )}

        {records.length === 0 ? (
          <div style={mutedStyle}>
            Nothing on a path yet — select some objects, then the path.
          </div>
        ) : (
          records.map((record) => (
            <div key={record.id} data-draw-onpath-row={record.id}>
              <div style={{ ...rowStyle, paddingTop: 8 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={objectsOnPathRowLabel(record, placed[record.id] ?? 0)}
                >
                  {record.name}
                </span>
                <button
                  type="button"
                  style={iconBtn}
                  title="Re-distribute with the parameters above (every object is placed from its HOME transform, so this is idempotent)"
                  data-draw-onpath-update
                  onClick={() =>
                    void run(
                      applyUpdateObjectsOnPath(host, {
                        onPathId: record.id,
                        ...draft,
                      }),
                    )
                  }
                >
                  Update
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Select the objects on this path"
                  data-draw-onpath-select
                  onClick={() =>
                    void run(
                      applySelectObjectsOnPath(host, { onPathId: record.id }),
                    )
                  }
                >
                  Select
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Stop tracking and leave the objects on the path"
                  data-draw-onpath-expand
                  onClick={() =>
                    void run(
                      applyExpandObjectsOnPath(host, { onPathId: record.id }),
                    )
                  }
                >
                  Expand
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Put every object back exactly where it was"
                  data-draw-onpath-release
                  onClick={() =>
                    void run(
                      applyReleaseObjectsOnPath(host, { onPathId: record.id }),
                    )
                  }
                >
                  Release
                </button>
              </div>
              <div style={mutedStyle}>
                {objectsOnPathRowLabel(record, placed[record.id] ?? 0)}
              </div>
            </div>
          ))
        )}

        <div style={noteStyle} data-draw-onpath-note>
          {OBJECTS_ON_PATH_PANEL_NOTE}
        </div>
      </div>
    );
  };
  return {
    title: "Objects on path",
    component: Component,
    defaultDock: "right",
  };
}
