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

// RFI C-65 — what one link WALK costs depends on the engine, and the
// budgets say so instead of pinning one engine's number.
//
// An engine whose scene tree carries each item row's `pluginMetadata`
// (protocol 66) answers every leaf's envelope in the walk's one tree
// read: ZERO `getMetadata` per leaf. An older one (≤ 0.65.0) answers
// none of them there: ONE per leaf. A budget written as
// `leaves * perLeaf` is therefore the measured value on BOTH engines,
// and drops to the tree read alone the moment the pin moves — the
// before/after the C-65 row was filed for.

import type { BundleHost } from "@paged-media/plugin-api";

/** 0 when `host`'s engine reports metadata on tree rows, else 1. Reads
 *  the tree once (call it on the RAW host, outside any counted span). */
export async function metadataReadsPerLeaf(host: BundleHost): Promise<0 | 1> {
  let carries = false;
  const walk = (nodes: readonly { children?: unknown[]; pluginMetadata?: unknown }[]) => {
    for (const n of nodes) {
      if (Array.isArray(n.pluginMetadata)) carries = true;
      if (n.children) walk(n.children as never);
    }
  };
  walk((await host.document.tree()) as never);
  return carries ? 0 : 1;
}
