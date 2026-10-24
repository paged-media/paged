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

// Files the demo assets are made of, written here so the demos carry no
// third-party content: a CMYK ICC profile for the PDF/X-4 demo's output
// intent, and a small Word document for the price list's text block.
//
// The profile is a stand-in, computed from a naive ink model (sRGB primaries,
// a black generated from the darkest channel): a valid ICC v2 output profile
// that a PDF/X-4 can name as its output intent, not a measured press
// condition. A host passes its printer's profile instead.

// ───────────────────────────────────────────────────────── ICC profile

const D50 = [0.9642, 1, 0.8249] as const;

/** sRGB (linear) → XYZ, adapted to D50 (the ICC's own sRGB matrix). */
const RGB_TO_XYZ = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
] as const;

function invert3(m: readonly (readonly number[])[]): number[][] {
  const [a, b, c] = m[0]!;
  const [d, e, f] = m[1]!;
  const [g, h, i] = m[2]!;
  const A = e! * i! - f! * h!;
  const B = -(d! * i! - f! * g!);
  const C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  return [
    [A / det, -(b! * i! - c! * h!) / det, (b! * f! - c! * e!) / det],
    [B / det, (a! * i! - c! * g!) / det, -(a! * f! - c! * d!) / det],
    [C / det, -(a! * h! - b! * g!) / det, (a! * e! - b! * d!) / det],
  ];
}
const XYZ_TO_RGB = invert3(RGB_TO_XYZ);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toGamma = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

function rgbToLab(rgb: readonly number[]): [number, number, number] {
  const lin = rgb.map(toLinear);
  const xyz = RGB_TO_XYZ.map(
    (row) => row[0] * lin[0]! + row[1] * lin[1]! + row[2] * lin[2]!,
  );
  const f = (t: number) =>
    t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29;
  const [fx, fy, fz] = xyz.map((v, i) => f(v / D50[i]!)) as [
    number,
    number,
    number,
  ];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb(lab: readonly number[]): number[] {
  const fy = (lab[0]! + 16) / 116;
  const fx = fy + lab[1]! / 500;
  const fz = fy - lab[2]! / 200;
  const inv = (t: number) =>
    t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29);
  const xyz = [inv(fx) * D50[0], inv(fy) * D50[1], inv(fz) * D50[2]];
  return XYZ_TO_RGB.map((row) =>
    toGamma(clamp01(row[0]! * xyz[0]! + row[1]! * xyz[1]! + row[2]! * xyz[2]!)),
  );
}

/** The ink model: CMYK → sRGB. */
const cmykToRgb = ([c, m, y, k]: readonly number[]) => [
  (1 - c!) * (1 - k!),
  (1 - m!) * (1 - k!),
  (1 - y!) * (1 - k!),
];

/** Its inverse, black from the darkest channel. */
function rgbToCmyk(rgb: readonly number[]): number[] {
  const k = 1 - Math.max(...rgb);
  if (k >= 1) return [0, 0, 0, 1];
  return [...rgb.map((v) => (1 - v - k) / (1 - k)), k];
}

/** Lab as the v2 16-bit PCS encodes it (`lut16Type`). */
const labWord = (lab: readonly number[]) => [
  Math.round((clamp01(lab[0]! / 100) * 0xff00) | 0),
  Math.round(Math.min(0xffff, Math.max(0, (lab[1]! + 128) * 256))),
  Math.round(Math.min(0xffff, Math.max(0, (lab[2]! + 128) * 256))),
];

class Bytes {
  private out: number[] = [];
  get length() {
    return this.out.length;
  }
  u8(...v: number[]) {
    for (const x of v) this.out.push(x & 0xff);
    return this;
  }
  u16(...v: number[]) {
    for (const x of v) this.u8(x >> 8, x);
    return this;
  }
  u32(...v: number[]) {
    for (const x of v) this.u8(x >>> 24, x >>> 16, x >>> 8, x);
    return this;
  }
  s15(...v: number[]) {
    for (const x of v) this.u32(Math.round(x * 65536) >>> 0);
    return this;
  }
  ascii(s: string) {
    for (const ch of s) this.u8(ch.charCodeAt(0));
    return this;
  }
  pad4() {
    while (this.out.length % 4) this.out.push(0);
    return this;
  }
  bytes() {
    return new Uint8Array(this.out);
  }
}

/** A `lut16Type` table: identity curves around a grid of `points`. */
function lut16(
  inputs: number,
  outputs: number,
  points: number,
  sample: (at: number[]) => number[],
): Uint8Array {
  const b = new Bytes().ascii("mft2").u32(0).u8(inputs, outputs, points, 0);
  b.s15(1, 0, 0, 0, 1, 0, 0, 0, 1).u16(2, 2);
  for (let i = 0; i < inputs; i++) b.u16(0, 0xffff);
  const at = new Array<number>(inputs).fill(0);
  const total = points ** inputs;
  for (let n = 0; n < total; n++) {
    let rest = n;
    for (let i = inputs - 1; i >= 0; i--) {
      at[i] = (rest % points) / (points - 1);
      rest = Math.floor(rest / points);
    }
    b.u16(...sample(at));
  }
  for (let o = 0; o < outputs; o++) b.u16(0, 0xffff);
  return b.bytes();
}

function descTag(text: string): Uint8Array {
  const b = new Bytes()
    .ascii("desc")
    .u32(0, text.length + 1)
    .ascii(text);
  b.u8(0).u32(0, 0).u16(0).u8(0);
  for (let i = 0; i < 67; i++) b.u8(0);
  return b.bytes();
}

/** The demo's CMYK output profile (ICC v2, `prtr`, PCS Lab). */
export function demoCmykProfile(name: string): Uint8Array {
  const a2b = lut16(4, 3, 5, (cmyk) => labWord(rgbToLab(cmykToRgb(cmyk))));
  const b2a = lut16(3, 4, 9, ([l, a, bb]) =>
    rgbToCmyk(labToRgb([l! * 100, a! * 255 - 128, bb! * 255 - 128])).map((v) =>
      Math.round(clamp01(v) * 0xffff),
    ),
  );
  const wtpt = new Bytes()
    .ascii("XYZ ")
    .u32(0)
    .s15(...D50)
    .bytes();
  const cprt = new Bytes()
    .ascii("text")
    .u32(0)
    .ascii("No copyright, use freely")
    .u8(0)
    .bytes();
  const tags: [string, Uint8Array][] = [
    ["desc", descTag(name)],
    ["cprt", cprt],
    ["wtpt", wtpt],
    ["A2B0", a2b],
    ["A2B1", a2b],
    ["A2B2", a2b],
    ["B2A0", b2a],
    ["B2A1", b2a],
    ["B2A2", b2a],
  ];
  // Tags with the same data share it, as the format allows.
  const data = new Bytes();
  const at = new Map<Uint8Array, number>();
  const tableEnd = 128 + 4 + 12 * tags.length;
  const entries = tags.map(([sig, bytes]) => {
    if (!at.has(bytes)) {
      at.set(bytes, tableEnd + data.length);
      for (const x of bytes) data.u8(x);
      data.pad4();
    }
    return { sig, offset: at.get(bytes)!, size: bytes.byteLength };
  });
  const size = tableEnd + data.length;
  const head = new Bytes()
    .u32(size)
    .ascii("none")
    .u32(0x02100000)
    .ascii("prtrCMYKLab ")
    .u16(2026, 1, 1, 0, 0, 0)
    .ascii("acsp")
    .u32(0, 0)
    .ascii("none")
    .u32(0, 0, 0, 0, 0)
    .s15(...D50)
    .ascii("none");
  while (head.length < 128) head.u8(0);
  head.u32(tags.length);
  for (const e of entries) head.ascii(e.sig).u32(e.offset, e.size);
  const out = new Uint8Array(size);
  out.set(head.bytes(), 0);
  out.set(data.bytes(), tableEnd);
  return out;
}

// ───────────────────────────────────────────────────── a stored zip

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of bytes) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `files`, stored (no compression). */
function zip(files: Record<string, string>): Uint8Array {
  const le = new Bytes();
  const central = new Bytes();
  const u16 = (b: Bytes, v: number) => b.u8(v, v >> 8);
  const u32 = (b: Bytes, v: number) => b.u8(v, v >> 8, v >> 16, v >>> 24);
  const enc = new TextEncoder();
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const crc = crc32(data);
    const offset = le.length;
    const header = (b: Bytes, sig: number, isCentral: boolean) => {
      u32(b, sig);
      if (isCentral) u16(b, 20);
      u16(b, 20);
      u16(b, 0);
      u16(b, 0);
      u16(b, 0);
      u16(b, 0x5a21);
      u32(b, crc);
      u32(b, data.length);
      u32(b, data.length);
      u16(b, name.length);
      u16(b, 0);
      if (isCentral) {
        u16(b, 0);
        u16(b, 0);
        u16(b, 0);
        u32(b, 0);
        u32(b, offset);
      }
      b.ascii(name);
    };
    header(le, 0x04034b50, false);
    for (const x of data) le.u8(x);
    header(central, 0x02014b50, true);
    count++;
  }
  const start = le.length;
  for (const x of central.bytes()) le.u8(x);
  u32(le, 0x06054b50);
  u16(le, 0);
  u16(le, 0);
  u16(le, count);
  u16(le, count);
  u32(le, central.length);
  u32(le, start);
  u16(le, 0);
  return le.bytes();
}

// ───────────────────────────────────────────────── the Word document

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A short Word document: a heading and the paragraph bookmarked `note`. */
export function priceNoteDocx(): Uint8Array {
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Good to know</w:t></w:r></w:p>
<w:p><w:bookmarkStart w:id="0" w:name="note"/><w:r><w:t>All prices per kilogram, fresh from the market every morning.</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>
</w:body></w:document>`,
  });
}

// ───────────────────────────────────────────────────── the workbook

const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A workbook of two sheets: `Prices` (fruit and price per kilogram, wide
 *  columns) and `Offer` (the week's offer in A2). */
export function priceWorkbookXlsx(): Uint8Array {
  const prices: [string, number][] = [
    ["Apples", 2.4],
    ["Pears", 3.1],
    ["Plums", 2.8],
    ["Figs", 6.5],
  ];
  const strings = [
    "Fruit",
    "Price",
    ...prices.map(([f]) => f),
    "Offer of the week",
  ];
  const s = (text: string) => strings.indexOf(text);
  const cell = (ref: string, v: string | number) =>
    typeof v === "number"
      ? `<c r="${ref}"><v>${v}</v></c>`
      : `<c r="${ref}" t="s"><v>${s(v)}</v></c>`;
  const sheet = (cols: string, rows: string[]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SML}"><cols>${cols}</cols><sheetData>${rows.join("")}</sheetData></worksheet>`;
  const row = (n: number, cells: string) => `<row r="${n}">${cells}</row>`;
  const pricesSheet = sheet(
    `<col min="1" max="1" width="22" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/>`,
    [
      row(1, cell("A1", "Fruit") + cell("B1", "Price")),
      ...prices.map(([f, p], i) =>
        row(i + 2, cell(`A${i + 2}`, f) + cell(`B${i + 2}`, p)),
      ),
    ],
  );
  const offerSheet = sheet(
    `<col min="1" max="1" width="24" customWidth="1"/>`,
    [row(1, cell("A1", "Offer of the week")), row(2, cell("A2", "Figs"))],
  );
  const ct = "application/vnd.openxmlformats-officedocument.spreadsheetml";
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="${ct}.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${ct}.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${SML}" xmlns:r="${REL}"><sheets><sheet name="Prices" sheetId="1" r:id="rId1"/><sheet name="Offer" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": pricesSheet,
    "xl/worksheets/sheet2.xml": offerSheet,
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${SML}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`,
  });
}
