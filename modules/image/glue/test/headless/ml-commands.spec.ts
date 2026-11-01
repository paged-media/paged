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

// Select Subject and Select Sky on the headless host (WP8.2, image ADR 485):
// the integration twin of ml-tier-a.spec.ts. The provider is registered on
// the host's ML registry AFTER the bundle loaded: the feature looks it up
// live. The model's mask becomes the session's selection and sends the
// DOCUMENT nothing.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C } from "../command-kit";
import { scripted } from "../ml-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  const s = scripted();
  k.h.ml.register(s.provider);
  return { k, ...s };
}
const sel = (k: Awaited<ReturnType<typeof ingested>>["k"]) => {
  const v = k.session.state().selection;
  return v && [v.x, v.y, v.w, v.h];
};

describe("[image.ml.select-subject] ML selection commands on the headless host", () => {
  it("selectSubject selects what the model answered, one undo step, document untouched", async () => {
    covers("command:media.paged.image.command.selectSubject");
    const { k } = await ingested();
    const depth = k.session.state().history?.depth ?? 0;
    await k.run(`${C}.selectSubject`);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.session.state().history?.depth).toBe(depth + 1);
    expect(k.changes()).toBe(0);
    await k.session.undo();
    expect(k.session.state().selection).toBeNull();
    k.dispose();
  });

  it("selectSky selects from points along the top edge", async () => {
    covers("command:media.paged.image.command.selectSky");
    const { k, seen } = await ingested();
    await k.run(`${C}.selectSky`);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(
      (seen[0] as { request: { points: unknown[] } }).request.points,
    ).toHaveLength(7);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});
