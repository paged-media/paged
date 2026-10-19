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

// The small helpers of the built-ins and the editor (docs/adr/PM-0002):
// one implementation each, where every module had its own. Internal; the
// extension contract's own copies (plugin-sdk's `parseLength`, its
// `data:` URI encoding) stay in the public SDK, which cannot import this.

export { hex, sha256Hex, sha256HexPrefix } from "./hash.ts";
export {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  dataUrl,
  dataUrlBytes,
} from "./base64.ts";
export { PT_PER_PX, PT_PER_UNIT, PX_PER_PT, parseLength } from "./units.ts";
export { cmykToRgb, hexToRgb, rgbToCmyk, rgbToHex } from "./colour.ts";
export {
  LABEL_PREFIX,
  asciiEscape,
  asciiJson,
  decodeEnvelope,
  encodeEnvelope,
  labelKey,
  type LabelEnvelope,
} from "./label.ts";
