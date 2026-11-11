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

// C-32 — the host Eyedropper, in two modes (the `mode` option, double-click
// the slot):
//
//  · PIXEL (default): click a page → sample the COMPOSITED pixels (the
//    `sampleSize` option: a point, or Photoshop's N×N average) → that
//    colour becomes the document's default fill, and the fill of anything
//    selected. Inside an edit context whose binding provider declares the
//    eyedropper lane (extensions ADR 1104), the CONTEXT is the target: it
//    samples its own content at that size and takes the colour (paged.image:
//    its foreground, Alt its background), and a drag keeps sampling, as in
//    Photoshop. A provider that declines leaves the click to the page.
//  · OBJECT: click an element → sample its typed appearance PROPERTIES
//    (fill colour and tint, stroke colour and weight, opacity, and the rest
//    of the look: gradients, effects, blend modes) → write them onto the
//    selection in ONE batch. Alt+click samples only (the sample is held for
//    inspection). Nothing under the click is a no-op. paged.draw carried
//    this as a tool of its own; it is this mode now (PM-0017), and the
//    sampling and the write are `@paged-media/helpers`' (`sampled-style`).
//    Each target is written only what its own snapshot exposes, because a
//    graphic line refuses a fill.
//
// The ruling and why colour is host vocabulary are argued in
// `eyedropper-sample.ts`; the arithmetic lives there too. This file is
// only the wiring: pointer → snapshot → pixel → mutations.
//
// HOW THE PIXEL IS OBTAINED, and its honest cost. There is no
// raster-readback door: the page renders to an `OffscreenCanvas` inside
// the worker, so the main thread cannot `getImageData` it. What DOES
// exist is `requestSnapshot(pageId, targetWidthPx)` — the navigator's
// PNG path. So a sample is one page re-render, decoded here, read at
// one pixel. That is heavy for a per-pixel API and perfectly fine for a
// CLICK, which is the only gesture this tool has. If a future
// eyedropper wants a live hover preview, the right fix is a real
// readback door, not calling this in a loop.
//
// SAMPLE_WIDTH_PX fixes the snapshot's resolution so the sample does
// not silently change with zoom. It is deliberately near print-ish
// density rather than screen: sampling a 1-pixel hairline is more
// faithful at higher density, and the cost is one render either way.
//
// WHY A SWATCH AND NOT A RAW COLOUR. `frameFillColor` and the document
// defaults both address a document RESOURCE by id, not an RGB triple —
// that is IDML's model, not a limitation of the door. So a sample must
// resolve to a swatch, which means find-or-create. The name is a total
// function of the RGB value (`R=12 G=34 B=56`, InDesign's own
// convention), so sampling the same pixel twice reuses one swatch
// instead of growing the document on every click.

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/shell";

import {
  planApply,
  snapshotPixelFor,
  swatchSpecFor,
  type SampledRgb,
  type SwatchLike,
} from "./eyedropper-sample";
import { CLICK_DRAG_THRESHOLD_PX } from "./shared";
import {
  SAMPLE_SIZES,
  averageRgba8,
  isSampleSize,
  sampleWindow,
  type SampleSize,
  applySampledStyle,
  sampledStyleFrom,
  type SampledStyle,
  type SampledTarget,
} from "@paged-media/helpers";
import type { ElementId } from "@paged-media/client";
import type { ToolOptionField } from "@paged-media/shell";
import { t } from "@paged-media/strings";

import { EYEDROPPER_TOOL } from "../messages";

export const EYEDROPPER_TOOL_ID = "paged.tool.eyedropper";

export type EyedropperMode = "pixel" | "object";

/** The tool's options: what a click samples. */
export const EYEDROPPER_OPTION_FIELDS: ToolOptionField[] = [
  {
    kind: "select",
    key: "mode",
    get label() {
      return t(EYEDROPPER_TOOL.mode);
    },
    options: [
      {
        value: "pixel",
        get label() {
          return t(EYEDROPPER_TOOL.pixel);
        },
      },
      {
        value: "object",
        get label() {
          return t(EYEDROPPER_TOOL.object);
        },
      },
    ],
  },
  {
    kind: "select",
    key: "sampleSize",
    get label() {
      return t(EYEDROPPER_TOOL.sampleSize);
    },
    options: SAMPLE_SIZES.map((n) => ({
      value: String(n),
      get label() {
        return n === 1
          ? t(EYEDROPPER_TOOL.pointSample)
          : t(EYEDROPPER_TOOL.average, { n });
      },
    })),
  },
];

/** The sample size the tool's settings hold (a point when unset). */
export function eyedropperSampleSizeOf(paged: PagedEditor): SampleSize {
  const n = Number(
    paged.toolSettings?.getValue(EYEDROPPER_TOOL_ID, "sampleSize") ?? 1,
  );
  return isSampleSize(n) ? n : 1;
}

/** The mode the tool's settings hold (Pixel when unset or unknown). */
export function eyedropperModeOf(paged: PagedEditor): EyedropperMode {
  const raw = paged.toolSettings?.getValue(EYEDROPPER_TOOL_ID, "mode");
  return raw === "object" ? "object" : "pixel";
}

// The last style an Alt+click sampled, held for inspection.
let lastSample: SampledStyle | null = null;
export const getEyedropperSample = (): SampledStyle | null => lastSample;
export const clearEyedropperSample = (): void => {
  lastSample = null;
};

/** Snapshot density for a sample. Independent of zoom on purpose — see
 *  the header. */
const SAMPLE_WIDTH_PX = 1024;

/** Decode PNG bytes and read the `size`×`size` window around one pixel,
 *  averaged (`@paged-media/helpers`' window and premultiplied mean, the
 *  same paged.image samples its layers with). Returns null in any realm
 *  that lacks the imaging primitives (Node test runners, notably) rather
 *  than throwing — the tool then no-ops, which is the honest outcome
 *  when the host genuinely cannot see its own pixels. */
async function readPixel(
  png: Uint8Array,
  x: number,
  y: number,
  size: number,
): Promise<SampledRgb | null> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return null;
  }
  const blob = new Blob([png as BlobPart], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  try {
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = surface.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const win = sampleWindow([x, y], size, bitmap.width, bitmap.height);
    if (!win) return null;
    const avg = averageRgba8(ctx.getImageData(win.x, win.y, win.w, win.h).data);
    if (!avg) return null;
    const to8 = (v: number) => Math.round(v * 255);
    return { r: to8(avg[0]), g: to8(avg[1]), b: to8(avg[2]), a: to8(avg[3]) };
  } finally {
    bitmap.close();
  }
}

export function createEyedropperHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  // Guards re-entry: a sample is async and a user can click again
  // before the snapshot lands. Without this, two clicks race to create
  // the same swatch and one of them loses.
  let sampling = false;

  /** OBJECT mode: the element under the click lends its properties to the
   *  selection. */
  const copyStyleAt = async (e: CanvasPointerEvent) => {
    if (!paged || !e.pageId || !e.pagePoint) return;
    const client = paged.client;
    let source: ElementId | null = null;
    try {
      const reply = await client.send({
        kind: "hitTest",
        payload: { pageId: e.pageId, docPoint: e.pagePoint, filter: "any" },
      });
      if (reply.kind === "hitResult") source = reply.payload.element ?? null;
    } catch {
      source = null;
    }
    if (!source) return; // nothing under the click: the documented no-op
    const style = sampledStyleFrom(await client.elementProperties(source));
    if (!style) return;
    lastSample = style;
    if (e.modifiers.alt) return; // Alt+click samples only
    // The selection, minus the source itself (rewriting it with its own
    // values would only pad the undo).
    const ids = paged.selection.elementSelection.filter(
      (id) =>
        !(
          id.kind === source.kind &&
          (id as { id: unknown }).id === (source as { id: unknown }).id
        ),
    );
    const targets: SampledTarget<ElementId>[] = [];
    for (const id of ids) {
      const props = await client.elementProperties(id);
      targets.push({
        id,
        supports: new Set(
          (props?.entries ?? []).map((en: { path: string }) => en.path),
        ),
      });
    }
    const batch = applySampledStyle(targets, style);
    if (batch) await client.mutate(batch as never);
  };

  const sampleAt = async (e: CanvasPointerEvent) => {
    if (!paged || sampling) return;
    if (eyedropperModeOf(paged) === "object") {
      sampling = true;
      try {
        await copyStyleAt(e);
      } finally {
        sampling = false;
      }
      return;
    }
    // Off-page: the pasteboard has nothing composited to sample.
    if (!e.pageId || !e.pagePoint) return;
    sampling = true;
    const editor = paged;
    const client = editor.client;
    try {
      const pages = await client
        .collection<{ selfId: string; sizePt: [number, number] }>("pages")
        .catch(
          () => [] as readonly { selfId: string; sizePt: [number, number] }[],
        );
      const page = pages.find((p) => p.selfId === e.pageId);
      if (!page) return;

      const shot = await client
        .requestSnapshot(e.pageId, SAMPLE_WIDTH_PX)
        .catch(() => null);
      if (!shot) return;
      const px = snapshotPixelFor(
        e.pagePoint,
        page.sizePt[0],
        shot.widthPx,
        shot.heightPx,
      );
      if (!px) return;
      const rgb = await readPixel(
        Uint8Array.from(shot.pngBytes),
        px[0],
        px[1],
        eyedropperSampleSizeOf(editor),
      ).catch(() => null);
      if (!rgb) return;

      const swatches = await client
        .collection<SwatchLike>("swatches")
        .catch(() => [] as readonly SwatchLike[]);
      const plan = planApply(rgb, swatches, editor.selection.elementSelection);

      // Create first if needed: the swatch has to EXIST before anything
      // can reference it, and its id is only knowable by reading back —
      // `createSwatch` mints a document resource, not an element, so it
      // does not come back on `created_id`.
      if (plan.needsSwatch) {
        await client.mutate({
          op: "createSwatch",
          args: { spec: swatchSpecFor(rgb) },
        } as never);
      }
      const after = plan.needsSwatch
        ? await client
            .collection<SwatchLike>("swatches")
            .catch(() => [] as readonly SwatchLike[])
        : swatches;
      const swatchId = after.find((s) => s.name === plan.swatchName)?.selfId;
      if (!swatchId) return;

      // One batch → one undo step for the visible change. The swatch
      // creation above is its own step by necessity; that matches how
      // every other swatch-minting flow in the editor behaves.
      //
      // The stroke half of the triple is READ BACK and written
      // unchanged: `setDocumentDefaults` sets all three, so passing
      // null would silently clear the user's default stroke as a side
      // effect of sampling a fill.
      const meta = await client.documentMeta().catch(() => null);
      const ops: unknown[] = [
        {
          op: "setDocumentDefaults",
          args: {
            fillColor: swatchId,
            strokeColor: meta?.defaultStrokeColor ?? null,
            strokeWeight: meta?.defaultStrokeWeight ?? null,
          },
        },
        ...plan.targets.map((elementId) => ({
          op: "setElementProperty",
          args: {
            elementId,
            path: "frameFillColor",
            value: { type: "colorRef", value: swatchId },
          },
        })),
      ];
      await client.mutate(
        ops.length === 1
          ? (ops[0] as never)
          : ({ op: "batch", args: { ops } } as never),
      );
    } finally {
      sampling = false;
    }
  };

  /** Offer the sample to the active context (extensions ADR 1104):
   *  true when a provider took it. */
  const offerToContext = async (
    e: CanvasPointerEvent,
    secondary: boolean,
  ): Promise<boolean> => {
    const take = paged?.bindingProviders?.takeEyedropperSample;
    if (!paged || !take || !e.pageId || !e.pagePoint) return false;
    const result = await take
      .call(paged.bindingProviders, {
        pageId: e.pageId,
        point: [e.pagePoint[0], e.pagePoint[1]],
        sampleSize: eyedropperSampleSizeOf(paged),
        secondary,
      })
      .catch(() => null);
    return result?.resolved === true;
  };

  // A press the active context took: the drag keeps sampling into it,
  // with the press's target (Alt at the press picks the secondary one).
  let contextPress: { taken: Promise<boolean>; secondary: boolean } | null =
    null;

  return {
    onActivate(p) {
      paged = p;
    },
    onDeactivate() {
      paged = null;
      sampling = false;
      contextPress = null;
    },
    onPointerDown(e) {
      // Pixel sampling on the page happens on release, so a drag can be
      // rejected; a context that takes the sample takes it now.
      contextPress = null;
      if (!paged || eyedropperModeOf(paged) !== "pixel") return;
      if (!paged.bindingProviders?.takeEyedropperSample) return;
      const secondary = e.modifiers.alt;
      contextPress = { taken: offerToContext(e, secondary), secondary };
    },
    onPointerMove(e) {
      const press = contextPress;
      if (!press) return;
      void press.taken.then((taken) => {
        if (taken && contextPress === press)
          void offerToContext(e, press.secondary);
      });
    },
    onPointerUp(e) {
      const press = contextPress;
      contextPress = null;
      const page = () => {
        // A drag is not a sample. Same click-vs-drag rule the other
        // click tools use, so the gesture reads consistently.
        if (e.maxDelta > CLICK_DRAG_THRESHOLD_PX) return;
        void sampleAt(e);
      };
      if (!press) {
        page();
        return;
      }
      // Taken: the press and the drag sampled into the context already.
      void press.taken.then((taken) => {
        if (!taken) page();
      });
    },
  };
}
