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

// Demo: two editors on one page (plan task E1). The same locked business
// card twice, side by side, each its own editor: what one is filled with,
// the other does not see, and each Submit reports its own values. The
// left one can be disposed and mounted again in place.

import { createEditor, type EditorHandle } from "../embed";
import { demoPage, section } from "./page";
import { businessCard, valuesOf } from "./templates";

const page = demoPage({
  title: "Two editors",
  intro: "Two editors on one page, each with its own document and keys.",
  aside: true,
});
page.stage.style.display = "flex";

const sides = ["left", "right"] as const;
type Side = (typeof sides)[number];
const stages = {} as Record<Side, HTMLElement>;
const results = {} as Record<Side, HTMLPreElement>;
for (const side of sides) {
  const stage = document.createElement("div");
  stage.setAttribute("data-demo-editor", side);
  stage.style.cssText =
    "flex: 1; min-width: 0; position: relative; border-right: 1px solid #d9d6cf";
  page.stage.append(stage);
  stages[side] = stage;
  const box = section(page.aside, `Submitted (${side})`);
  const pre = document.createElement("pre");
  pre.setAttribute("data-demo-submitted", side);
  pre.textContent = "Nothing submitted yet.";
  box.append(pre);
  results[side] = pre;
}

const editors: Partial<Record<Side, EditorHandle>> = {};

async function mount(side: Side): Promise<void> {
  const editor: EditorHandle = await createEditor(stages[side], {
    profile: {
      extends: "template-fill",
      regions: {
        "actions-bar": { items: [{ kind: "spacer" }, "paged.host.submit"] },
      },
    },
    actions: {
      async submit() {
        results[side].textContent = JSON.stringify(
          valuesOf(await editor.fields()),
          null,
          2,
        );
      },
    },
  });
  editors[side] = editor;
  await businessCard(editor);
  await editor.setRole("filler");
}

const tools = section(page.aside, "Host");
const remount = document.createElement("button");
remount.type = "button";
remount.textContent = "Remount the left editor";
remount.setAttribute("data-demo-remount", "");
remount.addEventListener("click", () => {
  page.status("remounting the left editor…");
  editors.left?.dispose();
  delete editors.left;
  void mount("left").then(() => page.status("ready: the left editor again"));
});
tools.append(remount);

page.status("starting two editors…");
await Promise.all(sides.map(mount));
page.status("ready: two editors");
