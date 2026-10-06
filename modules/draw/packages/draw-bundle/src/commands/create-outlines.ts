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

// CREATE OUTLINES — Type ▸ Create Outlines (RFI C-69): a text frame's
// glyphs become ordinary compound paths, and the frame goes.
//
// THE OUTLINES ARE THE RENDERER'S, NOT A SECOND FONT PASS. Core's
// `requestTextOutlines` (protocol 66) reads them off the export build's
// glyph side-channel: each glyph is exactly the `FillPath` the canvas
// fills, through exactly its transform, in page space. So what is
// inserted looks like what was on screen — kerning, tracking, justification
// and hyphenation included — and nothing here touches a font.
//
// ONE PATH PER COLOUR, and that is Illustrator's grouping too: a
// two-colour headline becomes two compound paths (a group of them), not
// one path per glyph. Each is inserted as its FIRST contour and then
// given the whole table through the `framePath` door, the same re-merge
// Make Compound Path uses — so a ring "o" keeps its hole under the
// engine's non-zero fill, because the glyph outlines arrive wound the
// way the font wound them and the renderer filled them that way.
//
// ONE BATCH, ONE UNDO: swatches, inserts, bind, framePath, paint, group,
// then the frame's `deleteFrame` — insert-then-delete is the order the
// engine accepts in one batch (minted.spec.ts).
//
// WHAT IS NOT OUTLINED, and the engine says so in `skippedGlyphs`:
// stroked text and text painted with a gradient. OVERSET text is not
// outlined either — it is not on the page, exactly as Illustrator drops
// it — and the frame is deleted all the same, so the log names the count
// when there was any overset (the frame's story is lost with it).
//
// A HOST ON AN OLDER ENGINE (protocol < 66) has no `requestTextOutlines`;
// the raw read answers null and the command refuses by name rather than
// deleting a frame it could not replace.

import type {
  BundleHost,
  Disposable,
  ElementId,
  MutationInput,
} from "@paged-media/plugin-api";
import { rgbToHex, type AnchorTable } from "@paged-media/draw-geometry";

import { insertPathMutationFor } from "../handlers/insert-path";
import { framePathMutationFor } from "./compound-path";
import { groupMutationFor } from "./group";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "./v59-wire";
import { rawTextOutlines, type TextOutlinesWire } from "../raw-wire";

import { registerCommand } from "../command-registry";
export const CREATE_OUTLINES_COMMAND_ID = "media.paged.draw.command.createOutlines";
export const CREATE_OUTLINES_COMMAND_IDS = [CREATE_OUTLINES_COMMAND_ID];

/** The handle run `i` of frame `f` is bound to inside the batch —
 *  per-frame, because several frames share one batch and a second bind
 *  of the same name would re-point every later reference. */
const outlineHandle = (f: number, i: number): string => `outline-${f}-${i}`;

let swatchSeq = 0;
const mintSwatchId = (): string =>
  `Color/udrawoutl${Date.now().toString(16)}${(swatchSeq++).toString(16)}`;

const to255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** The swatch a run is painted with: an existing swatch NAMED with the
 *  run's hex (the `io/svg.ts` naming convention, so a second outline of
 *  the same colour reuses the first's), `Color/Black` for process black
 *  when the document has it, otherwise a new RGB swatch named with the
 *  hex. */
export interface OutlineSwatchPlan {
  ref: string;
  create: { selfId: string; name: string; rgb: [number, number, number] } | null;
}

export function outlineSwatchFor(
  run: TextOutlinesWire["runs"][number],
  existing: ReadonlyMap<string, string>,
): OutlineSwatchPlan {
  const rgb: [number, number, number] = [to255(run.rgb[0]), to255(run.rgb[1]), to255(run.rgb[2])];
  const isProcessBlack =
    run.cmyk != null &&
    run.cmyk[0] === 0 &&
    run.cmyk[1] === 0 &&
    run.cmyk[2] === 0 &&
    run.cmyk[3] === 1;
  if (isProcessBlack && existing.has("Color/Black")) return { ref: "Color/Black", create: null };
  const hex = rgbToHex(rgb);
  // Hex case differs between writers (this repo writes lower case,
  // a hand-named swatch is often upper), so match either.
  const known =
    existing.get(hex) ?? existing.get(hex.toLowerCase()) ?? existing.get(hex.toUpperCase());
  if (known !== undefined) return { ref: known, create: null };
  return { ref: "", create: { selfId: mintSwatchId(), name: hex, rgb } };
}

/** A run's anchors as a draw-geometry table. */
export function outlineTableOf(run: TextOutlinesWire["runs"][number]): AnchorTable {
  return {
    anchors: run.anchors.map((a) => ({
      anchor: [a.anchor[0], a.anchor[1]],
      left: [a.left[0], a.left[1]],
      right: [a.right[0], a.right[1]],
    })),
    subpathStarts: [...run.subpathStarts],
  };
}

/** THE ONE BATCH (module header). `existing` maps swatch NAME → id (and
 *  `Color/Black` → itself when the document has it). Null when there is
 *  nothing to outline — the frame is then left alone. */
export function createOutlinesBatchFor(args: {
  frame: ElementId;
  result: TextOutlinesWire;
  existing: ReadonlyMap<string, string>;
  /** This frame's index within a multi-frame batch (handle namespace). */
  frameIndex?: number;
}): MutationInput | null {
  const f = args.frameIndex ?? 0;
  const runs = args.result.runs.filter((r) => r.anchors.length > 0 && r.subpathStarts.length > 0);
  if (runs.length === 0) return null;
  const ops: MutationInput[] = [];
  const palette = new Map(args.existing);
  const handles: ElementId[] = [];
  runs.forEach((run, i) => {
    const swatch = outlineSwatchFor(run, palette);
    let ref = swatch.ref;
    if (swatch.create) {
      const { selfId, name, rgb } = swatch.create;
      ops.push({
        op: "createSwatch",
        args: { spec: { selfId, name, space: "RGB", value: [rgb[0], rgb[1], rgb[2]] } },
      });
      palette.set(name, selfId);
      ref = selfId;
    }
    const table = outlineTableOf(run);
    const firstEnd = table.subpathStarts.length > 1 ? table.subpathStarts[1] : table.anchors.length;
    ops.push(insertPathMutationFor(args.result.pageId, table.anchors.slice(0, firstEnd), false));
    ops.push(bindCreatedMutationFor(outlineHandle(f, i)));
    const id = handleElementId(outlineHandle(f, i));
    handles.push(id);
    if (table.subpathStarts.length > 1) ops.push(framePathMutationFor(id, table));
    ops.push({
      op: "setElementProperty",
      args: { elementId: id, path: "frameFillColor", value: { type: "colorRef", value: ref } },
    });
    ops.push({
      op: "setElementProperty",
      args: { elementId: id, path: "frameStrokeColor", value: { type: "colorRef", value: null } },
    });
  });
  if (handles.length >= 2) ops.push(groupMutationFor(handles));
  ops.push({ op: "deleteFrame", args: { frameId: String(args.frame.id) } });
  return batchMutationFor(ops);
}

/** Swatch name → id, plus `Color/Black` when the document carries it. */
async function existingSwatches(host: BundleHost): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const swatches = (await host.document.collection("swatches")) as readonly {
      selfId: string;
      name: string;
    }[];
    for (const s of swatches) {
      if (s.selfId === "Color/Black") out.set("Color/Black", "Color/Black");
      else if (!out.has(s.name)) out.set(s.name, s.selfId);
    }
  } catch {
    // No swatch list → every colour mints its own swatch.
  }
  return out;
}

/** Outline every selected text frame. Answers the frames replaced. */
export async function applyCreateOutlines(host: BundleHost): Promise<ElementId[]> {
  const frames = host.selection.get().filter((id) => id.kind === "textFrame");
  if (frames.length === 0) {
    host.log.debug(`${CREATE_OUTLINES_COMMAND_ID}: no text frame selected — no-op`);
    return [];
  }
  const existing = await existingSwatches(host);
  const ops: MutationInput[] = [];
  const done: ElementId[] = [];
  for (const frame of frames) {
    const result = await rawTextOutlines(host, frame);
    if (!result) {
      host.log.warn(
        `${CREATE_OUTLINES_COMMAND_ID}: the engine did not answer requestTextOutlines for ` +
          `${String(frame.id)} (protocol 66 or later is needed) — the frame is left as text`,
      );
      continue;
    }
    if (result.skippedGlyphs > 0) {
      host.log.warn(
        `${CREATE_OUTLINES_COMMAND_ID}: ${result.skippedGlyphs} glyph(s) of ${String(frame.id)} ` +
          "are stroked or gradient-filled and were not outlined",
      );
    }
    const batch = createOutlinesBatchFor({ frame, result, existing, frameIndex: done.length });
    if (!batch) {
      host.log.debug(`${CREATE_OUTLINES_COMMAND_ID}: ${String(frame.id)} shows no glyphs — left alone`);
      continue;
    }
    const frameOps = (batch.args as { ops: MutationInput[] }).ops;
    // A colour this frame minted is reused by the next frame.
    for (const op of frameOps) {
      if (op.op !== "createSwatch") continue;
      const spec = (op.args as { spec: { selfId: string; name: string } }).spec;
      existing.set(spec.name, spec.selfId);
    }
    ops.push(...frameOps);
    done.push(frame);
  }
  if (ops.length === 0) return [];
  // Several frames: ONE batch for all of them, one undo step.
  const outcome = await host.document.mutate(batchMutationFor(ops));
  if (!outcome.applied) {
    host.log.warn(
      `${CREATE_OUTLINES_COMMAND_ID} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return [];
  }
  return done;
}

export function contributeCreateOutlinesCommands(host: BundleHost): Disposable {
  const sub = registerCommand(host, {
    id: CREATE_OUTLINES_COMMAND_ID,
    title: "Type: Create outlines",
    category: "Type",
    handler: () => applyCreateOutlines(host),
  });
  return { dispose: () => sub.dispose() };
}
