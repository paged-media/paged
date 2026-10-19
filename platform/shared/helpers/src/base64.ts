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

// Base64 and `data:` URLs, for bytes of any size: chunked through
// `String.fromCharCode`, so a large payload never exceeds the engine's
// argument limit, and a view over a SharedArrayBuffer reads like any other.
// `btoa` / `atob` exist in every realm the code runs in (browser, worker,
// Bun, Node).

/** Bytes per `String.fromCharCode` call. */
const CHUNK = 0x8000;

/** Standard base64 (RFC 4648 §4, padded). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The bytes of a standard base64 text (whitespace ignored). Throws on a
 *  text that is not base64, as `atob` does. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** URL-safe base64 without padding (RFC 4648 §5): PKCE verifiers, ids. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A base64 `data:` URL of `bytes`. */
export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** The bytes of a `data:` URL, base64 or percent-encoded, or `null` when it
 *  is not one (or does not decode). */
export function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:([^,]*),(.*)$/is.exec(url.trim());
  if (!m) return null;
  try {
    if (/;base64$/i.test(m[1])) return base64ToBytes(m[2]);
    const out: number[] = [];
    const s = m[2];
    const encoder = new TextEncoder();
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === "%" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
        out.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        out.push(...encoder.encode(s[i]));
      }
    }
    return new Uint8Array(out);
  } catch {
    return null;
  }
}
