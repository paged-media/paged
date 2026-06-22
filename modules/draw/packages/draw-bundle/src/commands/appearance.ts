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

// Appearance model — stacked fills/strokes per object (concept §13.5,
// Tier B; "the Appearance model is Illustrator's deepest concept").
//
// MECHANISM (the honest "metadata + baked path" the concept names): the
// IDML/engine frame has ONE fill and ONE stroke. A multi-fill/multi-stroke
// appearance is therefore PLUGIN METADATA — an `appearance` envelope in
// this plugin's `x-paged:media.paged.draw` carrier listing the extra
// fill/stroke LAYERS — plus a BAKE that writes the COMPOSITED top layer to
// the frame's real `frameFillColor` / `frameStrokeColor` /
// `frameStrokeWeight`. Opening in InDesign shows the baked top layer
// (valid IDML); reopening in Paged restores the full stack from metadata.
//
// LIMITATION, named (the task's "name the limitation honestly"): the
// engine has ONE fill + ONE stroke slot per frame and NO per-layer
// blend/opacity compositing of multiple fills into a single frame paint.
// So the bake is NOT a true composite of N fills — it lowers the FRONT-MOST
// (top) opaque fill layer and the front-most stroke layer to the frame's
// real attributes (the visible result when layers don't blend). A faithful
// N-layer composite (multiply/screen stacks, per-layer opacity) would need
// either a multi-paint frame model in the engine OR baking the stack into
// an overlapping GROUP of derived frames — RFI gap B-24. v0 ships the
// stack-in-metadata + top-layer bake; the panel manages the layers.
//
// The layer EDITORS (add/remove/reorder) are COMMANDS (a layer list is a
// vector above the scalar schema binding ceiling — the dash/gradient
// precedent); the panel SECTION reads the stack count via a published
// binding and points the author at the commands.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  MutationOutcome,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

export const APPEARANCE_COMMAND_CATEGORY = "Appearance";

export const APPEARANCE_ADD_FILL_COMMAND_ID =
  "media.paged.draw.command.appearanceAddFill";
export const APPEARANCE_ADD_STROKE_COMMAND_ID =
  "media.paged.draw.command.appearanceAddStroke";
export const APPEARANCE_CLEAR_COMMAND_ID =
  "media.paged.draw.command.appearanceClear";

/** The contributed command ids, in registration order. */
export const APPEARANCE_COMMAND_IDS = [
  APPEARANCE_ADD_FILL_COMMAND_ID,
  APPEARANCE_ADD_STROKE_COMMAND_ID,
  APPEARANCE_CLEAR_COMMAND_ID,
];

/** One extra fill layer (a swatch ref + optional tint %). */
export interface FillLayer {
  /** A swatch / gradient self-id (the `frameFillColor` colorRef vocab). */
  color: string;
  /** Tint 0..100, default 100. */
  tint?: number;
}

/** One extra stroke layer (a swatch ref + weight in pt). */
export interface StrokeLayer {
  color: string;
  /** Stroke weight in pt. */
  weight: number;
}

/** The appearance stack — fills + strokes BOTTOM-to-TOP (the LAST entry
 *  is the front-most, the one the bake lowers to the frame). */
export interface AppearanceStack {
  fills: FillLayer[];
  strokes: StrokeLayer[];
}

const EMPTY: AppearanceStack = { fills: [], strokes: [] };

/** Read the appearance stack out of an envelope's `data.appearance`, or
 *  an empty stack. Tolerant of partial/foreign shapes (returns empty
 *  rather than throwing). */
export function appearanceOf(env: PluginMetadataEnvelope | null): AppearanceStack {
  const raw = (env?.data as { appearance?: unknown } | undefined)?.appearance;
  if (!raw || typeof raw !== "object") return { fills: [], strokes: [] };
  const a = raw as Partial<AppearanceStack>;
  return {
    fills: Array.isArray(a.fills) ? a.fills.slice() : [],
    strokes: Array.isArray(a.strokes) ? a.strokes.slice() : [],
  };
}

/** Merge a stack back into an envelope's `data.appearance`, preserving
 *  other draw metadata. An empty stack drops the key (and clears the
 *  whole envelope to null when nothing else remains). */
export function withAppearance(
  prev: PluginMetadataEnvelope | null,
  stack: AppearanceStack,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  const empty = stack.fills.length === 0 && stack.strokes.length === 0;
  if (empty) {
    delete data.appearance;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.appearance = stack;
  }
  return { v: prev?.v ?? 1, data, ...(prev?.engine ? { engine: prev.engine } : {}) };
}

/** The BAKE: the `setElementProperty` writes that lower the FRONT-MOST
 *  (last) fill + stroke layer onto the frame's real attributes. Returns
 *  an empty array when the stack has neither (nothing to bake — the
 *  frame keeps its own paint). Exported so the conformance spec asserts
 *  the exact wire shape. */
export function bakeAppearanceMutations(
  elementId: ElementId,
  stack: AppearanceStack,
): Mutation[] {
  const ops: Mutation[] = [];
  const topFill = stack.fills.at(-1);
  if (topFill) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameFillColor",
        value: { type: "colorRef", value: topFill.color },
      },
    });
    if (typeof topFill.tint === "number") {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameFillTint",
          value: { type: "length", value: topFill.tint },
        },
      });
    }
  }
  const topStroke = stack.strokes.at(-1);
  if (topStroke) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameStrokeColor",
        value: { type: "colorRef", value: topStroke.color },
      },
    });
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameStrokeWeight",
        value: { type: "length", value: topStroke.weight },
      },
    });
  }
  return ops;
}

/** Persist a stack onto an element: write the metadata envelope AND bake
 *  the top layer to the frame (one batch when there's anything to bake;
 *  the metadata write is its own undoable step). Exported for the
 *  conformance spec. Returns the metadata outcome (the source of truth);
 *  a bake failure is logged, not thrown (the stack still round-trips). */
export async function commitAppearance(
  host: BundleHost,
  id: ElementId,
  stack: AppearanceStack,
  prev: PluginMetadataEnvelope | null,
): Promise<MutationOutcome> {
  const metaOutcome = await host.document.setMetadata(
    id,
    withAppearance(prev, stack),
  );
  const bake = bakeAppearanceMutations(id, stack);
  if (bake.length > 0) {
    const outcome = await host.document.mutate({
      op: "batch",
      args: { ops: bake },
    });
    if (!outcome.applied) {
      host.log.warn(
        `appearance bake rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
    }
  }
  return metaOutcome;
}

/** Read the element's current frame fill/stroke (the seed for a new
 *  appearance layer — "stack a copy of what's there"). Best-effort. */
async function frameFillStroke(
  host: BundleHost,
  id: ElementId,
): Promise<{ fill: string | null; stroke: string | null; weight: number }> {
  const out = { fill: null as string | null, stroke: null as string | null, weight: 1 };
  try {
    const props = await host.document.elementProperties(id);
    for (const e of props?.entries ?? []) {
      const v = e.value;
      if (!v) continue;
      if (e.path === "frameFillColor" && v.type === "colorRef") out.fill = v.value;
      else if (e.path === "frameStrokeColor" && v.type === "colorRef") out.stroke = v.value;
      else if (e.path === "frameStrokeWeight" && v.type === "length" && v.value != null) {
        out.weight = v.value;
      }
    }
  } catch {
    /* defaults stand */
  }
  return out;
}

type AppearanceKind = "fill" | "stroke" | "clear";

async function applyAppearanceCommand(
  host: BundleHost,
  commandId: string,
  kind: AppearanceKind,
): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${commandId}: no selection — no-op`);
    return;
  }
  for (const id of selection) {
    const prev = await host.document.getMetadata(id).catch(() => null);
    if (kind === "clear") {
      await host.document.setMetadata(id, withAppearance(prev, EMPTY));
      continue;
    }
    const current = appearanceOf(prev);
    const seed = await frameFillStroke(host, id);
    if (kind === "fill") {
      // Stack a new fill layer seeded from the frame's current fill (or
      // black when it has none) — the author then edits it in the panel.
      current.fills.push({ color: seed.fill ?? "Color/Black", tint: 100 });
    } else {
      current.strokes.push({
        color: seed.stroke ?? "Color/Black",
        weight: seed.weight,
      });
    }
    await commitAppearance(host, id, current, prev);
  }
}

/** Register the three appearance commands (add fill layer / add stroke
 *  layer / clear the stack). */
export function contributeAppearanceCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: APPEARANCE_ADD_FILL_COMMAND_ID,
      title: "Appearance: Add fill",
      category: APPEARANCE_COMMAND_CATEGORY,
      handler: () => applyAppearanceCommand(host, APPEARANCE_ADD_FILL_COMMAND_ID, "fill"),
    }),
    host.contribute.command({
      id: APPEARANCE_ADD_STROKE_COMMAND_ID,
      title: "Appearance: Add stroke",
      category: APPEARANCE_COMMAND_CATEGORY,
      handler: () =>
        applyAppearanceCommand(host, APPEARANCE_ADD_STROKE_COMMAND_ID, "stroke"),
    }),
    host.contribute.command({
      id: APPEARANCE_CLEAR_COMMAND_ID,
      title: "Appearance: Clear extra layers",
      category: APPEARANCE_COMMAND_CATEGORY,
      handler: () => applyAppearanceCommand(host, APPEARANCE_CLEAR_COMMAND_ID, "clear"),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
