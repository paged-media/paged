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

// The screen calibration behind View ▸ Calibrated size (ADR 1201, D-12;
// editor ADR "Navigation history and one current page"). The user holds a
// ruler to the screen and stretches a bar to a known length; the bar's
// length in DEVICE pixels over that length in inches is this screen's
// pixel density. Device pixels belong to the monitor, so the calibration
// survives a change of the browser's zoom or of the system's display
// scaling (both change `devicePixelRatio`, which `calibratedScale`
// divides by). An editor preference under `paged.view.calibration`, read
// with a shape check (ADR 247); never a document change.

import { useSyncExternalStore } from "react";

import { isRecord, parseStored } from "../lib/stored-settings";
import {
  createValueStore,
  scoped,
  useScoped,
  type EditorScope,
  type ValueStore,
} from "./editor-scope";
import { editorStorage } from "./storage";

const STORAGE_KEY = "paged.view.calibration";

/** Device pixels per physical inch, or null when never calibrated. */
export type ScreenCalibration = number | null;

/** The plausible range of a screen's density, device px per inch: a
 *  projector at the low end, a phone at the high end. */
export const CALIBRATION_MIN_DPI = 40;
export const CALIBRATION_MAX_DPI = 1200;

function isDensity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= CALIBRATION_MIN_DPI &&
    value <= CALIBRATION_MAX_DPI
  );
}

function load(scope: EditorScope): ScreenCalibration {
  try {
    const stored = parseStored(editorStorage(scope).getItem(STORAGE_KEY));
    if (isRecord(stored) && isDensity(stored.devicePxPerInch))
      return stored.devicePxPerInch;
  } catch {
    /* storage unavailable: not calibrated */
  }
  return null;
}

const CALIBRATION = scoped(
  "zoomCalibration",
  (scope): ValueStore<ScreenCalibration> => createValueStore(load(scope)),
);

export function getScreenCalibration(scope: EditorScope): ScreenCalibration {
  return scope.get(CALIBRATION).get();
}

/** Remember this screen's density (null forgets it). An implausible
 *  value is refused. */
export function setScreenCalibration(
  scope: EditorScope,
  devicePxPerInch: ScreenCalibration,
): void {
  if (devicePxPerInch !== null && !isDensity(devicePxPerInch)) return;
  scope.get(CALIBRATION).set(devicePxPerInch);
  try {
    if (devicePxPerInch === null) editorStorage(scope).removeItem(STORAGE_KEY);
    else
      editorStorage(scope).setItem(
        STORAGE_KEY,
        JSON.stringify({ devicePxPerInch }),
      );
  } catch {
    /* persistence is a convenience only */
  }
}

/** This editor's calibration now. */
export function useScreenCalibration(): ScreenCalibration {
  const store = useScoped(CALIBRATION);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * The density a calibration bar gives: `barCssPx` CSS px measured as
 * `lengthInches` on the screen, at `devicePixelRatio`. Null when the
 * result is not a plausible screen.
 */
export function densityFromMeasurement(
  barCssPx: number,
  lengthInches: number,
  devicePixelRatio: number,
): ScreenCalibration {
  if (!(barCssPx > 0) || !(lengthInches > 0) || !(devicePixelRatio > 0))
    return null;
  const dpi = (barCssPx * devicePixelRatio) / lengthInches;
  return isDensity(dpi) ? dpi : null;
}
