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

// Demo: the focused module editors (the `solo:<name>` presets), one at a
// time, switched by the host.

import { createEditor, type EditorHandle } from "../embed";
import { demoPage, section } from "./page";

const page = demoPage({
  title: "Focused editors",
  intro:
    "One module's application: drawing, image, sheet, word processing, web, data.",
  aside: true,
});
const choices = [
  ["solo:draw", "Drawing"],
  ["solo:image", "Image"],
  ["solo:sheet", "Spreadsheet"],
  ["solo:doc", "Word processing"],
  ["solo:web", "Web"],
  ["solo:data", "Data"],
] as const;
const box = section(page.aside, "Editor");
const select = document.createElement("select");
select.setAttribute("data-demo-preset", "");
for (const [id, label] of choices) select.append(new Option(label, id));
box.append(select);

let editor: EditorHandle | null = null;
async function open(preset: string) {
  editor?.dispose();
  page.stage.replaceChildren();
  page.status(`starting ${preset}…`);
  editor = await createEditor(page.stage, { profile: preset });
  page.status(`${preset} ready`);
}
select.addEventListener("change", () => void open(select.value));
await open(select.value);
