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
// WHICH KINDS, and a gap that CLOSED. This used to read "the apply layer
// accepts `frameCornerOption*` / `frameCornerRadius*` ONLY on
// `NodeId::Rectangle` … RFI gap B-23", and the gate below filtered every
// polygon out of the selection before a mutation was ever built. B-23
// landed (Rectangle + Polygon) and C-18 finished the rest in 2026-08:
// `set_property.rs`'s arm is now six kinds wide and `find_corners_mut`
// has a `NodeId::Polygon` branch. The comment outlived it, so the presets
// went on being a silent no-op on a polygon for months — long after real
// IDML packs in the corpus (30 corner-carrying `<Polygon>`s in one
// template alone) proved the format expects them.
//
// Probed against the wasm this editor runs, on a closed triangle: the
// engine applied both writes and the page changed by 2,019 px — more than
// the same preset on a rectangle (393 px), because a polygon has three
// corners to cut and the rectangle's rounding is subtler. A stale
// comment, not a missing arm. See `LIVE_CORNER_KINDS`.
//
// Per-corner editing (different radius per corner) is on the wire and
// supported by `cornerRadiiMutationFor`; the preset commands set a
// UNIFORM radius across the four corners (the common case), and the
// builder is exported so a future on-canvas handle drives one corner.
// NOTE for polygons: only the TOP-LEFT slot drives geometry (the
// renderer's `uniform_corner` reads `corners[0]`), because "top left" has
// no meaning for an N-gon; the presets write that slot first, so they
// take effect, and the other three round-trip.

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

/**
 * The kinds whose corners the engine both ACCEPTS and RENDERS.
 *
 * `frameCornerOption*` / `frameCornerRadius*` apply to six kinds
 * (`find_corners_mut` in core's `paged-mutate`), but the other three are
 * storage only — its own doc comment: "Oval / GraphicLine / Group —
 * stored and round-tripped, never rendered: an ellipse has no corner, an
 * open stroke-only line has no enclosed corner, and a group has no
 * outline of its own." Offering a preset that writes a property nothing
 * draws would be the same lie the rectangle-only gate told, pointed the
 * other way, so this lists what a designer will actually SEE change.
 */
const LIVE_CORNER_KINDS = ["rectangle", "polygon", "textFrame"] as const;

/** Whether a live-corner preset changes anything on `id`. */
export function supportsLiveCorners(id: ElementId): boolean {
  return (LIVE_CORNER_KINDS as readonly string[]).includes(id.kind);
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

/** Apply one live-corner preset to the current selection: per corner-
 *  bearing item, commit the eight-write batch AND stamp/clear the
 *  `liveCorners` metadata marker. Kinds whose corners nothing renders are
 *  skipped (see `LIVE_CORNER_KINDS`). Nothing eligible selected ⇒ no-op
 *  (a debug log, never a throw). */
export async function applyLiveCornerPreset(
  host: BundleHost,
  preset: LiveCornerPreset,
): Promise<void> {
  const targets = host.selection.get().filter(supportsLiveCorners);
  if (targets.length === 0) {
    host.log.debug(
      `${preset.id}: nothing with renderable corners in selection — no-op`,
    );
    return;
  }
  for (const id of targets) {
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
