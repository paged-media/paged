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

// Demo: form-based template adoption. The host's own form beside a live
// preview: the editor shows the canvas alone (profile `viewer`, role
// filler), and every value goes through the handle.

import type { TemplateFieldSummary } from "@paged-media/client";

import { createEditor } from "../embed";
import { demoPage, section } from "./page";
import { postcard } from "./templates";

const page = demoPage({
  title: "Postcard form",
  intro: "The host's form fills the template; the editor is the live preview.",
  aside: true,
});
const editor = await createEditor(page.stage, {
  profile: { extends: "viewer", role: "filler" },
});
page.status("building the template…");
await postcard(editor);
await editor.setRole("filler");

const form = section(page.aside, "Your postcard");
const problems = document.createElement("p");
problems.setAttribute("data-demo-problems", "");
const rows: readonly TemplateFieldSummary[] = await editor.fields();
for (const row of rows) {
  const label = document.createElement("label");
  label.textContent = row.field.label ?? row.field.name;
  if (row.field.kind === "text") {
    const multiline = (row.field.constraints?.maxLines ?? 1) > 1;
    const input = document.createElement(multiline ? "textarea" : "input");
    if (input instanceof HTMLInputElement) input.type = "text";
    input.value = row.value?.kind === "text" ? row.value.text : "";
    input.setAttribute("data-demo-field", row.field.name);
    if (row.field.constraints?.maxLength)
      input.maxLength = row.field.constraints.maxLength;
    input.addEventListener("change", async () => {
      const r = await editor.setFieldValues({ [row.field.name]: input.value });
      problems.textContent = r.ok
        ? ""
        : r.problems.map((p) => `${p.name}: ${p.problem}`).join("; ");
    });
    label.append(input);
  } else if (row.field.kind === "visibility") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = row.value?.kind === "visible" ? row.value.visible : true;
    box.addEventListener(
      "change",
      () => void editor.setFieldValues({ [row.field.name]: box.checked }),
    );
    label.prepend(box);
  } else if (row.field.kind === "image") {
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      await editor.client.mutateWithBytes(
        {
          op: "replaceImageBytes",
          args: { elementId: row.targetId, bytes: [] },
        },
        new Uint8Array(await f.arrayBuffer()),
        true,
      );
    });
    label.append(file);
  }
  form.append(label);
}
form.append(problems);
page.status("ready: edit the form");
