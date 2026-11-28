/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Bytes the worker answers with, as a typed array whose buffer moves to the
// main thread. A `postMessage` transfer list takes the whole ArrayBuffer of
// each entry and leaves it detached here, so only a buffer the reply alone
// owns may be listed: a view onto wasm memory (which cannot be transferred
// at all), onto shared memory, or onto part of a larger buffer is copied
// out once first.
//
// No imports: the worker loads this without the shell or React.

/** `bytes` on an ArrayBuffer of exactly its own extent: itself when it
 *  already spans one, else a copy. The result's buffer is safe to
 *  transfer when the caller does not use `bytes` afterwards. */
export function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const whole =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength;
  return whole ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
}

/** The reply to `renderPageVelloPng`, as the client's `requestVelloPng`
 *  reads it. */
export interface VelloPngReply {
  kind: "velloPngReply";
  seq: number;
  pngBytes: Uint8Array | null;
}

/** The `velloPngReply` for `png` (the readback's PNG, absent when the GPU
 *  gave none) and the transfer list to post it with: the bytes cross as a
 *  `Uint8Array` on a moved buffer, never as a `number[]`. */
export function velloPngReply(
  seq: number,
  png: Uint8Array | null | undefined,
): { message: VelloPngReply; transfer: Transferable[] } {
  const pngBytes = png ? ownedBytes(png) : null;
  return {
    message: { kind: "velloPngReply", seq, pngBytes },
    transfer: pngBytes ? [pngBytes.buffer] : [],
  };
}
