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

// The ML FEATURE CONTROLLER (WP8.2, image ADR 485): what the image module
// does with the host's ML doors (`host.ml`, extensions ADR 1100). Tier A
// answers here — Select Subject, Select Sky, Object Selection and the
// hair-matting hook of Select and Mask. No model runs in this bundle, none
// is bundled or downloaded by it: the host's registry owns that, and every
// refusal is the registry's own message ("local image model not running"…).

import type { BundleHost, MlFace } from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import {
  selectionModeCode,
  type DecodedInfo,
  type ImageEngine,
  type SelectionMode,
} from "./engine";
import type { MattingProvider } from "./masking-session";

const S = defineMessages("image.ml", {
  needsImage: "Open an image first.",
  busy: "Working with the local image model…",
  selectedSubject: "Selected the subject with {provider}.",
  selectedSky: "Selected the sky with {provider}.",
  selectedObject: "Selected the object with {provider}.",
  empty: "The model found nothing to select.",
  failed: "{what} failed: {error}",
  needsSelection: "{what} needs a selection: select the area first.",
  needsPrompt: "{what} needs a prompt: say what the result should show.",
  landed: "{what} added a layer with {provider}, one undo step.",
  landedHole: "{what} filled the selection with {provider}, one undo step.",
  expanded: "{what} grew the canvas to {width}×{height} with {provider}.",
  matted: "{what} masked the layer with {provider}, one undo step.",
  variations: "{count} variations ready: place one.",
  tooBig: "{what}: the area is too large for the model (at most 4096 px).",
  tooManyReferences: "At most {max} reference images.",
  noFaceModel:
    "No landmarks model is available: install one in Settings to use the " +
    "face sliders. Nothing is downloaded from here.",
  noFaces: "The model found no face with usable landmarks in this image.",
});

const SUBJECT = "Select Subject";
const SKY = "Select Sky";
const OBJECT = "Object Selection";
const FILL = "Generative Fill";
const EXPAND = "Generative Expand";
const REMOVE_HQ = "Remove";
const REMOVE_BG = "Remove Background";
const GENERATE = "Generate Image";
const SUPER_ZOOM = "Super Zoom";
const JPEG = "JPEG Artifact Removal";
const SKY_REPLACE = "Sky Replacement";
const COLORIZE = "Colorize";
const SKIN = "Skin Smoothing";

/** The longest side a Tier B model is given; the region is shrunk to it
 *  and the answer is enlarged back. */
export const WORK_SIDE = 1024;
/** The sizes the generative host takes: multiples of 8 from 64 to 4096. */
export const MIN_SIDE = 64;
export const MAX_SIDE = 4096;

/** The prompts of the presets (Tier B edits with a mask). */
export const PRESET_PROMPTS = {
  skyReplacement: (style: string) =>
    `replace the sky with ${style || "a clear blue sky with soft clouds"}, keep the horizon and lighting natural`,
  colorize:
    "colorize this image with natural, realistic colors, keep every detail",
  skinSmoothing:
    "smooth the skin gently, remove blemishes, keep pores and texture natural",
} as const;

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** What the session lends this module. */
export interface MlFeatureDeps {
  host: BundleHost;
  state(): {
    source: { handle: number; width: number; height: number } | null;
    ml: MlUiState;
  };
  engine(): ImageEngine | null;
  emit(): void;
  setStatus(s: string): void;
  /** The selection changed in the engine: refresh the readout and history. */
  refreshSelection(): void;
  /** Adopt an edit's result (layered: same handle, recomposite). */
  adopt(out: DecodedInfo): Promise<boolean>;
  /** The canvas grew: adopt the new extent. */
  adoptExtent(wh: { width: number; height: number }): Promise<void>;
  /** Index of the layer edits land in. */
  activeLayer(): number;
  /** The open stack's rows (a reference image names a layer by its id). */
  layers(): ReadonlyArray<{ id: number; index: number; kind: string }>;
  /** Drop an in-flight stroke engine-side. */
  discardStroke(): void;
  /** The classical fallback of Remove over a selection. */
  fillContentAware(): Promise<boolean>;
}

/** A pixel rectangle. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The size a region is given to a model: the long side to at most
 *  `WORK_SIDE`, both sides rounded to multiples of 8 within 64..4096. */
export function workSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const k = Math.min(1, WORK_SIDE / Math.max(width, height));
  const snap = (v: number) =>
    Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round((v * k) / 8) * 8));
  return { width: snap(width), height: snap(height) };
}

/** `box` grown by `context` (a fraction of its larger side, at least 32
 *  px) on every side, clipped to the canvas. */
export function paddedBox(
  box: Rect,
  canvasW: number,
  canvasH: number,
  context = 0.5,
): Rect {
  const pad = Math.max(
    32,
    Math.round(Math.max(box.width, box.height) * context),
  );
  const x0 = Math.max(0, box.x - pad);
  const y0 = Math.max(0, box.y - pad);
  const x1 = Math.min(canvasW, box.x + box.width + pad);
  const y1 = Math.min(canvasH, box.y + box.height + pad);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The bounding box of the set bytes of a canvas-extent mask. */
export function maskBox(
  mask: Uint8Array,
  width: number,
  height: number,
): Rect | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x]! !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0
    ? null
    : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** `box` of a canvas-extent RGBA buffer (or one channel when `stride` is
 *  1). */
export function crop(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  box: Rect,
  stride: 1 | 4,
): Uint8Array {
  const out = new Uint8Array(box.width * box.height * stride);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * width + box.x) * stride;
    out.set(
      data.subarray(from, from + box.width * stride),
      y * box.width * stride,
    );
  }
  return out;
}

/** `piece` written into a canvas-extent buffer at `box`. */
export function paste(
  into: Uint8Array,
  width: number,
  box: Rect,
  piece: Uint8Array,
  stride: 1 | 4,
): void {
  for (let y = 0; y < box.height; y++)
    into.set(
      piece.subarray(y * box.width * stride, (y + 1) * box.width * stride),
      ((box.y + y) * width + box.x) * stride,
    );
}

/** A generated image waiting in the Generate panel's strip. */
export interface MlCandidate {
  id: number;
  width: number;
  height: number;
  /** Straight RGBA8. */
  data: Uint8ClampedArray;
  provider: string;
}

/** What the panels read (the session's `state().ml`). */
export interface MlUiState {
  busy: boolean;
  candidates: MlCandidate[];
  /** The feature running, or the last refusal's text. */
  note: string | null;
  /** The layer ids picked as reference images for Generative Fill (the
   *  Links panel's smart objects), at most {@link MAX_REFERENCES}. */
  references: number[];
}

/** The most reference images `ml.edit` takes. */
export const MAX_REFERENCES = 10;

export function initialMl(): MlUiState {
  return { busy: false, candidates: [], note: null, references: [] };
}

/** Options of the prompt-driven features. */
export interface GenerateOptions {
  seed?: number;
  steps?: number;
  strength?: number;
  /** Layer ids whose pixels guide the edit (at most ten); absent: the
   *  panel's picked ones. */
  references?: readonly number[];
}

/** An Object Selection gesture: a box, or a point, in image pixels. */
export type ObjectHint =
  | { box: { x: number; y: number; width: number; height: number } }
  | { point: { x: number; y: number } };

/** Points along the top edge the Select Sky segmentation is prompted with:
 *  seven positives at 3 % of the height. */
export function skyPoints(
  width: number,
  height: number,
): Array<{ x: number; y: number; label: 1 }> {
  const y = Math.max(0, Math.min(height - 1, Math.round(height * 0.03)));
  const out: Array<{ x: number; y: number; label: 1 }> = [];
  for (let i = 0; i < 7; i++) {
    const x = Math.round(((i + 0.5) / 7) * (width - 1));
    out.push({ x, y, label: 1 });
  }
  return out;
}

/** The trimap-guided alpha the hair-matting hook returns: the model's
 *  alpha inside the trimap's unknown band, the trimap's own 0 / 255
 *  everywhere else (the known regions stay exactly as drawn). */
export function blendMatte(alpha: Uint8Array, trimap: Uint8Array): Uint8Array {
  const out = new Uint8Array(trimap.length);
  for (let i = 0; i < out.length; i++) {
    const tri = trimap[i]!;
    out[i] = tri === 0 || tri === 255 ? tri : alpha[i]!;
  }
  return out;
}

export function makeMlFeatures(d: MlFeatureDeps) {
  const sees = (): { handle: number; width: number; height: number } | null => {
    const src = d.state().source;
    if (!src || !d.engine()) {
      d.setStatus(t(S.needsImage));
      return null;
    }
    return src;
  };

  const imageOf = (src: { handle: number; width: number; height: number }) => ({
    width: src.width,
    height: src.height,
    data: new Uint8ClampedArray(
      d.engine()!.tile(src.handle, 0, 0, src.width, src.height),
    ),
  });

  /** Put a mask in as the selection under `mode`. */
  const adoptMask = (
    label: string,
    mask: Uint8Array,
    mode: SelectionMode,
  ): boolean => {
    if (!mask.some((b) => b !== 0)) {
      d.setStatus(t(S.empty));
      return false;
    }
    d.engine()!.mlSelect(label, mask, selectionModeCode(mode));
    d.refreshSelection();
    return true;
  };

  /** Segment, then select. */
  const segmentSelect = async (
    what: string,
    done: typeof S.selectedSubject,
    request: (src: {
      handle: number;
      width: number;
      height: number;
    }) => Record<string, unknown>,
    mode: SelectionMode,
  ): Promise<boolean> => {
    const src = sees();
    if (!src) return false;
    d.setStatus(t(S.busy));
    try {
      const res = await d.host.ml.segment({
        image: imageOf(src),
        ...request(src),
      });
      if (
        res.mask.width !== src.width ||
        res.mask.height !== src.height ||
        !d.state().source ||
        d.state().source!.handle !== src.handle
      )
        return false;
      const ok = adoptMask(what, res.mask.data, mode);
      if (ok) d.setStatus(t(done, { provider: res.provider }));
      return ok;
    } catch (err) {
      d.setStatus(t(S.failed, { what, error: errText(err) }));
      return false;
    }
  };

  /** The hair-matting hook of Select and Mask: asks `ml.matting` for the
   *  foreground alpha, looked up on every call, and keeps the trimap's
   *  known regions. Null (the classical solve decides) when none runs. */
  const mattingProvider: MattingProvider = {
    available: () => d.host.supports("ml.matting@1"),
    async solve(rgba, width, height, trimap) {
      if (!d.host.supports("ml.matting@1")) return null;
      try {
        const res = await d.host.ml.matting({
          image: { width, height, data: new Uint8ClampedArray(rgba) },
        });
        if (res.alpha.width !== width || res.alpha.height !== height)
          return null;
        return blendMatte(res.alpha.data, trimap);
      } catch (err) {
        d.host.log.debug("ml.matting failed", err);
        return null;
      }
    },
  };

  // ── Tier B and the neural filters ────────────────────────────────

  let nextCandidate = 1;

  /** Run `f` with the panel's busy flag up; a refusal is the status. */
  const track = async <T>(
    what: string,
    f: () => Promise<T>,
    fail: T,
  ): Promise<T> => {
    const ui = d.state().ml;
    ui.busy = true;
    ui.note = t(S.busy);
    d.emit();
    try {
      return await f();
    } catch (err) {
      const msg = t(S.failed, { what, error: errText(err) });
      d.state().ml.note = msg;
      d.setStatus(msg);
      return fail;
    } finally {
      d.state().ml.busy = false;
      d.emit();
    }
  };

  const resizeRgba = (
    rgba: Uint8Array | Uint8ClampedArray,
    w: number,
    h: number,
    ow: number,
    oh: number,
  ): Uint8Array => {
    if (w === ow && h === oh) return new Uint8Array(rgba);
    const eng = d.engine()!;
    const a = eng.ingestRgba8(w, h, new Uint8Array(rgba));
    try {
      const b = eng.resizeCpu(a.handle, ow, oh, "lanczos3");
      try {
        return eng.tile(b.handle, 0, 0, ow, oh).slice();
      } finally {
        eng.freeImage(b.handle);
      }
    } finally {
      eng.freeImage(a.handle);
    }
  };
  const resizeMask = (
    mask: Uint8Array,
    w: number,
    h: number,
    ow: number,
    oh: number,
  ): Uint8Array => {
    if (w === ow && h === oh) return new Uint8Array(mask);
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < mask.length; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = mask[i]!;
      rgba[i * 4 + 3] = 255;
    }
    const out = resizeRgba(rgba, w, h, ow, oh);
    const m = new Uint8Array(ow * oh);
    for (let i = 0; i < m.length; i++) m[i] = out[i * 4]!;
    return m;
  };

  const compositeOf = (src: {
    handle: number;
    width: number;
    height: number;
  }) => d.engine()!.tile(src.handle, 0, 0, src.width, src.height);

  /** The pixels of the layers `ids` name, each fitted to the model's size
   *  (the layer's own pixels over the canvas, not the composite). A layer
   *  that is gone or has no pixels is skipped. */
  const referenceImages = (
    ids: readonly number[] | undefined,
  ): Array<{ width: number; height: number; data: Uint8ClampedArray }> => {
    const src = d.state().source;
    if (!ids || ids.length === 0 || !src) return [];
    if (ids.length > MAX_REFERENCES)
      throw new Error(t(S.tooManyReferences, { max: MAX_REFERENCES }));
    const out: Array<{
      width: number;
      height: number;
      data: Uint8ClampedArray;
    }> = [];
    for (const id of ids) {
      const row = d.layers().find((l) => l.id === id);
      if (!row) continue;
      const px = d
        .engine()!
        .layersWindow(row.index, 0, 0, src.width, src.height);
      if (px.length !== src.width * src.height * 4) continue;
      const ws = workSize(src.width, src.height);
      out.push({
        width: ws.width,
        height: ws.height,
        data: new Uint8ClampedArray(
          resizeRgba(px, src.width, src.height, ws.width, ws.height),
        ),
      });
    }
    return out;
  };

  /** Ask `ml.edit` to change the masked part of `box`: the region (with its
   *  context) is shrunk to the model's size, edited, and enlarged back.
   *  Answers canvas-extent RGBA (transparent outside `box`). */
  const editRegion = async (
    src: { handle: number; width: number; height: number },
    prompt: string,
    box: Rect,
    mask: Uint8Array,
    o: GenerateOptions,
    tier?: "A" | "B",
  ): Promise<{ pixels: Uint8Array; provider: string }> => {
    const ws = workSize(box.width, box.height);
    const image = resizeRgba(
      crop(compositeOf(src), src.width, box, 4),
      box.width,
      box.height,
      ws.width,
      ws.height,
    );
    const m = resizeMask(
      crop(mask, src.width, box, 1),
      box.width,
      box.height,
      ws.width,
      ws.height,
    );
    const references = referenceImages(o.references);
    const res = await d.host.ml.edit(
      {
        prompt,
        image: {
          width: ws.width,
          height: ws.height,
          data: new Uint8ClampedArray(image),
        },
        mask: { width: ws.width, height: ws.height, data: m },
        ...(references.length > 0 ? { references } : {}),
        ...(o.seed !== undefined ? { seed: o.seed } : {}),
        ...(o.steps !== undefined ? { steps: o.steps } : {}),
        ...(o.strength !== undefined ? { strength: o.strength } : {}),
      },
      tier ? { tier } : undefined,
    );
    if (res.image.width !== ws.width || res.image.height !== ws.height)
      throw new Error("the model answered another size");
    const back = resizeRgba(
      res.image.data,
      ws.width,
      ws.height,
      box.width,
      box.height,
    );
    for (let i = 3; i < back.length; i += 4) back[i] = 255;
    const pixels = new Uint8Array(src.width * src.height * 4);
    paste(pixels, src.width, box, back, 4);
    return { pixels, provider: res.provider };
  };

  /** The selection's coverage and its padded box, or a status. */
  const selectionOf = (
    what: string,
    src: { width: number; height: number },
  ): { mask: Uint8Array; box: Rect } | null => {
    const cov = d.engine()!.selectionCoverageBytes();
    const sb =
      cov.length === src.width * src.height
        ? maskBox(cov, src.width, src.height)
        : null;
    if (!sb) {
      d.setStatus(t(S.needsSelection, { what }));
      return null;
    }
    return {
      mask: new Uint8Array(cov),
      box: paddedBox(sb, src.width, src.height),
    };
  };

  const needPrompt = (what: string, prompt: string): boolean => {
    if (prompt.trim() !== "") return true;
    d.setStatus(t(S.needsPrompt, { what }));
    return false;
  };

  /** A masked edit landing as a new layer (Generative Fill and the presets). */
  const fillLayer = (
    what: string,
    prompt: string,
    o: GenerateOptions,
    over?: { mask: Uint8Array; box: Rect },
  ): Promise<boolean> =>
    track(
      what,
      async () => {
        const src = sees();
        if (!src || !needPrompt(what, prompt)) return false;
        const sel = over ?? selectionOf(what, src);
        if (!sel) return false;
        d.discardStroke();
        const r = await editRegion(src, prompt, sel.box, sel.mask, o);
        const out = await d
          .engine()!
          .mlLayerAdd(
            src.handle,
            what,
            prompt.slice(0, 48),
            r.pixels,
            sel.mask,
          );
        const ok = await d.adopt(out);
        if (ok) d.setStatus(t(S.landed, { what, provider: r.provider }));
        return ok;
      },
      false,
    );

  const whole = (src: { width: number; height: number }) => ({
    mask: new Uint8Array(src.width * src.height).fill(255),
    box: { x: 0, y: 0, width: src.width, height: src.height },
  });

  /** A new layer from `rgba` fitted (contain, centred) into the canvas. */
  const layerFromImage = async (
    what: string,
    name: string,
    img: { width: number; height: number; data: ArrayLike<number> },
    mask: Uint8Array | null,
  ): Promise<boolean> => {
    const src = sees();
    if (!src) return false;
    const k = Math.min(src.width / img.width, src.height / img.height);
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    const fitted = resizeRgba(
      new Uint8Array(Array.from(img.data as ArrayLike<number>)),
      img.width,
      img.height,
      w,
      h,
    );
    const pixels = new Uint8Array(src.width * src.height * 4);
    paste(
      pixels,
      src.width,
      {
        x: Math.floor((src.width - w) / 2),
        y: Math.floor((src.height - h) / 2),
        width: w,
        height: h,
      },
      fitted,
      4,
    );
    d.discardStroke();
    const out = await d
      .engine()!
      .mlLayerAdd(src.handle, what, name, pixels, mask);
    return d.adopt(out);
  };

  const placeCandidate = async (
    c: MlCandidate,
    prompt: string,
  ): Promise<boolean> => {
    const ok = await layerFromImage(GENERATE, prompt.slice(0, 48), c, null);
    if (ok) d.setStatus(t(S.landed, { what: GENERATE, provider: c.provider }));
    return ok;
  };

  /** The hairline `superres` check and cap shared by the neural filters. */
  const superOf = async (
    image: { width: number; height: number; data: Uint8ClampedArray },
    scale: 2 | 4,
    what: string,
  ) => {
    if (Math.max(image.width, image.height) > 2048)
      throw new Error(t(S.tooBig, { what }));
    return d.host.ml.superres({ image, scale });
  };

  return {
    /** SELECT SUBJECT: the most salient subject becomes the selection. */
    selectSubject(mode: SelectionMode = "replace"): Promise<boolean> {
      return segmentSelect(SUBJECT, S.selectedSubject, () => ({}), mode);
    },
    /** SELECT SKY: segmentation prompted along the top edge. */
    selectSky(mode: SelectionMode = "replace"): Promise<boolean> {
      return segmentSelect(
        SKY,
        S.selectedSky,
        (src) => ({ points: skyPoints(src.width, src.height) }),
        mode,
      );
    },
    /** OBJECT SELECTION: the object in a box, or under a point. */
    selectObject(
      hint: ObjectHint,
      mode: SelectionMode = "replace",
    ): Promise<boolean> {
      return segmentSelect(
        OBJECT,
        S.selectedObject,
        (src) =>
          "box" in hint
            ? { box: hint.box }
            : {
                points: [
                  {
                    x: Math.max(0, Math.min(src.width - 1, hint.point.x)),
                    y: Math.max(0, Math.min(src.height - 1, hint.point.y)),
                    label: 1,
                  },
                ],
              },
        mode,
      );
    },
    // ── Tier B ──

    /** GENERATIVE FILL: the selection filled by `ml.edit` from `prompt`, a
     *  new layer masked by the selection. */
    generativeFill(prompt: string, o: GenerateOptions = {}): Promise<boolean> {
      return fillLayer(FILL, prompt, {
        ...o,
        references: o.references ?? d.state().ml.references,
      });
    },

    /** Pick the layers (smart objects of the Links panel) whose pixels
     *  guide Generative Fill: at most ten, ids of the open stack. */
    setReferences(ids: readonly number[]): boolean {
      if (ids.length > MAX_REFERENCES) {
        d.setStatus(t(S.tooManyReferences, { max: MAX_REFERENCES }));
        return false;
      }
      d.state().ml.references = [...new Set(ids)];
      d.emit();
      return true;
    },

    /** The faces `ml.landmarks` finds in the open image, for face-aware
     *  Liquify: `unavailable` when no model answers (the hint says so),
     *  `none` when it found no face it can read. Nothing is downloaded. */
    async detectFaces(): Promise<
      | { status: "found"; faces: MlFace[] }
      | { status: "none" | "unavailable"; faces: [] }
    > {
      const src = d.state().source;
      if (!src || !d.engine()) return { status: "none", faces: [] };
      let faces: readonly MlFace[];
      try {
        faces = (await d.host.ml.landmarks({ image: imageOf(src) })).faces;
      } catch (err) {
        d.host.log.debug("landmarks unavailable", err);
        d.setStatus(t(S.noFaceModel));
        return { status: "unavailable", faces: [] };
      }
      if (faces.length === 0) {
        d.setStatus(t(S.noFaces));
        return { status: "none", faces: [] };
      }
      return { status: "found", faces: [...faces] };
    },

    /** GENERATIVE EXPAND: the canvas grown to `width`×`height` at the anchor
     *  (0 left/top, 1 centre, 2 right/bottom per axis) and the new border
     *  filled by `ml.edit`, as a masked layer. One undo step. */
    generativeExpand(
      prompt: string,
      size: { width: number; height: number; anchorX: number; anchorY: number },
      o: GenerateOptions = {},
    ): Promise<boolean> {
      return track(
        EXPAND,
        async () => {
          const src = sees();
          if (!src) return false;
          if (
            size.width < src.width ||
            size.height < src.height ||
            (size.width === src.width && size.height === src.height)
          )
            throw new Error("the canvas must grow");
          if (size.width > 16384 || size.height > 16384)
            throw new Error(t(S.tooBig, { what: EXPAND }));
          const nw = size.width;
          const nh = size.height;
          const ox =
            size.anchorX === 0
              ? 0
              : size.anchorX === 1
                ? Math.floor((nw - src.width) / 2)
                : nw - src.width;
          const oy =
            size.anchorY === 0
              ? 0
              : size.anchorY === 1
                ? Math.floor((nh - src.height) / 2)
                : nh - src.height;
          const grown = new Uint8Array(nw * nh * 4);
          paste(
            grown,
            nw,
            { x: ox, y: oy, width: src.width, height: src.height },
            compositeOf(src),
            4,
          );
          const border = new Uint8Array(nw * nh).fill(255);
          paste(
            border,
            nw,
            { x: ox, y: oy, width: src.width, height: src.height },
            new Uint8Array(src.width * src.height),
            1,
          );
          const ws = workSize(nw, nh);
          const res = await d.host.ml.edit({
            prompt:
              prompt.trim() === "" ? "extend the image naturally" : prompt,
            image: {
              width: ws.width,
              height: ws.height,
              data: new Uint8ClampedArray(
                resizeRgba(grown, nw, nh, ws.width, ws.height),
              ),
            },
            mask: {
              width: ws.width,
              height: ws.height,
              data: resizeMask(border, nw, nh, ws.width, ws.height),
            },
            ...(o.seed !== undefined ? { seed: o.seed } : {}),
            ...(o.steps !== undefined ? { steps: o.steps } : {}),
          });
          if (res.image.width !== ws.width || res.image.height !== ws.height)
            throw new Error("the model answered another size");
          const back = resizeRgba(res.image.data, ws.width, ws.height, nw, nh);
          for (let i = 3; i < back.length; i += 4) back[i] = 255;
          d.discardStroke();
          const wh = await d
            .engine()!
            .mlExpand(
              src.handle,
              EXPAND,
              (prompt.trim() || "Expand").slice(0, 48),
              size,
              back,
              border,
            );
          await d.adoptExtent(wh);
          d.setStatus(
            t(S.expanded, {
              what: EXPAND,
              width: wh.width,
              height: wh.height,
              provider: res.provider,
            }),
          );
          return true;
        },
        false,
      );
    },

    /** REMOVE (high quality) over the selection: Tier B edit, else Tier A
     *  inpaint, else the classical content-aware fill. One undo step. */
    removeSelection(): Promise<boolean> {
      return track(
        REMOVE_HQ,
        async () => {
          const src = sees();
          if (!src) return false;
          const sel = selectionOf(REMOVE_HQ, src);
          if (!sel) return false;
          d.discardStroke();
          let filled: Uint8Array | null = null;
          let provider = "";
          try {
            const r = await editRegion(
              src,
              "remove the masked object and fill the area with the matching surrounding background",
              sel.box,
              sel.mask,
              {},
              "B",
            );
            filled = r.pixels;
            provider = r.provider;
          } catch (err) {
            d.host.log.debug("ml.edit remove failed", err);
          }
          if (!filled) {
            try {
              const res = await d.host.ml.inpaint({
                image: {
                  width: src.width,
                  height: src.height,
                  data: new Uint8ClampedArray(compositeOf(src)),
                },
                mask: { width: src.width, height: src.height, data: sel.mask },
              });
              if (
                res.image.width === src.width &&
                res.image.height === src.height
              ) {
                filled = new Uint8Array(res.image.data);
                provider = res.provider;
              }
            } catch (err) {
              d.host.log.debug("ml.inpaint remove failed", err);
            }
          }
          if (!filled) return d.fillContentAware();
          const out = await d
            .engine()!
            .mlLandHole(src.handle, REMOVE_HQ, filled, sel.mask);
          const ok = await d.adopt(out);
          if (ok) d.setStatus(t(S.landedHole, { what: REMOVE_HQ, provider }));
          return ok;
        },
        false,
      );
    },

    /** REMOVE BACKGROUND: matting (else segmentation) of the image becomes
     *  the active layer's mask. One undo step. */
    removeBackground(): Promise<boolean> {
      return track(
        REMOVE_BG,
        async () => {
          const src = sees();
          if (!src) return false;
          const image = imageOf(src);
          let alpha: Uint8Array;
          let provider: string;
          try {
            const r = await d.host.ml.matting({ image });
            alpha = r.alpha.data;
            provider = r.provider;
          } catch {
            const r = await d.host.ml.segment({ image });
            alpha = r.mask.data;
            provider = r.provider;
          }
          if (alpha.length !== src.width * src.height)
            throw new Error("the model answered another size");
          d.discardStroke();
          const out = await d
            .engine()!
            .mlLayerMask(src.handle, REMOVE_BG, d.activeLayer(), alpha);
          const ok = await d.adopt(out);
          if (ok) d.setStatus(t(S.matted, { what: REMOVE_BG, provider }));
          return ok;
        },
        false,
      );
    },

    /** GENERATE IMAGE: `variations` images from `prompt`. One variation
     *  lands directly as a layer; several wait in the panel's strip
     *  (`state().ml.candidates`) until `placeCandidate`. */
    generateImage(
      prompt: string,
      o: GenerateOptions & {
        width?: number;
        height?: number;
        variations?: number;
      } = {},
    ): Promise<boolean> {
      return track(
        GENERATE,
        async () => {
          const src = sees();
          if (!src || !needPrompt(GENERATE, prompt)) return false;
          const ws = workSize(src.width, src.height);
          const width = o.width ?? ws.width;
          const height = o.height ?? ws.height;
          const n = Math.max(1, Math.min(8, Math.round(o.variations ?? 1)));
          const out: MlCandidate[] = [];
          for (let i = 0; i < n; i++) {
            const r = await d.host.ml.generate({
              prompt,
              width,
              height,
              ...(o.steps !== undefined ? { steps: o.steps } : {}),
              ...(o.seed !== undefined && o.seed >= 0
                ? { seed: o.seed + i }
                : {}),
            });
            out.push({
              id: nextCandidate++,
              width: r.image.width,
              height: r.image.height,
              data: r.image.data,
              provider: r.provider,
            });
          }
          if (n === 1) return placeCandidate(out[0]!, prompt);
          d.state().ml.candidates = out;
          d.setStatus(t(S.variations, { count: n }));
          return true;
        },
        false,
      );
    },

    /** Land one of the strip's candidates as a layer (one undo step) and
     *  clear the strip. */
    placeCandidate(id: number, prompt = "Generated"): Promise<boolean> {
      return track(
        GENERATE,
        async () => {
          const c = d.state().ml.candidates.find((x) => x.id === id);
          if (!c || !sees()) return false;
          const ok = await placeCandidate(c, prompt);
          if (ok) d.state().ml.candidates = [];
          return ok;
        },
        false,
      );
    },

    clearCandidates(): void {
      d.state().ml.candidates = [];
      d.emit();
    },

    /** SKY REPLACEMENT: the sky (selected if nothing is) replaced from a
     *  prompt preset. */
    async skyReplacement(
      style = "",
      o: GenerateOptions = {},
    ): Promise<boolean> {
      const src = sees();
      if (!src) return false;
      if (!d.engine()!.selectionStats()) {
        if (
          !(await segmentSelect(
            SKY_REPLACE,
            S.selectedSky,
            (s) => ({ points: skyPoints(s.width, s.height) }),
            "replace",
          ))
        )
          return false;
      }
      return fillLayer(SKY_REPLACE, PRESET_PROMPTS.skyReplacement(style), o);
    },

    /** COLORIZE the selection, or the whole image. */
    colorize(o: GenerateOptions = {}): Promise<boolean> {
      const src = sees();
      if (!src) return Promise.resolve(false);
      const cov = d.engine()!.selectionCoverageBytes();
      const sel =
        cov.length === src.width * src.height &&
        maskBox(cov, src.width, src.height)
          ? selectionOf(COLORIZE, src)!
          : whole(src);
      return fillLayer(COLORIZE, PRESET_PROMPTS.colorize, o, sel);
    },

    /** SKIN SMOOTHING over the faces `ml.landmarks` finds (their boxes, as
     *  ellipses), at a low strength. */
    async skinSmoothing(o: GenerateOptions = {}): Promise<boolean> {
      const src = sees();
      if (!src) return false;
      let faces;
      try {
        faces = (await d.host.ml.landmarks({ image: imageOf(src) })).faces;
      } catch (err) {
        d.setStatus(t(S.failed, { what: SKIN, error: errText(err) }));
        return false;
      }
      if (faces.length === 0) {
        d.setStatus(t(S.empty));
        return false;
      }
      const mask = new Uint8Array(src.width * src.height);
      for (const f of faces) {
        const cx = f.box.x + f.box.width / 2;
        const cy = f.box.y + f.box.height / 2;
        const rx = Math.max(1, f.box.width / 2);
        const ry = Math.max(1, f.box.height / 2);
        for (
          let y = Math.max(0, Math.floor(f.box.y));
          y < Math.min(src.height, Math.ceil(f.box.y + f.box.height));
          y++
        )
          for (
            let x = Math.max(0, Math.floor(f.box.x));
            x < Math.min(src.width, Math.ceil(f.box.x + f.box.width));
            x++
          ) {
            const dx = (x + 0.5 - cx) / rx;
            const dy = (y + 0.5 - cy) / ry;
            if (dx * dx + dy * dy <= 1) mask[y * src.width + x] = 255;
          }
      }
      const sb = maskBox(mask, src.width, src.height);
      if (!sb) return false;
      return fillLayer(
        SKIN,
        PRESET_PROMPTS.skinSmoothing,
        { strength: 0.35, ...o },
        {
          mask,
          box: paddedBox(sb, src.width, src.height),
        },
      );
    },

    // ── Neural filters (Tier A superres) ──

    /** SUPER ZOOM: the selection (else the whole image) enlarged by the
     *  super-resolution model and fitted to the canvas as a new layer. */
    superZoom(scale: 2 | 4 = 2): Promise<boolean> {
      return track(
        SUPER_ZOOM,
        async () => {
          const src = sees();
          if (!src) return false;
          const cov = d.engine()!.selectionCoverageBytes();
          const sb =
            cov.length === src.width * src.height
              ? maskBox(cov, src.width, src.height)
              : null;
          const box = sb ?? {
            x: 0,
            y: 0,
            width: src.width,
            height: src.height,
          };
          const image = {
            width: box.width,
            height: box.height,
            data: new Uint8ClampedArray(
              crop(compositeOf(src), src.width, box, 4),
            ),
          };
          const res = await superOf(image, scale, SUPER_ZOOM);
          const ok = await layerFromImage(
            SUPER_ZOOM,
            SUPER_ZOOM,
            res.image,
            null,
          );
          if (ok)
            d.setStatus(
              t(S.landed, { what: SUPER_ZOOM, provider: res.provider }),
            );
          return ok;
        },
        false,
      );
    },

    /** JPEG ARTIFACT REMOVAL: the image enlarged ×2 by the model and scaled
     *  back down, a new layer (masked by the selection when there is one). */
    removeJpegArtifacts(): Promise<boolean> {
      return track(
        JPEG,
        async () => {
          const src = sees();
          if (!src) return false;
          const res = await superOf(imageOf(src), 2, JPEG);
          const back = resizeRgba(
            res.image.data,
            res.image.width,
            res.image.height,
            src.width,
            src.height,
          );
          const cov = d.engine()!.selectionCoverageBytes();
          const mask =
            cov.length === src.width * src.height &&
            maskBox(cov, src.width, src.height)
              ? new Uint8Array(cov)
              : null;
          d.discardStroke();
          const out = await d
            .engine()!
            .mlLayerAdd(src.handle, JPEG, JPEG, back, mask);
          const ok = await d.adopt(out);
          if (ok)
            d.setStatus(t(S.landed, { what: JPEG, provider: res.provider }));
          return ok;
        },
        false,
      );
    },

    /** The matting provider Select and Mask is given. */
    mattingProvider(): MattingProvider {
      return mattingProvider;
    },
  };
}

export type MlFeatures = ReturnType<typeof makeMlFeatures>;
