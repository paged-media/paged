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

// IMAGE TRACE PRESETS (WP6.6) — Illustrator's named presets, mapped onto
// the kernel's options. A preset is a STARTING POINT, not a mode: it is a
// full option set, the panel shows its values, and a payload (or the
// panel) overrides any of them. The trace record keeps the preset's id
// AND the resolved options, so a re-trace reproduces the trace exactly
// even if a preset's numbers change in a later release.
//
// How each maps, and what it costs (`crates/draw-trace`):
//   · the two PHOTO presets are the colour clusterer at high and low
//     precision — High Fidelity keeps detail (precision 8, small layer
//     difference, tiny speckle gate, a high region cap), Low Fidelity
//     merges aggressively;
//   · 3 / 6 / 16 COLORS snap the raster to that many colours first
//     (`maxColors`, a deterministic k-means in the kernel), then cluster;
//   · SHADES OF GRAY converts to luma and keeps 8 grey levels;
//   · BLACK AND WHITE LOGO, SKETCHED ART and SILHOUETTES are the
//     threshold mode at a crisp, a loose and a high threshold (a
//     silhouette is everything that is not paper);
//   · LINE ART and TECHNICAL DRAWING are the CENTRELINE mode: open
//     stroked paths down the middle of the ink, smooth for line art and
//     straight segments with sharp corners for a technical drawing.

import { defineMessages } from "@paged-media/strings";

import { TRACE_DEFAULTS, type TraceOptions } from "../trace-engine";

/** The preset ids, in Illustrator's menu order. */
export const TRACE_PRESET_IDS = [
  "default",
  "highFidelityPhoto",
  "lowFidelityPhoto",
  "colors3",
  "colors6",
  "colors16",
  "shadesOfGray",
  "blackAndWhiteLogo",
  "sketchedArt",
  "silhouettes",
  "lineArt",
  "technicalDrawing",
] as const;

export type TracePresetId = (typeof TRACE_PRESET_IDS)[number];

/** The preset names, message keys read in the editor's locale. */
export const TRACE_PRESET_NAMES = defineMessages("draw.tracePreset", {
  default: "Default",
  highFidelityPhoto: "High fidelity photo",
  lowFidelityPhoto: "Low fidelity photo",
  colors3: "3 colors",
  colors6: "6 colors",
  colors16: "16 colors",
  shadesOfGray: "Shades of gray",
  blackAndWhiteLogo: "Black and white logo",
  sketchedArt: "Sketched art",
  silhouettes: "Silhouettes",
  lineArt: "Line art",
  technicalDrawing: "Technical drawing",
});

/** What each preset changes from {@link TRACE_DEFAULTS}. */
const PRESET_DELTAS: Record<TracePresetId, Partial<TraceOptions>> = {
  default: {},
  highFidelityPhoto: {
    mode: "color",
    colorPrecision: 8,
    layerDifference: 6,
    filterSpeckle: 2,
    segmentLength: 3,
    maxRegions: 4000,
    ignoreWhite: false,
  },
  lowFidelityPhoto: {
    mode: "color",
    colorPrecision: 5,
    layerDifference: 28,
    filterSpeckle: 16,
    segmentLength: 6,
    maxRegions: 800,
    ignoreWhite: false,
  },
  colors3: {
    mode: "color",
    maxColors: 3,
    colorPrecision: 8,
    layerDifference: 1,
    filterSpeckle: 8,
    ignoreWhite: false,
  },
  colors6: {
    mode: "color",
    maxColors: 6,
    colorPrecision: 8,
    layerDifference: 1,
    filterSpeckle: 6,
    ignoreWhite: false,
  },
  colors16: {
    mode: "color",
    maxColors: 16,
    colorPrecision: 8,
    layerDifference: 1,
    filterSpeckle: 4,
    maxRegions: 1500,
    ignoreWhite: false,
  },
  shadesOfGray: {
    mode: "color",
    grayscale: true,
    maxColors: 8,
    colorPrecision: 8,
    layerDifference: 1,
    filterSpeckle: 6,
    ignoreWhite: false,
  },
  blackAndWhiteLogo: {
    mode: "bw",
    bwThreshold: 128,
    filterSpeckle: 8,
    cornerThresholdDeg: 45,
    ignoreWhite: true,
  },
  sketchedArt: {
    mode: "bw",
    bwThreshold: 160,
    filterSpeckle: 24,
    segmentLength: 6,
    ignoreWhite: true,
  },
  silhouettes: {
    mode: "bw",
    bwThreshold: 230,
    filterSpeckle: 32,
    segmentLength: 6,
    ignoreWhite: true,
  },
  lineArt: {
    mode: "centerline",
    bwThreshold: 128,
    filterSpeckle: 6,
    cornerThresholdDeg: 60,
    segmentLength: 4,
  },
  technicalDrawing: {
    mode: "centerline",
    pathMode: "polygon",
    bwThreshold: 128,
    filterSpeckle: 4,
    cornerThresholdDeg: 30,
    segmentLength: 2,
  },
};

export const isTracePreset = (v: unknown): v is TracePresetId =>
  typeof v === "string" && (TRACE_PRESET_IDS as readonly string[]).includes(v);

/** A preset's full option set. */
export function tracePresetOptions(id: TracePresetId): Required<TraceOptions> {
  return { ...TRACE_DEFAULTS, ...PRESET_DELTAS[id] };
}

/** The preset whose options EQUAL `options` (the decoder budget aside),
 *  or null — what the panel shows as "Custom". */
export function presetMatching(
  options: Required<TraceOptions>,
): TracePresetId | null {
  for (const id of TRACE_PRESET_IDS) {
    const p = tracePresetOptions(id);
    const same = (Object.keys(p) as (keyof TraceOptions)[]).every(
      (k) => k === "maxTracePixels" || p[k] === options[k],
    );
    if (same) return id;
  }
  return null;
}
