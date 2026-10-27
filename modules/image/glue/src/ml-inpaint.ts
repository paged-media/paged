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

// The Remove tool's PLUGGABLE INPAINTER (the `ml.inpaint` hook, WP8.2).
//
// Remove works without any model: the classical PatchMatch fill
// (image-js `patchmatch`) is the default and always there. A provider is
// asked FIRST when one is installed; its answer lands through the same
// one-step door, and a provider that declines (null) or fails falls back
// to the classical fill. No provider ships here, so by default this is a
// no-op.
//
// `hostInpaintProvider` adapts the host's ML service once the contract
// carries it (`host.ml.inpaint`, gated by `supports("ml.inpaint@1")`,
// extensions ADR 345 / WP8.1). It reads the door structurally so this
// bundle builds against a contract that does not have it yet.

import type { BundleHost } from "@paged-media/plugin-api";

export interface InpaintRequest {
  /** The composite, straight RGBA8. */
  rgba: Uint8Array;
  width: number;
  height: number;
  /** One byte per pixel, 255 = fill. */
  mask: Uint8Array;
}

export interface InpaintProvider {
  /** Shown in the status line ("Removed with …"). */
  readonly id: string;
  /** Canvas-extent RGBA8 with the masked pixels filled, or null to let
   *  the classical fill answer. */
  inpaint(req: InpaintRequest): Promise<Uint8Array | null>;
}

/** The host's `ml.inpaint@1` shape, as far as this hook needs it. */
interface MlInpaintDoor {
  inpaint(request: {
    image: { width: number; height: number; data: Uint8ClampedArray };
    mask: { width: number; height: number; data: Uint8Array };
  }): Promise<{
    image: { width: number; height: number; data: Uint8ClampedArray };
    provider?: { id?: string };
  }>;
}

function mlDoor(host: BundleHost): MlInpaintDoor | null {
  if (!host.supports("ml.inpaint@1")) return null;
  const ml = (host as unknown as { ml?: Partial<MlInpaintDoor> }).ml;
  return ml && typeof ml.inpaint === "function" ? (ml as MlInpaintDoor) : null;
}

/** The host ML service as a provider, or null (the default: no model). */
export function hostInpaintProvider(host: BundleHost): InpaintProvider | null {
  const door = mlDoor(host);
  if (!door) return null;
  return {
    id: "ml.inpaint",
    async inpaint({ rgba, width, height, mask }) {
      const out = await door.inpaint({
        image: { width, height, data: new Uint8ClampedArray(rgba) },
        mask: { width, height, data: mask },
      });
      if (out.image.width !== width || out.image.height !== height) return null;
      return new Uint8Array(out.image.data);
    },
  };
}
