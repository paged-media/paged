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

// Demo: a template with module fields. A price list whose rows and offer
// live in a workbook (paged.sheet's range and cell fields), whose note is a
// paragraph of a placed Word document (paged.doc's block text) and whose
// band colour is a drawing's fill (paged.draw's paint). The form fills them
// through their modules; the engine refuses a filler's edit anywhere else.
// The template file is made by scripts/demo-assets.ts.

// `?url`: the build emits the file and the demo fetches it there.
import listUrl from "../../demos/assets/price-list.paged?url";

import { createEditor } from "../embed";
import { demoPage, section } from "./page";

const page = demoPage({
  title: "Price list",
  intro:
    "Fields owned by modules: rows from a sheet, a Word paragraph, a drawing's colour.",
  aside: true,
});
const bytes = new Uint8Array(await (await fetch(listUrl)).arrayBuffer());
const editor = await createEditor(page.stage, {
  profile: "template-fill",
  document: { bytes, name: "price-list.paged" },
});
await editor.setRole("filler");

const values = section(page.aside, "The template's values");
const pre = document.createElement("pre");
pre.setAttribute("data-demo-values", "");
values.append(pre);
// A module field's value lives in its module (a workbook cell, a Word
// paragraph, a swatch), so it is read through the module, as the form does.
let shown = 0;
const show = async () => {
  const mine = ++shown;
  const out: Record<string, unknown> = {};
  for (const row of await editor.fields()) {
    const module = row.field.module;
    out[row.field.name] = module
      ? (
          await editor.objects.readTemplateField?.({
            name: row.field.name,
            targetId: row.targetId,
            kind: module.kind,
            def: module.def,
          })
        )?.value
      : row.value;
  }
  if (mine === shown) pre.textContent = JSON.stringify(out, null, 2);
};
editor.on((e) => {
  if (e.type === "change") void show();
});
await show();

// Everything outside the fields is locked: the host tries to rename the
// list, as a script or a plugin would, and the engine says no.
const locked = section(page.aside, "Outside the fields");
const tryTitle = document.createElement("button");
tryTitle.textContent = "Try to change the title";
tryTitle.setAttribute("data-demo-try-title", "");
const refusal = document.createElement("p");
refusal.setAttribute("data-demo-refusal", "");
locked.append(tryTitle, refusal);
tryTitle.addEventListener("click", async () => {
  // The title is the one text frame that carries no label: no field, no
  // module placement.
  let title = "";
  for (const address of await editor.objects.query("textFrame")) {
    const labels = await editor.objects.get(address, "labels");
    if (
      labels.kind === "value" &&
      Object.keys((labels.value as object | null) ?? {}).length === 0
    )
      title = address;
  }
  const reply = (await editor.client.mutate({
    op: "setElementProperty",
    args: {
      elementId: { kind: "textFrame", id: title.split(":")[1] },
      path: "frameFillColor",
      value: { type: "colorRef", value: "Color/Sun" },
    },
  } as never)) as unknown as { kind: string; payload: { error?: unknown } };
  refusal.textContent =
    reply.kind === "mutationApplied"
      ? "changed: the template did not protect the title"
      : `refused: ${JSON.stringify(reply.payload.error)}`;
});
page.status("ready: fill the form, the page follows");
