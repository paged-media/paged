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
import { createHash } from "node:crypto";

import {
  escapeLabelValue,
  parseLength as sdkParseLength,
} from "@paged-media/plugin-sdk";

import {
  asciiEscape,
  asciiJson,
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  cmykToRgb,
  dataUrl,
  dataUrlBytes,
  decodeEnvelope,
  encodeEnvelope,
  hexToRgb,
  labelKey,
  parseLength,
  PT_PER_PX,
  PT_PER_UNIT,
  PX_PER_PT,
  rgbToCmyk,
  rgbToHex,
  sha256Hex,
  sha256HexPrefix,
} from "../src/index.ts";

/** Deterministic bytes of any length. */
function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe("sha256Hex", () => {
  it("is the FIPS 180-2 digest of `abc`, as bytes or as text", async () => {
    const abc =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256Hex("abc")).toBe(abc);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(abc);
    expect(await sha256Hex(new TextEncoder().encode("abc").buffer)).toBe(abc);
  });

  it("matches node:crypto on many inputs, text as UTF-8", async () => {
    for (const n of [0, 1, 55, 56, 64, 1000, 70_000]) {
      const b = bytes(n);
      expect(await sha256Hex(b)).toBe(
        createHash("sha256").update(b).digest("hex"),
      );
    }
    const text = "Grüße, 日本語, 🎉";
    expect(await sha256Hex(text)).toBe(
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
  });

  it("keeps a prefix: paged.data's persisted 128-bit content address", async () => {
    const b = bytes(4096);
    const full = await sha256Hex(b);
    expect(await sha256HexPrefix(b, 32)).toBe(full.slice(0, 32));
    expect((await sha256HexPrefix(b, 32)).length).toBe(32);
    // One parameter: an index from `map` cannot shorten it.
    const all = await Promise.all([b, b].map(sha256Hex));
    expect(all).toEqual([full, full]);
  });

  it("hashes a view over shared memory (WebCrypto refuses it raw)", async () => {
    const shared = new Uint8Array(new SharedArrayBuffer(16));
    shared.set(bytes(16));
    expect(await sha256Hex(shared)).toBe(
      createHash("sha256").update(Buffer.from(shared)).digest("hex"),
    );
  });
});

describe("base64", () => {
  it("round-trips any length, past the chunk size, as Buffer encodes it", () => {
    for (const n of [0, 1, 2, 3, 4, 0x8000 - 1, 0x8000, 0x8000 * 3 + 7]) {
      const b = bytes(n, n + 1);
      const text = bytesToBase64(b);
      expect(text).toBe(Buffer.from(b).toString("base64"));
      expect(base64ToBytes(text)).toEqual(b);
    }
  });

  it("encodes a view over shared memory", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(5));
    shared.set([1, 2, 3, 250, 255]);
    expect(bytesToBase64(shared)).toBe("AQID+v8=");
  });

  it("URL-safe without padding", () => {
    const b = new Uint8Array([0xfb, 0xff, 0xbf, 0x01]);
    expect(bytesToBase64(b)).toBe("+/+/AQ==");
    expect(bytesToBase64Url(b)).toBe("-_-_AQ");
  });

  it("data: URLs, base64 and percent-encoded", () => {
    const b = new Uint8Array([0, 1, 2, 255]);
    const url = dataUrl("font/woff2", b);
    expect(url).toBe("data:font/woff2;base64,AAEC/w==");
    expect(dataUrlBytes(url)).toEqual(b);
    expect(dataUrlBytes("data:text/plain,a%20b%E2%82%AC")).toEqual(
      new TextEncoder().encode("a b€"),
    );
    expect(dataUrlBytes("data:image/png;base64, AAEC\n/w==")).toEqual(b);
    expect(dataUrlBytes("https://x/y.png")).toBeNull();
    expect(dataUrlBytes("data:;base64,***")).toBeNull();
  });
});

describe("units", () => {
  it("parses lengths into points", () => {
    expect(parseLength("12")).toBe(12);
    expect(parseLength("1in")).toBe(72);
    expect(parseLength("25.4mm")).toBeCloseTo(72, 10);
    expect(parseLength(" 2.54 CM ")).toBeCloseTo(72, 10);
    expect(parseLength("1p")).toBe(12);
    expect(parseLength("-.5pc")).toBe(-6);
    expect(parseLength("4px")).toBe(3);
    expect(parseLength("3 furlongs")).toBeNull();
    expect(parseLength("abc")).toBeNull();
    expect(PX_PER_PT * PT_PER_PX).toBeCloseTo(1, 12);
  });

  it("agrees with the public SDK's parseLength on every unit", () => {
    for (const unit of Object.keys(PT_PER_UNIT)) {
      for (const text of [
        `1${unit}`,
        `-2.5 ${unit}`,
        `.75${unit.toUpperCase()}`,
      ]) {
        expect(parseLength(text)).toBe(sdkParseLength(text));
      }
    }
    for (const text of ["", "1 em", "7", "x1pt"]) {
      expect(parseLength(text)).toBe(sdkParseLength(text));
    }
  });
});

describe("colour", () => {
  it("hex both ways", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("AbCdEf")).toEqual([171, 205, 239]);
    expect(hexToRgb(" #f80 ")).toEqual([255, 136, 0]);
    for (const bad of ["", "#ff80", "#00000g", "#-1-1-1", "red"]) {
      expect(hexToRgb(bad)).toBeNull();
    }
    expect(rgbToHex([255, 128, 0])).toBe("#ff8000");
    expect(rgbToHex([254.6, 0.4, 127.5])).toBe("#ff0080");
    expect(rgbToHex([300, -4, 256])).toBe("#ff00ff");
    expect(rgbToHex([1])).toBe("#010000");
  });

  it("naive CMYK both ways", () => {
    expect(cmykToRgb([0, 0, 0, 0])).toEqual([255, 255, 255]);
    expect(cmykToRgb([0, 0, 0, 100])).toEqual([0, 0, 0]);
    expect(cmykToRgb([100, 0, 0, 50])).toEqual([0, 128, 128]);
    expect(cmykToRgb([0.5, 0, 0, 0])).toEqual([254, 255, 255]);
    expect(cmykToRgb([150, -20, 0, 0])).toEqual([0, 255, 255]);
    expect(cmykToRgb([0, 0, 0, 250])).toEqual([0, 0, 0]);
    expect(rgbToCmyk([0, 0, 0])).toEqual([0, 0, 0, 100]);
    expect(rgbToCmyk([0, 255, 255])).toEqual([100, 0, 0, 0]);
    expect(rgbToCmyk([128, 128, 128])).toEqual([0, 0, 0, 50]);
    for (const rgb of [
      [12, 200, 99],
      [255, 0, 128],
      [7, 7, 7],
    ]) {
      const back = cmykToRgb(rgbToCmyk(rgb));
      back.forEach((v, i) =>
        expect(Math.abs(v - rgb[i])).toBeLessThanOrEqual(2),
      );
    }
  });
});

describe("labels", () => {
  it("keys and sub-keys", () => {
    expect(labelKey("media.paged.sheet")).toBe("x-paged:media.paged.sheet");
    expect(labelKey("media.paged.sheet", "wb")).toBe(
      "x-paged:media.paged.sheet.wb",
    );
  });

  it("ASCII-only JSON that parses to the same value", () => {
    const value = { name: "Grüße 🎉", del: "\u007f", n: [1, "x"] };
    const text = asciiJson(value);
    expect([...text].every((c) => c.charCodeAt(0) < 0x7f)).toBe(true);
    expect(text).toContain("\\u00fc");
    expect(text).toContain("\\ud83c\\udf89");
    expect(text).toContain("\\u007f");
    expect(JSON.parse(text)).toEqual(value);
    expect(asciiEscape(JSON.stringify(value))).toBe(text);
  });

  it("escapes as the SDK's escapeLabelValue does, byte for byte", () => {
    const text = JSON.stringify({ s: "~\u007f\u0080Grüße 🎉\uffff", n: 1 });
    expect(asciiEscape(text)).toBe(escapeLabelValue(text));
  });

  it("the envelope round-trips and rejects what the engine would", () => {
    const text = encodeEnvelope({ wb: "ab12", title: "Ü" }, 2);
    expect(text).toBe('{"v":2,"data":{"wb":"ab12","title":"\\u00dc"}}');
    expect(decodeEnvelope(text)).toEqual({
      v: 2,
      data: { wb: "ab12", title: "Ü" },
    });
    expect(encodeEnvelope(null)).toBe('{"v":1,"data":null}');
    for (const bad of [
      null,
      undefined,
      "",
      "not json",
      "[]",
      '{"data":{}}',
      '{"v":0,"data":{}}',
      '{"v":1.5,"data":{}}',
      '{"v":"1","data":{}}',
    ]) {
      expect(decodeEnvelope(bad)).toBeNull();
    }
  });
});
