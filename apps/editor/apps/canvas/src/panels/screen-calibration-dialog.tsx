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

// View ▸ Calibrate screen size… (ADR 1201, D-12; editor ADR "Navigation
// history and one current page"). Calibrated size shows an inch of the
// document as an inch on this screen, which no browser can know: CSS
// says an inch is 96 CSS px, and a CSS px is whatever the screen, the
// system's display scaling and the browser's zoom make it. So the user
// measures: a ruler held to the screen, the bar stretched until it is
// exactly 10 cm (or 4 in) long. The bar's length in device pixels is the
// screen's density (`zoom-calibration.ts`), an editor preference; no
// document changes, so nothing here is an undo step.

import { useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import {
  calibratedScale,
  createValueStore,
  CSS_PX_PER_INCH,
  densityFromMeasurement,
  FocusScope,
  scoped,
  setScreenCalibration,
  useCamera,
  useEditorScope,
  useEscapeHandler,
  useScoped,
  useScreenCalibration,
  zoomCameraTo,
  type EditorScope,
} from "@paged-media/shell";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.screenCalibrationDialog", {
  title: "Calibrate screen size",
  instructions:
    "Hold a ruler against the screen and drag the slider until the bar " +
    "is exactly {length} long. Calibrated size then shows the document at " +
    "its printed size on this screen.",
  length: "Length",
  bar: "Bar length",
  density: "{dpi} device pixels per inch",
  notCalibrated: "Not calibrated: Calibrated size asks for this first.",
  forget: "Forget",
  cancel: "Cancel",
  save: "Save",
});

/** The reference lengths the bar can be measured against. */
const LENGTHS = {
  cm: { inches: 10 / 2.54, label: "10 cm" },
  in: { inches: 4, label: "4 in" },
} as const;
type LengthKey = keyof typeof LENGTHS;

interface OpenState {
  open: boolean;
  /** Apply Calibrated size once saved (opened from that command). */
  apply: boolean;
}

const OPEN = scoped("screenCalibrationDialog", () =>
  createValueStore<OpenState>({ open: false, apply: false }),
);

/** Open the calibration; `apply` zooms to Calibrated size on Save. */
export function openScreenCalibration(
  scope: EditorScope,
  opts: { apply?: boolean } = {},
): void {
  scope.get(OPEN).set({ open: true, apply: opts.apply ?? false });
}

export function ScreenCalibrationDialog() {
  const store = useScoped(OPEN);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return state.open ? <CalibrationForm apply={state.apply} /> : null;
}

/** The bar's CSS length for a density and a reference length. */
function barFor(
  devicePxPerInch: number | null,
  inches: number,
  dpr: number,
): number {
  const cssPerInch = devicePxPerInch ? devicePxPerInch / dpr : CSS_PX_PER_INCH;
  return Math.round(cssPerInch * inches);
}

const BAR_MIN_PX = 120;
const BAR_MAX_PX = 900;

function CalibrationForm({ apply }: { apply: boolean }) {
  const strings = useStrings();
  const scope = useEditorScope();
  const store = useScoped(OPEN);
  const stored = useScreenCalibration();
  const { peekCamera, setCamera, viewportSize } = useCamera();
  const dpr = globalThis.devicePixelRatio || 1;
  const [unit, setUnit] = useState<LengthKey>("cm");
  const [bar, setBar] = useState(() => barFor(stored, LENGTHS.cm.inches, dpr));
  const close = () => store.set({ open: false, apply: false });
  useEscapeHandler({
    id: "paged.screenCalibrationDialog",
    tier: "modal",
    isActive: () => true,
    resolve: () => close(),
  });
  const density = densityFromMeasurement(bar, LENGTHS[unit].inches, dpr);

  const switchUnit = (next: LengthKey) => {
    // Keep the measured density: the bar takes the new length's size.
    const keep = density ?? stored;
    setUnit(next);
    setBar(barFor(keep, LENGTHS[next].inches, dpr));
  };

  const save = () => {
    if (density === null) return;
    setScreenCalibration(scope, density);
    if (apply) {
      const scale = calibratedScale(density, dpr);
      if (scale !== null)
        setCamera(zoomCameraTo(peekCamera(), scale, viewportSize));
    }
    close();
  };

  return (
    <div
      data-screen-calibration-backdrop=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={backdropStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-calibration-title"
        data-screen-calibration-dialog=""
        data-panel-host=""
        style={dialogStyle}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2 id="screen-calibration-title" style={titleStyle}>
            {strings.t(M.title)}
          </h2>
          <p style={textStyle}>
            {strings.t(M.instructions, { length: LENGTHS[unit].label })}
          </p>
          <div
            role="radiogroup"
            aria-label={strings.t(M.length)}
            style={rowStyle}
          >
            {(Object.keys(LENGTHS) as LengthKey[]).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={unit === k}
                data-calibration-length={k}
                onClick={() => switchUnit(k)}
                style={{
                  ...segmentStyle,
                  background: unit === k ? color.primary : "transparent",
                  color: unit === k ? color.primaryFg : color.fg,
                }}
              >
                {LENGTHS[k].label}
              </button>
            ))}
          </div>
          <div style={barTrackStyle}>
            <div data-calibration-bar="" style={{ ...barStyle, width: bar }} />
          </div>
          <input
            type="range"
            data-calibration-slider=""
            aria-label={strings.t(M.bar)}
            min={BAR_MIN_PX}
            max={BAR_MAX_PX}
            step={1}
            value={bar}
            onChange={(e) => setBar(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <p data-calibration-density="" style={metaStyle}>
            {density !== null
              ? strings.t(M.density, { dpi: Math.round(density) })
              : strings.t(M.notCalibrated)}
          </p>
          <div style={footerStyle}>
            {stored !== null && (
              <button
                type="button"
                data-calibration-forget=""
                onClick={() => {
                  setScreenCalibration(scope, null);
                  close();
                }}
                style={secondaryStyle}
              >
                {strings.t(M.forget)}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button type="button" onClick={close} style={secondaryStyle}>
              {strings.t(M.cancel)}
            </button>
            <button
              type="button"
              data-calibration-save=""
              disabled={density === null}
              onClick={save}
              style={primaryStyle}
            >
              {strings.t(M.save)}
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
  width: `min(${BAR_MAX_PX + 32}px, 94vw)`,
  padding: 16,
  borderRadius: radius.lg,
  border: `1px solid ${color.border}`,
  background: color.elevated,
  color: color.fg,
  boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
  fontSize: 12,
};

const titleStyle: CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  fontWeight: 600,
};

const textStyle: CSSProperties = { margin: "0 0 10px", lineHeight: 1.45 };

const metaStyle: CSSProperties = {
  margin: "6px 0 0",
  color: color.mutedFg,
  fontVariantNumeric: "tabular-nums",
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  margin: "0 0 10px",
};

const segmentStyle: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: `1px solid ${color.border}`,
  cursor: "pointer",
  fontSize: 12,
};

const barTrackStyle: CSSProperties = {
  overflow: "hidden",
  padding: "8px 0",
};

const barStyle: CSSProperties = {
  height: 24,
  maxWidth: "100%",
  background: color.primary,
  borderLeft: `2px solid ${color.fg}`,
  borderRight: `2px solid ${color.fg}`,
};

const footerStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  marginTop: 14,
};

const secondaryStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: "transparent",
  color: color.fg,
};

const primaryStyle: CSSProperties = {
  ...secondaryStyle,
  background: color.primary,
  color: color.primaryFg,
};
