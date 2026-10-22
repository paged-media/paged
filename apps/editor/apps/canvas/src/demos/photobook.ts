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

// Demo: a multi-page product. A photobook whose pictures and captions fill
// page by page, checked for print and exported as PDF.

import { createEditor } from "../embed";
import { demoPage, downloadLink, section } from "./page";
import { photobook } from "./templates";

const page = demoPage({
  title: "Photobook",
  intro: "Pictures and captions on every page; a print check before the PDF.",
  aside: true,
});
const editor = await createEditor(page.stage, { profile: "template-fill" });
page.status("building the template…");
await photobook(editor);
await editor.setRole("filler");

const check = section(page.aside, "Print");
const button = document.createElement("button");
button.textContent = "Check and export PDF";
button.setAttribute("data-demo-export", "");
const report = document.createElement("pre");
report.setAttribute("data-demo-report", "");
check.append(button, report);
button.addEventListener("click", async () => {
  const fields = await editor.fields();
  const missing = fields
    .filter((f) => f.field.required && !f.value)
    .map((f) => f.field.name);
  const overset = fields.filter((f) => f.overset).map((f) => f.field.name);
  const pdf = await editor.exportPdf();
  report.textContent = [
    `pages: ${fields.length / 2}`,
    `missing required fields: ${missing.join(", ") || "none"}`,
    `text that does not fit: ${overset.join(", ") || "none"}`,
    `PDF: ${pdf.byteLength.toLocaleString()} bytes`,
  ].join("\n");
  check.append(downloadLink(pdf, "photobook.pdf", "application/pdf"));
});
page.status("ready");
