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
// (`?profile=`, `?solo=`, `?locale=`). An embedding host calls `mountEditor`
// itself (docs/composable-editor.md §8; plan task E1).

import { loadLocale } from "@paged-media/strings";

import { mountEditor } from "./main";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}
const locale = new URLSearchParams(location.search).get("locale");
if (locale) {
  void loadLocale(locale).then(({ strings, problem }) => {
    if (problem) console.warn(`[editor locale] ${problem}`);
    mountEditor(root, { search: location.search, strings });
  });
} else {
  mountEditor(root, { search: location.search });
}
