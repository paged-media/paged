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

// Editor ADR 304 — while a presentation fills the editor's window, the
// editor's chrome goes: one chrome override (ADR 283) that keeps only the
// canvas region, with no title bar, rulers or thumbnails. The presenter
// (registries/presentation.ts) lays the surface over the whole window;
// this component only takes the chrome away and gives it back.

import { useEffect } from "react";

import { useChromeOverride } from "../state/chrome-regions";
import { useRegistryView } from "../state/live";
import { useRegistries } from "../state/registries-context";

/** What a presentation in the editor's window leaves of the chrome. */
const PRESENTING = {
  keep: ["canvas"] as const,
  canvas: { titleBar: false, rulers: false, thumbnails: false },
};

export function PresentationChrome() {
  const presentations = useRegistryView(useRegistries().presentations);
  const pushOverride = useChromeOverride();
  const presenting = presentations.inEditorWindow();
  useEffect(() => {
    if (!presenting) return;
    return pushOverride({
      keep: [...PRESENTING.keep],
      canvas: PRESENTING.canvas,
    });
  }, [presenting, pushOverride]);
  return null;
}
