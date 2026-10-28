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

// A one-page PDF drawing what place-as-vectors (publish ADR 658) carries:
// a red rectangle, a dashed blue curve, a triangle clipping two
// rectangles, a horizontal red→blue axial shading clipped to a band, a
// rectangle under a luminosity soft mask, and a line of standard
// Helvetica. Built in code, uncompressed, with a correct xref table.

export const VECTOR_PAGE = { width: 300, height: 300 } as const;

export function vectorPdf(): Uint8Array {
  const content = [
    // A red rectangle, 20,20 → 120,80 on the page (y down).
    "1 0 0 rg 20 220 100 60 re f",
    // A dashed blue curve.
    "0 0 1 RG 3 w 1 J [6 3] 0 d 20 150 m 80 200 140 100 200 150 c S [] 0 d",
    // A triangle clipping two rectangles: a clip group.
    "q 160 280 m 280 280 l 220 180 l h W n 0 1 0 rg 150 170 70 120 re f 1 1 0 rg 220 170 70 120 re f Q",
    // An axial shading over a band: one gradient-filled path.
    "q 20 20 260 40 re W n /Sh0 sh Q",
    // A rectangle under a luminosity soft mask: a native opacity mask.
    "q /G0 gs 0.5 0 0.5 rg 200 70 80 60 re f Q",
    // Text in a standard font.
    "0 g BT /F0 14 Tf 20 100 Td (Placed text) Tj ET",
  ].join("\n");
  const mask =
    "1 1 1 rg 210 80 40 40 re f";
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${VECTOR_PAGE.width} ${VECTOR_PAGE.height}] ` +
    "/Resources << /Font << /F0 5 0 R >> /Shading << /Sh0 6 0 R >> /ExtGState << /G0 7 0 R >> >> " +
    "/Contents 4 0 R >>";
  objects[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[6] =
    "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [20 0 280 0] /Extend [true true] " +
    "/Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>";
  objects[7] = "<< /Type /ExtGState /SMask << /S /Luminosity /G 8 0 R >> >>";
  objects[8] =
    "<< /Type /XObject /Subtype /Form /BBox [0 0 300 300] " +
    `/Group << /S /Transparency /CS /DeviceRGB >> /Length ${mask.length} >>\nstream\n${mask}\nendstream`;
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** The same page as an Illustrator file without PDF content: the
 *  stand-in page Illustrator writes, and its private-data marker. */
export function aiWithoutPdfContent(): Uint8Array {
  const content =
    "BT /F0 12 Tf 30 100 Td (This is an Adobe Illustrator File that was) Tj 0 -14 Td (saved without PDF Content.) Tj ET";
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F0 5 0 R >> >> /Contents 4 0 R >>";
  objects[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /AIPrivateData1 0 >>";
  let out = "%PDF-1.6\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
