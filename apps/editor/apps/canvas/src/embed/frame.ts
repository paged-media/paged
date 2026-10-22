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

// embed.html: the editor as an iframe a host drives (plan E6).

import { serveBridge } from "./bridge";
import { embedOrigins } from "./protocol";

const element = document.getElementById("root");
if (!element) throw new Error("embed.html: missing #root");
void serveBridge({
  element,
  peer: window.parent,
  origins: embedOrigins(
    import.meta.env.VITE_EMBED_ORIGINS as string | undefined,
    location.origin,
  ),
});
