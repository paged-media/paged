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

// Demo: a custom host UI around the editor. No editor header; an actions
// bar the host composes (its own price display in a host slot, Undo,
// Submit), and the template form.

import { createEditor, type EditorHandle } from "../embed";
import { demoPage } from "./page";
import { businessCard } from "./templates";

const page = demoPage({
  title: "Custom host UI",
  intro:
    "The host decides the chrome: its own actions bar, its own price, its own Submit.",
});
let editor: EditorHandle;
editor = await createEditor(page.stage, {
  profile: {
    extends: "template-fill",
    regions: {
      header: null,
      "actions-bar": {
        items: [
          "paged.host.back",
          { kind: "host", id: "price" },
          { kind: "spacer" },
          "paged.editor.undo",
          "paged.host.close",
          "paged.host.submit",
        ],
      },
    },
  },
  actions: {
    submit() {
      page.status("ordered: 250 cards");
    },
    back() {
      page.status("back to the shop");
    },
    close() {
      page.status("closed without ordering");
    },
  },
});
await businessCard(editor);
await editor.setRole("filler");
const slot = editor.hostSlot("price");
if (slot) {
  slot.textContent = "250 cards · 39.00";
  slot.setAttribute("data-demo-price", "");
  slot.style.fontWeight = "600";
}
page.status("ready");
