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

// Demo: the editor in an iframe. The host page loads embed.html in a frame
// and drives it through `connectEditor`: the same handle as `createEditor`,
// every call a message. It loads a template file, fills a field, and
// answers Submit.

import { connectEditor } from "../embed";
import { demoPage, section } from "./page";

const page = demoPage({
  title: "Editor in an iframe",
  intro:
    "The host drives a framed editor through messages: load, fill, submit.",
  aside: true,
});
const frame = document.createElement("iframe");
frame.src = new URL("../embed.html", location.href).href;
frame.title = "paged editor";
frame.allow = "cross-origin-isolated";
frame.style.cssText = "width:100%;height:100%;border:0";
page.stage.append(frame);

const log = section(page.aside, "Messages");
const list = document.createElement("ul");
list.setAttribute("data-demo-messages", "");
log.append(list);
const note = (text: string) => {
  const li = document.createElement("li");
  li.textContent = text;
  list.append(li);
};

page.status("connecting…");
const editor = await connectEditor(frame, {
  profile: {
    extends: "template-fill",
    regions: {
      "actions-bar": { items: [{ kind: "spacer" }, "paged.host.submit"] },
    },
  },
  actions: {
    async submit() {
      const values = await editor.getFieldValues();
      note(`submitted: ${JSON.stringify(values)}`);
      page.status("submitted");
    },
  },
});
editor.on((event) => {
  if (event.type === "fieldChange") note("fields changed");
});
const bytes = new Uint8Array(
  await (
    await fetch(new URL("./assets/business-card.paged", location.href))
  ).arrayBuffer(),
);
await editor.load({ bytes, name: "business-card.paged" });
await editor.setRole("filler");

const form = section(page.aside, "From the host");
const button = document.createElement("button");
button.textContent = "Set the name to Mary Example";
button.setAttribute("data-demo-set-name", "");
button.addEventListener("click", async () => {
  const r = await editor.setFieldValues({ name: "Mary Example" });
  note(r.ok ? "name set" : `refused: ${JSON.stringify(r)}`);
});
form.append(button);
const script = document.createElement("button");
script.textContent = "Run a script: count the pages";
script.setAttribute("data-demo-run-script", "");
script.addEventListener("click", async () => {
  const r = await editor.runScript(
    'const p = paged.pages(); console.log("pages: " + (typeof p === "string" ? JSON.parse(p) : p).length);',
  );
  note(r.error ? `script error: ${r.error}` : r.output.join(" "));
});
form.append(script);
page.status("ready");
