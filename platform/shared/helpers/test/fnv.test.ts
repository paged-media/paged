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

import { describe, expect, it } from "bun:test";

import { fnv1a32, fnv1a32Hex, fnv1a32Utf16 } from "../src/hash.ts";

describe("fnv1a32", () => {
  it("matches the published FNV-1a 32 vectors", () => {
    expect(fnv1a32Hex("")).toBe("811c9dc5");
    expect(fnv1a32Hex("a")).toBe("e40c292c");
    expect(fnv1a32Hex("foobar")).toBe("bf9cf968");
  });
  it("reads bytes by value and a string by UTF-16 code unit", () => {
    expect(fnv1a32(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe(fnv1a32("foo"));
    // A code unit above 0xFF is XORed whole, as every earlier copy did.
    // The hash of "" is the offset basis.
    expect(fnv1a32("€")).toBe(
      Math.imul(fnv1a32("") ^ 0x20ac, 0x01000193) >>> 0,
    );
  });
  it("takes a seed for chained hashing", () => {
    expect(fnv1a32("bar", fnv1a32("foo"))).toBe(fnv1a32("foobar"));
  });
});

describe("fnv1a32Utf16", () => {
  // The loop draw's recipe-store and graphic-styles carried before it moved here.
  const legacy = (text: string, seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
      h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  it("is bit-identical to the copies it replaced", () => {
    for (const text of [
      "",
      "a",
      "foobar",
      "€ ünï \u{1F600} \u0000",
      "x".repeat(500),
    ]) {
      for (const seed of [0x811c9dc5, 0x9dc5811c]) {
        expect(fnv1a32Utf16(text, seed)).toBe(legacy(text, seed));
      }
    }
  });
  it("is FNV-1a over the UTF-16LE bytes", () => {
    const text = "h€llo";
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      bytes[2 * i] = text.charCodeAt(i) & 0xff;
      bytes[2 * i + 1] = text.charCodeAt(i) >>> 8;
    }
    expect(fnv1a32Utf16(text)).toBe(fnv1a32(bytes));
  });
});

describe("siteHash and bytes fingerprints", () => {
  it("the shift-form FNV the journal carried equals fnv1a32", () => {
    const shifted = (m: string): number => {
      let h = 0x811c9dc5;
      for (let i = 0; i < m.length; i += 1) {
        h ^= m.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      return h;
    };
    for (const m of ["", "plugin said hi", "€ ünï \u{1F600}"]) {
      expect(fnv1a32(m)).toBe(shifted(m));
    }
  });
});
