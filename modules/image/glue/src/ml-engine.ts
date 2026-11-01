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

// The GENERATED-PIXELS half of the engine facade (WP8.2, image ADR 485):
// where the ML features land what the host's ML service answered — a new
// pixel layer with its mask, pixels inside a hole, a layer's mask, an
// expanded canvas with its border layer. Each is ONE undo step. The doors
// live in image-js/src/ml_doors.rs; no model runs in this wasm.

/** The engine's decoded-handle shape (engine.ts `DecodedHandleWasm`). */
interface HandleWasm {
  handle: number;
  width: number;
  height: number;
  display: number;
  depth_reduced: boolean;
  free(): void;
}

export interface MlWasm {
  ml_layer_add(
    handle: number,
    label: string,
    name: string,
    rgba: Uint8Array,
    mask: Uint8Array,
  ): Promise<HandleWasm>;
  ml_land_hole(
    handle: number,
    label: string,
    filled: Uint8Array,
    hole: Uint8Array,
  ): Promise<HandleWasm>;
  ml_layer_mask(
    handle: number,
    label: string,
    index: number,
    mask: Uint8Array,
  ): Promise<HandleWasm>;
  ml_expand(
    handle: number,
    label: string,
    name: string,
    width: number,
    height: number,
    anchor_x: number,
    anchor_y: number,
    rgba: Uint8Array,
    mask: Uint8Array,
  ): Promise<Uint32Array>;
}

/** The facade the session calls. */
export interface MlEngine<Info> {
  /** A new pixel layer above the active one (canvas-extent RGBA8), with
   *  `mask` (canvas-extent coverage) as its layer mask when given. */
  mlLayerAdd(
    handle: number,
    label: string,
    name: string,
    rgba: Uint8Array,
    mask: Uint8Array | null,
  ): Promise<Info>;
  /** `filled` landed in the active layer where `hole` is set. */
  mlLandHole(
    handle: number,
    label: string,
    filled: Uint8Array,
    hole: Uint8Array,
  ): Promise<Info>;
  /** Layer `index`'s mask from coverage (replacing one it had). */
  mlLayerMask(
    handle: number,
    label: string,
    index: number,
    mask: Uint8Array,
  ): Promise<Info>;
  /** The canvas grown to `width`×`height` at the anchor (0, 1, 2 per
   *  axis) and a layer holding `rgba` masked by `mask`, both at the new
   *  extent. Answers the new extent. */
  mlExpand(
    handle: number,
    label: string,
    name: string,
    size: { width: number; height: number; anchorX: number; anchorY: number },
    rgba: Uint8Array,
    mask: Uint8Array,
  ): Promise<{ width: number; height: number }>;
}

const EMPTY = new Uint8Array(0);

export function wrapMl<Info>(
  wasm: MlWasm,
  info: (h: HandleWasm) => Info,
): MlEngine<Info> {
  return {
    async mlLayerAdd(handle, label, name, rgba, mask) {
      return info(
        await wasm.ml_layer_add(handle, label, name, rgba, mask ?? EMPTY),
      );
    },
    async mlLandHole(handle, label, filled, hole) {
      return info(await wasm.ml_land_hole(handle, label, filled, hole));
    },
    async mlLayerMask(handle, label, index, mask) {
      return info(await wasm.ml_layer_mask(handle, label, index, mask));
    },
    async mlExpand(handle, label, name, size, rgba, mask) {
      const wh = await wasm.ml_expand(
        handle,
        label,
        name,
        size.width,
        size.height,
        size.anchorX,
        size.anchorY,
        rgba,
        mask,
      );
      return { width: wh[0]!, height: wh[1]! };
    },
  };
}
