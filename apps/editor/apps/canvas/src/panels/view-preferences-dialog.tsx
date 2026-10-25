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

// View ▸ Guides & grid preferences… (editor ADR 287) — Illustrator's
// Preferences ▸ Guides & Grid and ▸ Smart Guides in one dialog: the
// document grid's spacing, subdivisions, colour and stacking, the snap
// tolerance and the smart guides' options. Editor preferences
// (`view-preferences.ts`, localStorage): every change applies at once and
// is no undo step — the dialog changes no document.

import { useEffect, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  createValueStore,
  FocusScope,
  scoped,
  setViewPreferences,
  useScoped,
  useViewPreferences,
  type EditorScope,
} from "@paged-media/shell";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";
import { formatLength, parseLengthText } from "@paged-media/ui";

const M = defineMessages("app.viewPreferencesDialog", {
  title: "Guides & grid",
  grid: "Grid",
  gridEvery: "Gridline every",
  subdivisions: "Subdivisions",
  gridColor: "Colour",
  gridsInBack: "Grids in back",
  smartGuides: "Smart guides",
  angleGuides: "Construction guides (45°)",
  customAngle: "Custom angle",
  spacing: "Equal spacing",
  rotateSnap: "Snap rotation to angles",
  intersections: "Intersections",
  measurementLabels: "Measurement labels",
  tolerance: "Snapping tolerance",
  done: "Done",
});

/** Whether the dialog is open, per editor. */
const OPEN = scoped("viewPreferencesDialog", () => createValueStore(false));

export function openViewPreferences(scope: EditorScope): void {
  scope.get(OPEN).set(true);
}

export function ViewPreferencesDialog() {
  const store = useScoped(OPEN);
  const open = useSyncExternalStore(store.subscribe, store.get, store.get);
  return open ? <ViewPreferencesForm /> : null;
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <label style={rowStyle}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function ViewPreferencesForm() {
  const strings = useStrings();
  const store = useScoped(OPEN);
  const prefs = useViewPreferences();
  const close = () => store.set(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const check = (
    key:
      | "gridsInBack"
      | "angleGuides"
      | "spacing"
      | "rotateSnap"
      | "intersections"
      | "measurementLabels",
    label: string,
  ) => (
    <label style={checkStyle}>
      <input
        type="checkbox"
        data-view-pref={key}
        checked={prefs[key]}
        onChange={(e) => setViewPreferences({ [key]: e.target.checked })}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div
      data-view-preferences-backdrop=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={backdropStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="view-preferences-title"
        data-view-preferences-dialog=""
        data-panel-host=""
        style={dialogStyle}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2 id="view-preferences-title" style={titleStyle}>
            {strings.t(M.title)}
          </h2>
          <h3 style={sectionStyle}>{strings.t(M.grid)}</h3>
          <Row label={strings.t(M.gridEvery)}>
            <input
              type="text"
              data-view-pref="gridEvery"
              key={`every-${prefs.gridEvery}`}
              defaultValue={formatLength(prefs.gridEvery)}
              onBlur={(e) => {
                const pt = parseLengthText(e.target.value);
                if (pt != null && pt > 0) setViewPreferences({ gridEvery: pt });
                else e.target.value = formatLength(prefs.gridEvery);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              style={inputStyle}
            />
          </Row>
          <Row label={strings.t(M.subdivisions)}>
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              data-view-pref="gridSubdivisions"
              value={prefs.gridSubdivisions}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (n >= 1 && n <= 100)
                  setViewPreferences({ gridSubdivisions: n });
              }}
              style={inputStyle}
            />
          </Row>
          <Row label={strings.t(M.gridColor)}>
            <input
              type="color"
              data-view-pref="gridColor"
              value={prefs.gridColor}
              onChange={(e) =>
                setViewPreferences({ gridColor: e.target.value })
              }
              style={{ ...inputStyle, padding: 0, height: 24 }}
            />
          </Row>
          {check("gridsInBack", strings.t(M.gridsInBack))}
          <h3 style={sectionStyle}>{strings.t(M.smartGuides)}</h3>
          {check("angleGuides", strings.t(M.angleGuides))}
          <Row label={strings.t(M.customAngle)}>
            <input
              type="number"
              step={1}
              data-view-pref="customAngle"
              value={prefs.customAngle ?? ""}
              placeholder="–"
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (raw === "") setViewPreferences({ customAngle: null });
                else if (Number.isFinite(Number(raw)))
                  setViewPreferences({ customAngle: Number(raw) });
              }}
              style={inputStyle}
            />
          </Row>
          {check("spacing", strings.t(M.spacing))}
          {check("rotateSnap", strings.t(M.rotateSnap))}
          {check("intersections", strings.t(M.intersections))}
          {check("measurementLabels", strings.t(M.measurementLabels))}
          <Row label={strings.t(M.tolerance)}>
            <input
              type="number"
              min={1}
              max={20}
              step={1}
              data-view-pref="tolerancePx"
              value={prefs.tolerancePx}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n > 0 && n <= 20) setViewPreferences({ tolerancePx: n });
              }}
              style={inputStyle}
            />
          </Row>
          <div style={footerStyle}>
            <button
              type="button"
              data-view-preferences-done=""
              onClick={close}
              style={buttonStyle}
            >
              {strings.t(M.done)}
            </button>
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "grid",
  placeItems: "center",
  background: "rgba(0,0,0,0.5)",
};

const dialogStyle: CSSProperties = {
  width: "min(340px, 92vw)",
  padding: 16,
  borderRadius: radius.lg,
  border: `1px solid ${color.border}`,
  background: color.elevated,
  color: color.fg,
  boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
  fontSize: 12,
};

const titleStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 14,
  fontWeight: 600,
};

const sectionStyle: CSSProperties = {
  margin: "12px 0 6px",
  fontSize: 12,
  fontWeight: 600,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  margin: "4px 0",
};

const checkStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  margin: "4px 0",
};

const inputStyle: CSSProperties = {
  width: 96,
  padding: "3px 6px",
  borderRadius: 5,
  border: `1px solid ${color.border}`,
  background: color.bg,
  color: color.fg,
  fontSize: 12,
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  marginTop: 14,
};

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: color.primary,
  color: color.primaryFg,
};
