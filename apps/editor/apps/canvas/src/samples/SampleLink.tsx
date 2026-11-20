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

// `?sample=<id>` (editor ADR 1243): open a sample document from a link — the
// website's demo and the films land on a finished publication, not an
// empty canvas. Renders nothing; opens the sample once the editor is up.

import { useEffect, useRef } from "react";
import { useOptionalPaged } from "@paged-media/shell";
import { loadCatalog, openSample, samplesEnabled } from "./catalog";
import { settleSampleLink } from "./link";

export function SampleLink() {
  const paged = useOptionalPaged();
  const done = useRef(false);
  useEffect(() => {
    if (!paged || done.current || !samplesEnabled()) return;
    const id = new URLSearchParams(window.location.search).get("sample");
    if (!id) return;
    done.current = true;
    void loadCatalog()
      .then((samples) => {
        const sample = samples.find((s) => s.id === id);
        if (!sample) {
          console.warn(`[samples] no sample "${id}" in the catalog`);
          return;
        }
        return openSample(paged, sample, {
          setStatus: () => undefined,
          pushWarning: (w) => console.warn(`[samples] ${w}`),
        }).catch((e) => console.warn(`[samples] ${String(e)}`));
      })
      // A `?script=` on the same page starts now (link.ts).
      .finally(settleSampleLink);
  }, [paged]);
  return null;
}
