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

// The editor's page entry: one editor in `#root`, configured by the URL
// (`?profile=`, `?solo=`, `?locale=`) and, for its language, the user's
// choice and the browser's languages (`app/locale.ts`). An embedding host calls `mountEditor`
// itself (docs/composable-editor.md §8; plan task E1); what this page adds
// around it is the page's: the journal's error net, and in dev and demo
// builds the `__*` handles the tests and the playground drive the editor
// by, and the playground's tools.

import { pageStorage } from "@paged-media/shell";
import {
  BUILT_IN_LOCALES,
  loadLocale,
  type Strings,
} from "@paged-media/strings";

import { publishDevHandles } from "./app/dev-handles";
import { chooseLocale, needsCatalogue } from "./app/locale";
import { DEV_TOOLS, TEST_AFFORDANCES } from "./build-flags";
import {
  exposeJournalForTests,
  installGlobalErrorCapture,
} from "./journal-sink";
import { mountEditor } from "./main";

// ADR 025 — the journal's global net. Without a window.onerror /
// unhandledrejection handler any throw outside a React render is invisible:
// nothing to attribute it to, nothing to put in a bug report. Installed
// before the first render so a crash DURING it is caught.
installGlobalErrorCapture();
if (TEST_AFFORDANCES) {
  // Test affordance, same shape as `__overlaySignals` / `__pagedCrash`.
  exposeJournalForTests();
}

const found = document.getElementById("root");
if (!found) {
  throw new Error("missing #root");
}
const root: HTMLElement = found;

/** The page is the editor's, so its <html> follows the editor's theme:
 *  the page's canvas (index.html's body background) wears the editor's
 *  surface. The editor itself writes nothing on the page; this page does,
 *  for itself. */
function mirrorTheme(host: HTMLElement): void {
  const html = document.documentElement;
  let watched: Element | null = null;
  const onClass = new MutationObserver(() => {
    html.classList.toggle("dark", watched?.classList.contains("dark") ?? true);
  });
  const follow = () => {
    const root = host.querySelector(":scope > [data-paged-editor]");
    if (!root || root === watched) return;
    watched = root;
    onClass.disconnect();
    onClass.observe(root, { attributes: true, attributeFilter: ["class"] });
    html.classList.toggle("dark", root.classList.contains("dark"));
  };
  new MutationObserver(follow).observe(host, { childList: true });
  html.classList.add("dark");
  follow();
}

function mount(strings?: Strings): void {
  const mounted = mountEditor(root, {
    search: location.search,
    devTools: true,
    ownsPage: true,
    guardUnload: true,
    // The page is the editor's: its settings live in the page's storage,
    // under the keys scripts/settings-inventory.json lists.
    storage: pageStorage(),
    ...(strings ? { strings } : {}),
  });
  if (DEV_TOOLS) publishDevHandles(mounted.instance);
  mirrorTheme(root);
}

const { locale } = chooseLocale({
  search: location.search,
  storage: pageStorage(),
  languages: navigator.languages ?? [navigator.language],
  shipped: Object.keys(BUILT_IN_LOCALES),
});
if (needsCatalogue(locale)) {
  void loadLocale(locale).then(({ strings, problem }) => {
    if (problem) console.warn(`[editor locale] ${problem}`);
    else document.documentElement.lang = locale;
    mount(strings);
  });
} else {
  mount();
}
