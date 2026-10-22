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

// Demo: the viewer. The canvas and its pages, nothing to change (profile
// `viewer`, role viewer).

import { createEditor } from "../embed";
import { demoPage } from "./page";
import { photobook } from "./templates";

const page = demoPage({
  title: "Viewer",
  intro:
    "Proofing inside a review workflow: the document as it prints, read-only.",
});
const editor = await createEditor(page.stage, { profile: "viewer" });
await photobook(editor);
await editor.setRole("viewer");
page.status("ready");
