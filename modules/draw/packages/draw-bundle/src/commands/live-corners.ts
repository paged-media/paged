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

// Live Corners — rounded/beveled/etc. corner editing on a selected
// rectangle (concept §13.2 "Corner editing" + §13.3, Tier B). The wire
// already carries the per-corner PropertyPaths
// (`frameCornerOption{TopLeft,TopRight,BottomLeft,BottomRight}` +
// `frameCornerRadius{...}`), so each preset is a COMMAND that commits one
// `batch` of eight `setElementProperty` writes (the four options + the
// four radii) per selected rectangle — one undoable step — AND stamps a
// `liveCorners` flag into this plugin's metadata envelope so re-opening in
// Paged knows the rectangle's corners are plugin-managed (the §13.3
// metadata-baked "live" marker; the baked IDML corners are always valid).
//
// ENGINE GAP, named (the task's "be honest about what needs an engine op
// that doesn't exist yet"): the apply layer accepts `frameCornerOption*` /
// `frameCornerRadius*` ONLY on `NodeId::Rectangle` (verified in
// core paged-mutate `apply/set_property.rs` — the match arm is
// `NodeId::Rectangle(id)`). A POLYGON has corners too (Illustrator's Live
// Corners works on any path corner), but the engine has no apply arm for
// polygon corner options/radii — RFI gap B-23. So this command targets
// rectangles; a polygon in the selection is skipped with a debug log
// (never a throw). Per-corner editing (different radius per corner) is on
// the wire and supported by `cornerRadiiMutationFor`; the preset commands
// set a UNIFORM radius across the four corners (the common case), and the
// builder is exported so a future on-canvas handle drives one corner.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

export const LIVE_CORNERS_COMMAND_CATEGORY = "Corners";

/** The IDML corner-option tokens the engine's `CornerOption::from_idml`
 *  accepts (verified in core paged-parse `spread.rs`). The empty string
 *  clears the option to `None` (the apply layer's `is_empty()` arm). */
export type CornerStyleToken =
  | "None"
  | "RoundedCorner"
  | "InverseRoundedCorner"
  | "InsetCorner"
  | "BeveledCorner"
  | "FancyCorner";

/** A named live-corner preset: a corner STYLE + a default uniform RADIUS
 *  in pt. */
export interface LiveCornerPreset {
  /** The namespaced command id (under the manifest id). */
  id: string;
  /** The menu/command title. */
  title: string;
  /** The IDML corner-option token applied to all four corners. */
  style: CornerStyleToken;
  /** The uniform radius in pt the preset applies (ignored / 0 for the
   *  None preset, which squares the corners). */
  radius: number;
}

/** The default radius (pt) the rounded/bevel/etc. presets apply. */
export const DEFAULT_CORNER_RADIUS_PT = 12;

/** The five v2 live-corner presets (Round / Inverse / Bevel / Fancy /
 *  None — None squares the corners back). */
export const LIVE_CORNER_PRESETS: readonly LiveCornerPreset[] = [
  {
    id: "media.paged.draw.command.cornersRounded",
    title: "Corners: Rounded",
    style: "RoundedCorner",
    radius: DEFAULT_CORNER_RADIUS_PT,
  },
  {
    id: "media.paged.draw.command.cornersInverseRounded",
    title: "Corners: Inverse rounded",
    style: "InverseRoundedCorner",
    radius: DEFAULT_CORNER_RADIUS_PT,
  },
  {
    id: "media.paged.draw.command.cornersBevel",
    title: "Corners: Bevel",
    style: "BeveledCorner",
    radius: DEFAULT_CORNER_RADIUS_PT,
  },
  {
    id: "media.paged.draw.command.cornersFancy",
    title: "Corners: Fancy",
    style: "FancyCorner",
    radius: DEFAULT_CORNER_RADIUS_PT,
  },
  {
    id: "media.paged.draw.command.cornersNone",
    title: "Corners: None (square)",
    style: "None",
    radius: 0,
  },
] as const;

/** The contributed command ids, in registration order. */
export const LIVE_CORNER_COMMAND_IDS = LIVE_CORNER_PRESETS.map((p) => p.id);

/** Only rectangles carry an engine corner-option apply arm (gap B-23). */
export function supportsLiveCorners(id: ElementId): boolean {
  return id.kind === "rectangle";
}

// ---------------------------------------------------------- builders
// Exported so the conformance spec asserts the EXACT wire shape each
// command emits (no second copy to drift from).

const CORNER_OPTION_PATHS = [
  "frameCornerOptionTopLeft",
  "frameCornerOptionTopRight",
  "frameCornerOptionBottomRight",
  "frameCornerOptionBottomLeft",
] as const;

const CORNER_RADIUS_PATHS = [
  "frameCornerRadiusTopLeft",
  "frameCornerRadiusTopRight",
  "frameCornerRadiusBottomRight",
  "frameCornerRadiusBottomLeft",
] as const;

/** The eight `setElementProperty` writes one preset commits to one
 *  rectangle: the four corner OPTIONS (Text, `""` for None) and the four
 *  RADII (Length in pt). Wrapped in ONE `batch` = one undo step. The
 *  `None` preset writes empty option text (the apply layer maps it to
 *  `CornerOption::None`) and a 0 radius. */
export function cornerStyleMutationFor(
  elementId: ElementId,
  preset: LiveCornerPreset,
): Mutation {
  // `None` clears via the empty-string text the apply layer's is_empty()
  // arm reads; every other style writes its IDML token verbatim.
  const optionText = preset.style === "None" ? "" : preset.style;
  const ops: Mutation[] = [];
  for (const path of CORNER_OPTION_PATHS) {
    ops.push({
      op: "setElementProperty",
      args: { elementId, path, value: { type: "text", value: optionText } },
    });
  }
  for (const path of CORNER_RADIUS_PATHS) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path,
        value: { type: "length", value: preset.radius },
      },
    });
  }
  return { op: "batch", args: { ops } };
}

/** Set ONE corner's option + radius (the on-canvas-handle path — concept
 *  §13.2 "drag corner widgets"). `corner` ∈ 0..3 in IDML order
 *  [topLeft, topRight, bottomRight, bottomLeft]. Exported for the
 *  conformance spec + a future overlay handle. */
export function cornerRadiiMutationFor(
  elementId: ElementId,
  corner: 0 | 1 | 2 | 3,
  style: CornerStyleToken,
  radius: number,
): Mutation {
  const optionText = style === "None" ? "" : style;
  return {
    op: "batch",
    args: {
      ops: [
        {
          op: "setElementProperty",
          args: {
            elementId,
            path: CORNER_OPTION_PATHS[corner],
            value: { type: "text", value: optionText },
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId,
            path: CORNER_RADIUS_PATHS[corner],
            value: { type: "length", value: radius },
          },
        },
      ],
    },
  };
}

/** The §13.3 "live" metadata marker stamped onto a rectangle whose
 *  corners this plugin manages: `{ liveCorners: { style, radius } }`
 *  merged into the existing envelope's `data` (preserving other draw
 *  metadata — e.g. the last anchor tool). Clearing to None drops the
 *  marker. Returns the next envelope (or null to clear all metadata when
 *  nothing else remains). */
export function withLiveCornerMarker(
  prev: PluginMetadataEnvelope | null,
  preset: LiveCornerPreset,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (preset.style === "None") {
    delete data.liveCorners;
  } else {
    data.liveCorners = { style: preset.style, radius: preset.radius };
  }
  // If clearing left the envelope empty, clear all metadata (null).
  if (preset.style === "None" && Object.keys(data).length === 0) {
    return null;
  }
  return { v: prev?.v ?? 1, data, ...(prev?.engine ? { engine: prev.engine } : {}) };
}

// ------------------------------------------------------------ appliers

/** Apply one live-corner preset to the current selection: per rectangle,
 *  commit the eight-write batch AND stamp/clear the `liveCorners`
 *  metadata marker. Non-rectangles are skipped (gap B-23). No rectangle
 *  selected ⇒ no-op (a debug log, never a throw). */
export async function applyLiveCornerPreset(
  host: BundleHost,
  preset: LiveCornerPreset,
): Promise<void> {
  const rects = host.selection.get().filter(supportsLiveCorners);
  if (rects.length === 0) {
    host.log.debug(`${preset.id}: no rectangle in selection — no-op`);
    return;
  }
  for (const id of rects) {
    const outcome = await host.document.mutate(cornerStyleMutationFor(id, preset));
    if (!outcome.applied) {
      host.log.warn(
        `${preset.id} rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      continue;
    }
    // Stamp the §13.3 live marker (best-effort — a metadata failure does
    // not undo the geometry; the baked corners are valid IDML regardless).
    try {
      const prev = await host.document.getMetadata(id);
      await host.document.setMetadata(id, withLiveCornerMarker(prev, preset));
    } catch {
      /* the live marker is advisory; the baked corners stand */
    }
  }
}

/** Register the five live-corner preset commands. */
export function contributeLiveCornerCommands(host: BundleHost): Disposable {
  const disposers = LIVE_CORNER_PRESETS.map((preset) =>
    host.contribute.command({
      id: preset.id,
      title: preset.title,
      category: LIVE_CORNERS_COMMAND_CATEGORY,
      handler: () => applyLiveCornerPreset(host, preset),
    }),
  );
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
