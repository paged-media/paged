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

// A kind core does not describe yet, added to the vendored catalog for the
// length of one test: what an engine that adds a kind does (plan C16).

import { CORE_EFFECT_KINDS } from "@paged-media/plugin-sdk";
import type { EffectKindDescriptor } from "@paged-media/plugin-api";

/** Run `fn` with a kind core does not have yet in the catalog, as a
 *  later engine adds one (plan C16: the editor lists it unchanged). */
export function withFutureKind<T>(fn: () => T): T {
  const kinds = CORE_EFFECT_KINDS as EffectKindDescriptor[];
  const future: EffectKindDescriptor = {
    kind: "crystallize",
    title: "Crystallize",
    category: "distortAndTransform",
    indesign: false,
    targets: ["object"],
    blend: true,
    params: [
      {
        field: "sizePct",
        title: "Size",
        type: { kind: "number", unit: "percent" },
        range: { min: 0, max: 100 },
        default: 5,
      },
    ],
  };
  kinds.push(future);
  try {
    return fn();
  } finally {
    kinds.pop();
  }
}
