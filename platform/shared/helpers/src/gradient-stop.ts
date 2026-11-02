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

// MOVING ONE STOP OF A GRADIENT — the `editGradient` spec for a gradient
// read as detail, with stop `index` at a new location and every other field
// exactly as read (an opacity stop keeps its opacity, an inline stop its
// colour). One implementation (PM-0017): the editor's Gradient tool writes
// it when a stop marker is dragged on the canvas.

/** One stop as the engine reads it (the fields a write must carry). */
export interface GradientStopRead {
  stopColorRef: string;
  locationPct: number;
  midpointPct?: number | null;
  opacityPct?: number | null;
  color?: { space: string; value: number[] } | null;
}

/** A gradient as the engine reads it. */
export interface GradientRead {
  selfId: string;
  name: string;
  /** "linear" | "radial" | "conic" | "unknown" (any case). */
  kind: string;
  stops: readonly GradientStopRead[];
}

/** The spec an `editGradient` writes, or `null` for a kind the engine
 *  reports as "unknown" (a write must not guess the ramp type) or an index
 *  out of range. Pure. */
export function gradientSpecWithStop(
  detail: GradientRead,
  index: number,
  locationPct: number,
) {
  const kind = (
    { linear: "Linear", radial: "Radial", conic: "Conic" } as const
  )[detail.kind.toLowerCase() as "linear" | "radial" | "conic"];
  if (!kind || index < 0 || index >= detail.stops.length) return null;
  return {
    selfId: detail.selfId,
    name: detail.name,
    kind,
    stops: detail.stops.map((s, i) => ({
      stopColor: s.color ? "" : s.stopColorRef,
      locationPct: i === index ? locationPct : s.locationPct,
      ...(s.midpointPct !== null && s.midpointPct !== undefined
        ? { midpointPct: s.midpointPct }
        : {}),
      ...(s.opacityPct !== null && s.opacityPct !== undefined
        ? { opacityPct: s.opacityPct }
        : {}),
      ...(s.color ? { color: s.color } : {}),
    })),
  };
}
