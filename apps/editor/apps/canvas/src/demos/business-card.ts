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

// Demo: design placeholders. A locked business card whose name, title,
// e-mail and portrait are the only open parts (profile `template-fill`,
// role filler). Submit hands the values to the host. It works on a phone
// (editor ADR 294): the card fills the screen, a tapped field opens in a
// sheet below it, and the portrait can come from the camera. With
// `?layout=form` it is the `form` preset instead: the form first, the
// card as a preview.

import { createEditor, type EditorHandle } from "../embed";
import { demoPage, downloadLink, section } from "./page";
import { businessCard, valuesOf } from "./templates";

const page = demoPage({
  title: "Business card",
  intro: "A locked template: fill the fields, the design stays as it was made.",
  aside: true,
});
const result = section(page.aside, "Submitted");
const pre = document.createElement("pre");
pre.setAttribute("data-demo-submitted", "");
pre.textContent = "Nothing submitted yet.";
result.append(pre);

const layout = new URLSearchParams(location.search).get("layout");

let editor: EditorHandle;
editor = await createEditor(page.stage, {
  profile: {
    extends: layout === "form" ? "form" : "template-fill",
    regions: {
      "actions-bar": { items: [{ kind: "spacer" }, "paged.host.submit"] },
    },
  },
  actions: {
    async submit() {
      pre.textContent = JSON.stringify(
        valuesOf(await editor.fields()),
        null,
        2,
      );
      const bytes = await editor.save();
      result.append(
        downloadLink(bytes, "business-card.paged", "application/x-paged+zip"),
      );
    },
  },
});
page.status("building the template…");
await businessCard(editor);
await editor.setRole("filler");
page.status("ready: fill in the fields, then Submit");
