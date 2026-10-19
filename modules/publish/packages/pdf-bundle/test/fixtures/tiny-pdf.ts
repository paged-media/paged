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

// A PDF built in code: one US Letter page per entry of `pages`, each line of
// it set in the standard Helvetica (no embedded font) at 24 pt, 36 pt apart
// from the top. Uncompressed content streams and a correct cross-reference
// table, so any reader opens it; no binary fixture is committed.

export function tinyPdf(pages: readonly (readonly string[])[]): Uint8Array {
  const objects: string[] = [];
  const pageCount = pages.length;
  // 1 catalog, 2 pages, 3 font, then a page + a content stream per page.
  const pageObj = (i: number) => 4 + i * 2;
  const contentObj = (i: number) => 5 + i * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] ` +
    `/Count ${pageCount} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const body = lines
      .map((l, n) => `BT /F1 24 Tf 72 ${720 - n * 36} Td (${escape(l)}) Tj ET`)
      .join("\n");
    objects[pageObj(i)] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`;
    objects[contentObj(i)] =
      `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++)
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
