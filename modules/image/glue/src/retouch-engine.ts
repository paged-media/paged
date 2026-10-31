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

// The RETOUCHING half of the engine facade (WP5.8): Content-Aware Fill
// (sampling area, overlay, preview, the fill with its outputs),
// Content-Aware Move, Remove, and the clone source's sampling and overlay.
// `ImageEngine` / `ImageWasmModule` extend these two interfaces, and
// `wrapEngine` spreads `wrapRetouch` in, so the doors live in one place
// (image-js/src/retouch_doors.rs on the Rust side).

/** The engine's decoded-handle shape (engine.ts `DecodedHandleWasm`). */
interface HandleWasm {
  handle: number;
  width: number;
  height: number;
  display: number;
  depth_reduced: boolean;
  free(): void;
}

/** The preview the CAF workspace shows. */
export interface CafPreviewWasm {
  readonly x: number;
  readonly y: number;
  readonly region_w: number;
  readonly region_h: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  free(): void;
}

export type ColourAdaptation = "none" | "default" | "high" | "very-high";
export type RotationAdaptation = "none" | "low" | "medium" | "high" | "full";
export type CafOutput = "current" | "new-layer" | "duplicate";
export type SampleMode = "current" | "below" | "all";
export type SpotType = "content-aware" | "create-texture" | "proximity";
export type MoveMode = "move" | "extend";

export const COLOUR_ADAPTATIONS: readonly ColourAdaptation[] = [
  "none",
  "default",
  "high",
  "very-high",
];
export const ROTATION_ADAPTATIONS: readonly RotationAdaptation[] = [
  "none",
  "low",
  "medium",
  "high",
  "full",
];
export const CAF_OUTPUTS: readonly CafOutput[] = [
  "current",
  "new-layer",
  "duplicate",
];
export const SAMPLE_MODES: readonly SampleMode[] = ["current", "below", "all"];
export const SPOT_TYPES: readonly SpotType[] = [
  "content-aware",
  "create-texture",
  "proximity",
];

/** The fill settings of the CAF workspace. */
export interface FillSettings {
  colour: ColourAdaptation;
  rotation: RotationAdaptation;
  scale: boolean;
  mirror: boolean;
  seed: number;
}

/** The clone stroke's sampling (`brush_stroke_set_sampling`). */
export interface StrokeSampling {
  mode: SampleMode;
  scaleX: number;
  scaleY: number;
  angleDeg: number;
  /** `source − destination`, or null to fix it at the first dab. */
  offset: [number, number] | null;
  /** 1–7, or 0 for the pure membrane. */
  diffusion: number;
  spot: SpotType;
}

export interface CafPreview {
  /** The crop in image px. */
  x: number;
  y: number;
  regionW: number;
  regionH: number;
  /** The preview's own pixels. */
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface MoveRequest {
  dx: number;
  dy: number;
  mode: MoveMode;
  structure: number;
  colour: number;
  scale: number;
  angleDeg: number;
  sampleAll: boolean;
}

/** One clone-overlay read (`clone_overlay`). */
export interface CloneOverlayRequest {
  cursor: [number, number];
  anchor: [number, number];
  offset: [number, number] | null;
  scaleX: number;
  scaleY: number;
  angleDeg: number;
  /** 0–1. */
  opacity: number;
  invert: boolean;
  /** Radius in image px, or 0 for the whole image. */
  clipRadius: number;
  mode: SampleMode;
}

/** The raw wasm doors (parsed by test/wasm-surface.spec.ts). */
export interface RetouchWasm {
  caf_sampling_area(handle: number, kind: string): Uint8Array;
  caf_overlay(handle: number, sample: Uint8Array, opacity: number): Uint8Array;
  caf_preview(
    handle: number,
    sample: Uint8Array,
    colour: string,
    rotation: string,
    scale: boolean,
    mirror: boolean,
    seed: number,
    max_side: number,
    sample_all: boolean,
  ): CafPreviewWasm;
  content_aware_fill_ex(
    handle: number,
    sample: Uint8Array,
    colour: string,
    rotation: string,
    scale: boolean,
    mirror: boolean,
    seed: number,
    output: string,
    sample_all: boolean,
  ): Promise<HandleWasm>;
  content_aware_move(
    handle: number,
    dx: number,
    dy: number,
    mode: string,
    structure: number,
    colour: number,
    scale: number,
    angle_deg: number,
    sample_all: boolean,
  ): Promise<HandleWasm>;
  remove_hole(handle: number, points: Float32Array, size: number): Uint8Array;
  remove_stroke(
    handle: number,
    points: Float32Array,
    size: number,
    sample_all: boolean,
    seed: number,
  ): Promise<HandleWasm>;
  remove_with_pixels(
    handle: number,
    filled: Uint8Array,
    points: Float32Array,
    size: number,
  ): Promise<HandleWasm>;
  brush_stroke_set_sampling(
    mode: string,
    scale_x: number,
    scale_y: number,
    angle_deg: number,
    has_offset: boolean,
    offset_x: number,
    offset_y: number,
    diffusion: number,
    spot: string,
  ): Promise<void>;
  brush_stroke_source_offset(): Float32Array;
  clone_overlay(
    handle: number,
    cursor_x: number,
    cursor_y: number,
    anchor_x: number,
    anchor_y: number,
    has_offset: boolean,
    offset_x: number,
    offset_y: number,
    scale_x: number,
    scale_y: number,
    angle_deg: number,
    opacity: number,
    invert: boolean,
    clip_radius: number,
    mode: string,
  ): Promise<Uint8Array>;
}

/** The facade the session calls. */
export interface RetouchEngine<Info> {
  /** The automatic sampling area (`auto` | `rect`) for the selection. */
  cafSamplingArea(handle: number, kind: "auto" | "rect"): Uint8Array;
  /** The composite with the sampling area tinted. */
  cafOverlay(handle: number, sample: Uint8Array, opacity: number): Uint8Array;
  /** A reduced preview of the fill around the selection. */
  cafPreview(
    handle: number,
    sample: Uint8Array | null,
    fill: FillSettings,
    maxSide: number,
    sampleAll: boolean,
  ): CafPreview;
  /** The fill, landed as one undo step in `output`. */
  contentAwareFillEx(
    handle: number,
    sample: Uint8Array | null,
    fill: FillSettings,
    output: CafOutput,
    sampleAll: boolean,
  ): Promise<Info>;
  contentAwareMove(handle: number, req: MoveRequest): Promise<Info>;
  removeHole(handle: number, points: number[], size: number): Uint8Array;
  removeStroke(
    handle: number,
    points: number[],
    size: number,
    sampleAll: boolean,
    seed: number,
  ): Promise<Info>;
  removeWithPixels(
    handle: number,
    filled: Uint8Array,
    points: number[],
    size: number,
  ): Promise<Info>;
  brushSetSampling(s: StrokeSampling): Promise<void>;
  /** The in-flight stroke's fixed `source − destination` offset. */
  brushSourceOffset(): [number, number] | null;
  cloneOverlay(handle: number, req: CloneOverlayRequest): Promise<Uint8Array>;
}

const EMPTY = new Uint8Array(0);

export function wrapRetouch<Info>(
  wasm: RetouchWasm,
  info: (h: HandleWasm) => Info,
): RetouchEngine<Info> {
  return {
    cafSamplingArea: (handle, kind) => wasm.caf_sampling_area(handle, kind),
    cafOverlay: (handle, sample, opacity) =>
      wasm.caf_overlay(handle, sample, opacity),
    cafPreview(handle, sample, f, maxSide, sampleAll) {
      const p = wasm.caf_preview(
        handle,
        sample ?? EMPTY,
        f.colour,
        f.rotation,
        f.scale,
        f.mirror,
        f.seed >>> 0,
        maxSide,
        sampleAll,
      );
      const out: CafPreview = {
        x: p.x,
        y: p.y,
        regionW: p.region_w,
        regionH: p.region_h,
        width: p.width,
        height: p.height,
        rgba: p.rgba,
      };
      p.free();
      return out;
    },
    async contentAwareFillEx(handle, sample, f, output, sampleAll) {
      return info(
        await wasm.content_aware_fill_ex(
          handle,
          sample ?? EMPTY,
          f.colour,
          f.rotation,
          f.scale,
          f.mirror,
          f.seed >>> 0,
          output,
          sampleAll,
        ),
      );
    },
    async contentAwareMove(handle, r) {
      return info(
        await wasm.content_aware_move(
          handle,
          r.dx,
          r.dy,
          r.mode,
          r.structure,
          r.colour,
          r.scale,
          r.angleDeg,
          r.sampleAll,
        ),
      );
    },
    removeHole: (handle, points, size) =>
      wasm.remove_hole(handle, new Float32Array(points), size),
    async removeStroke(handle, points, size, sampleAll, seed) {
      return info(
        await wasm.remove_stroke(
          handle,
          new Float32Array(points),
          size,
          sampleAll,
          seed >>> 0,
        ),
      );
    },
    async removeWithPixels(handle, filled, points, size) {
      return info(
        await wasm.remove_with_pixels(
          handle,
          filled,
          new Float32Array(points),
          size,
        ),
      );
    },
    brushSetSampling: (s) =>
      wasm.brush_stroke_set_sampling(
        s.mode,
        s.scaleX,
        s.scaleY,
        s.angleDeg,
        s.offset !== null,
        s.offset?.[0] ?? 0,
        s.offset?.[1] ?? 0,
        s.diffusion,
        s.spot,
      ),
    brushSourceOffset() {
      const o = wasm.brush_stroke_source_offset();
      return o.length === 2 ? [o[0], o[1]] : null;
    },
    cloneOverlay: (handle, r) =>
      wasm.clone_overlay(
        handle,
        r.cursor[0],
        r.cursor[1],
        r.anchor[0],
        r.anchor[1],
        r.offset !== null,
        r.offset?.[0] ?? 0,
        r.offset?.[1] ?? 0,
        r.scaleX,
        r.scaleY,
        r.angleDeg,
        r.opacity,
        r.invert,
        r.clipRadius,
        r.mode,
      ),
  };
}
