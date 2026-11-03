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

// The bake's PNG encoder: `@paged-media/helpers`' writer with the bake's
// rule that a small image is stored, not deflated, so its bytes (and the
// hashes taken of them) are the same on every platform.

import { encodePng as encodeRgba, zlibStored } from "@paged-media/helpers";

export { zlibStored };

/** Below this many raw bytes the stream is stored, not compressed: tiny
 *  images gain nothing, and stored bytes are the same on every platform. */
const COMPRESS_FROM = 64 * 1024;

/** Encode straight RGBA8 pixels (`width*height*4` bytes) as a PNG. */
export function encodePng(
  rgba: Uint8Array | readonly number[],
  width: number,
  height: number,
): Promise<Uint8Array> {
  const data = rgba instanceof Uint8Array ? rgba : Uint8Array.from(rgba);
  return encodeRgba({ width, height, data }, { storeBelow: COMPRESS_FROM });
}
