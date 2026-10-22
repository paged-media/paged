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

// Demo: automatic generation. One template, a data set, a PDF per record:
// in the browser through the handle, and on a server with the paged CLI.

import { createEditor } from "../embed";
import { demoPage, downloadLink, section } from "./page";
import { businessCard } from "./templates";

const page = demoPage({
  title: "Batch generation",
  intro:
    "A card per record of a data set, as PDF; the same on a server with `paged template fill`.",
  aside: true,
});
const editor = await createEditor(page.stage, { profile: "viewer" });
await businessCard(editor);
await editor.setRole("filler");

const people = [
  {
    name: "Ada Lovelace",
    title: "Head of Print",
    email: "ada@northwind.example",
  },
  {
    name: "Grace Hopper",
    title: "Production Lead",
    email: "grace@northwind.example",
  },
  {
    name: "Katherine Johnson",
    title: "Prepress",
    email: "katherine@northwind.example",
  },
  {
    name: "Mary Jackson",
    title: "Account Manager",
    email: "mary@northwind.example",
  },
];
const out = section(page.aside, "Records");
const list = document.createElement("ul");
list.setAttribute("data-demo-batch", "");
const run = document.createElement("button");
run.textContent = `Generate ${people.length} PDFs`;
out.append(run, list);
run.addEventListener("click", async () => {
  list.replaceChildren();
  for (const person of people) {
    const r = await editor.setFieldValues(person);
    const li = document.createElement("li");
    if (!r.ok) {
      li.textContent = `${person.name}: ${r.problems.map((p) => p.problem).join("; ")}`;
    } else {
      const pdf = await editor.exportPdf();
      li.append(
        downloadLink(
          pdf,
          `${person.name.replace(/\s+/g, "-").toLowerCase()}.pdf`,
          "application/pdf",
        ),
      );
    }
    list.append(li);
  }
  page.status(`generated ${people.length} cards`);
});
const cli = section(page.aside, "On a server");
const pre = document.createElement("pre");
pre.textContent = [
  "paged template fill card.paged \\",
  `  --values '${JSON.stringify(people[0])}' \\`,
  "  -o ada.pdf",
  "",
  "paged template check card.paged submitted.paged",
].join("\n");
cli.append(pre);
page.status("ready");
