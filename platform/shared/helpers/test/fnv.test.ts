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

import { fnv1a32, fnv1a32Hex } from "../src/hash.ts";

describe("fnv1a32", () => {
  it("matches the published FNV-1a 32 vectors", () => {
    expect(fnv1a32Hex("")).toBe("811c9dc5");
    expect(fnv1a32Hex("a")).toBe("e40c292c");
    expect(fnv1a32Hex("foobar")).toBe("bf9cf968");
  });
  it("reads bytes by value and a string by UTF-16 code unit", () => {
    expect(fnv1a32(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe(fnv1a32("foo"));
    // A code unit above 0xFF is XORed whole, as every earlier copy did.
    expect(fnv1a32("€")).toBe(Math.imul(0x811c9dc5 ^ 0x20ac, 0x01000193) >>> 0);
  });
  it("takes a seed for chained hashing", () => {
    expect(fnv1a32("bar", fnv1a32("foo"))).toBe(fnv1a32("foobar"));
  });
});
