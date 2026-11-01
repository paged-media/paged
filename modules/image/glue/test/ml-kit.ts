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

// A scripted ML provider for the image module's specs: segments the left
// half of the image (x < width / 2), mattes a flat alpha, and records each
// request. It computes, it does not imitate a model; nothing downloads.

import type { MlProvider } from "@paged-media/plugin-sdk";

/** A segmenter that answers the left half (4×2 image: x < 2) and records
 *  its requests; matting answers one flat alpha. */
export function scripted() {
  const seen: unknown[] = [];
  const provider: MlProvider = {
    id: "scripted.a",
    title: "Scripted",
    tier: "A",
    capabilities: ["segment", "matting"],
    status: () => ({ healthy: true, model: "scripted" }),
    async run(capability, request) {
      seen.push({ capability, request });
      if (capability === "matting") {
        const { image } = request as {
          image: { width: number; height: number };
        };
        return {
          alpha: {
            width: image.width,
            height: image.height,
            data: new Uint8Array(image.width * image.height).fill(77),
          },
        } as never;
      }
      const { image } = request as { image: { width: number; height: number } };
      const data = new Uint8Array(image.width * image.height);
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width / 2; x++)
          data[y * image.width + x] = 255;
      return {
        mask: { width: image.width, height: image.height, data },
      } as never;
    },
  };
  return { provider, seen };
}
