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

// Demo: theming and translation. The same fill-in editor in the host's
// language and colours: light or dark, a brand accent, English or German.

import { createEditor, type EditorHandle } from "../embed";
import { demoPage, section } from "./page";
import { businessCard } from "./templates";

const page = demoPage({
  title: "Theme and language",
  intro:
    "The host's colours and language: light or dark, a brand accent, English or German.",
  aside: true,
});

const box = section(page.aside, "Look and language");
const control = (label: string, options: [string, string][], attr: string) => {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const select = document.createElement("select");
  select.setAttribute(attr, "");
  for (const [value, text] of options) select.append(new Option(text, value));
  wrap.append(select);
  box.append(wrap);
  return select;
};
const language = control(
  "Language",
  [
    ["en", "English"],
    ["de", "Deutsch"],
  ],
  "data-demo-language",
);
const mode = control(
  "Theme",
  [
    ["light", "Light"],
    ["dark", "Dark"],
  ],
  "data-demo-mode",
);
const accent = control(
  "Brand accent",
  [
    ["", "The editor's own"],
    ["160 84% 30%", "Green"],
    ["24 95% 45%", "Orange"],
  ],
  "data-demo-accent",
);

let editor: EditorHandle | null = null;
const applyTheme = () =>
  editor?.setTheme({
    mode: mode.value as "light" | "dark",
    tokens: {
      "--paged-primary": accent.value || null,
      "--paged-ring": accent.value || null,
    },
  });

async function open() {
  editor?.dispose();
  page.stage.replaceChildren();
  page.status("starting…");
  editor = await createEditor(page.stage, {
    profile: "template-fill",
    locale: language.value,
  });
  await businessCard(editor);
  await editor.setRole("filler");
  applyTheme();
  page.status(`ready (${language.value})`);
}

language.addEventListener("change", () => void open());
mode.addEventListener("change", applyTheme);
accent.addEventListener("change", applyTheme);
await open();
