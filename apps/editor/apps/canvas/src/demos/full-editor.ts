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

// Demo: the full design editor, embedded (profile `full`).

import { createEditor } from "../embed";
import { demoPage } from "./page";

const page = demoPage({
  title: "Full design editor",
  intro: "Every panel, tool and menu: the editor as a host embeds it whole.",
});
page.status("starting…");
const editor = await createEditor(page.stage, { profile: "full" });
await editor.newDocument(612, 792);
page.status("ready");
