/*
 * This file is part of paged (https://paged.media).
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

// One ordered chain for a handler's asynchronous pointer work: a step
// that awaits a read (a hit test, a path read) must never let a later
// pointer event overtake it — a machine must not see an up before the
// down it follows (the Curvature handler's rule, shared).

import type { BundleHost } from "@paged-media/plugin-api";

export interface Serial {
  run(step: () => Promise<void> | void): void;
  /** Resolves when everything queued so far has run (specs). */
  idle(): Promise<void>;
}

export function serial(host: BundleHost, label: string): Serial {
  let chain: Promise<void> = Promise.resolve();
  return {
    run(step) {
      chain = chain
        .then(step)
        .catch((err) => host.log.warn(`${label}: ${String(err)}`));
    },
    idle: () => chain,
  };
}
