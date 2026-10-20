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

// Reading a barcode back from the page (ADR 224): the films that draw an
// EAN-13 from data check the bars they filmed encode a code from the data.

/** A bar's page-local bounds: top, left, bottom, right (pt). */
export type Bounds = [number, number, number, number];

/** Read an EAN-13 back from its bars: 95 modules between the outer guards,
 *  each dark when a bar covers its centre, decoded with the L/G/R tables. */
export function decodeEan13(bars: Bounds[]): string {
  const left = Math.min(...bars.map((b) => b[1]));
  const right = Math.max(...bars.map((b) => b[3]));
  const unit = (right - left) / 95;
  let bits = "";
  for (let m = 0; m < 95; m++) {
    const x = left + (m + 0.5) * unit;
    bits += bars.some((b) => x > b[1] && x < b[3]) ? "1" : "0";
  }
  const L = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
  ];
  const G = L.map((c) =>
    [...c]
      .map((x) => (x === "1" ? "0" : "1"))
      .reverse()
      .join(""),
  );
  const R = L.map((c) => [...c].map((x) => (x === "1" ? "0" : "1")).join(""));
  const FIRST = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
  ];
  if (
    bits.slice(0, 3) !== "101" ||
    bits.slice(45, 50) !== "01010" ||
    bits.slice(92) !== "101"
  )
    throw new Error(`not an EAN-13 bar pattern: ${bits}`);
  let parity = "";
  let digits = "";
  for (let i = 0; i < 6; i++) {
    const c = bits.slice(3 + i * 7, 10 + i * 7);
    const l = L.indexOf(c);
    const g = G.indexOf(c);
    if (l >= 0) ((digits += l), (parity += "L"));
    else if (g >= 0) ((digits += g), (parity += "G"));
    else throw new Error(`left digit ${i}: ${c}`);
  }
  for (let i = 0; i < 6; i++) {
    const r = R.indexOf(bits.slice(50 + i * 7, 57 + i * 7));
    if (r < 0) throw new Error(`right digit ${i}`);
    digits += r;
  }
  const first = FIRST.indexOf(parity);
  if (first < 0) throw new Error(`parity ${parity}`);
  return `${first}${digits}`;
}
