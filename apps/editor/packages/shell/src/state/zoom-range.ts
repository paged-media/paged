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

// One zoom range for every way the camera changes (ADR 246, the UX
// audit's F-31). Keyboard zoom, ctrl+wheel, the % field, the fit
// commands and a plugin's camera write all pass through
// `CameraProvider.setCamera`, which clamps here, so no input can take
// the view past what another input allows. InDesign's range: 5 % to
// 4,000 %.

import type { Camera } from "@paged-media/client";

/** The smallest camera scale (5 %). */
export const ZOOM_MIN_SCALE = 0.05;
/** The largest camera scale (4,000 %). */
export const ZOOM_MAX_SCALE = 40;

/** `scale` held inside the zoom range. */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.max(ZOOM_MIN_SCALE, Math.min(ZOOM_MAX_SCALE, scale));
}

/**
 * The camera with its scale held inside the zoom range. A clamped camera
 * keeps the document point at the viewport's centre where it was, so a
 * zoom that runs into a limit stops there rather than jumping; with no
 * measured viewport the origin is the fixed point.
 */
export function clampCamera(
  cam: Camera,
  viewport: readonly [number, number] = [0, 0],
): Camera {
  const scale = clampScale(cam.scale);
  if (scale === cam.scale) return cam;
  const cx = viewport[0] / 2;
  const cy = viewport[1] / 2;
  const docX = (cx - cam.tx) / cam.scale;
  const docY = (cy - cam.ty) / cam.scale;
  return { ...cam, scale, tx: cx - docX * scale, ty: cy - docY * scale };
}

/** Points per inch: the document's unit. */
export const PT_PER_INCH = 72;
/** CSS px per inch: an inch is 96 CSS px in every browser (CSS Values 4,
 *  absolute lengths). */
export const CSS_PX_PER_INCH = 96;

/**
 * Actual size (ADR 1201, D-12): a named view in which an inch of the
 * document measures 96 CSS px, about 133 %. It never redefines 100 %:
 * 100 % stays a camera scale of 1, a point per CSS px (an inch as 72 CSS
 * px), as in InDesign, so every percentage keeps its meaning. A CSS inch
 * is the browser's reference inch, not a measured one; the calibrated
 * size (`calibratedScale`) is the physical one.
 */
export const ACTUAL_SIZE_SCALE = CSS_PX_PER_INCH / PT_PER_INCH;

/**
 * The calibrated size (ADR 1201, D-12): the camera scale at which an inch
 * of the document measures an inch on this screen, from a calibration in
 * DEVICE pixels per physical inch (`zoom-calibration.ts`). Device pixels
 * per inch belong to the monitor, so the scale follows the browser's zoom
 * and the system's display scaling, which both change
 * `devicePixelRatio`; a window moved to another monitor needs another
 * calibration. Null without a usable calibration.
 */
export function calibratedScale(
  devicePxPerInch: number | null | undefined,
  devicePixelRatio = 1,
): number | null {
  if (
    devicePxPerInch == null ||
    !(devicePxPerInch > 0) ||
    !Number.isFinite(devicePxPerInch) ||
    !(devicePixelRatio > 0)
  )
    return null;
  return clampScale(devicePxPerInch / devicePixelRatio / PT_PER_INCH);
}

/** The zoom presets of the zoom drop-down (UX audit F-31, ADR 257), as
 *  camera scales, all inside the range. InDesign's menu, trimmed to the
 *  steps that are not one keyboard zoom apart. */
export const ZOOM_PRESET_SCALES: readonly number[] = [
  0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8,
];

/**
 * What the zoom field reads from typed text: a percentage ("150", "150 %",
 * "150%", "33.3", with a comma as the decimal separator too) as a camera
 * scale held inside the one range, or null for text that is not a
 * number. The field shows the clamped result, so 9,000 % reads back as
 * 4,000 %.
 */
export function parseZoomPercent(text: string): number | null {
  const cleaned = text.trim().replace(/\s*%$/, "").replace(",", ".");
  if (!/^[+]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const percent = Number(cleaned);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return clampScale(percent / 100);
}

/**
 * The camera at `scale` (clamped to the range) with the document point
 * at the viewport's centre kept where it is: a preset zooms about what
 * the user is looking at, as a keyboard zoom does. The same formula at
 * any view rotation.
 */
export function zoomCameraTo(
  cam: Camera,
  scale: number,
  viewport: readonly [number, number],
): Camera {
  const next = clampScale(scale);
  const cx = viewport[0] / 2;
  const cy = viewport[1] / 2;
  const docX = (cx - cam.tx) / cam.scale;
  const docY = (cy - cam.ty) / cam.scale;
  return { ...cam, scale: next, tx: cx - docX * next, ty: cy - docY * next };
}
