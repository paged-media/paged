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

// A `?script=` waits for the page's `?sample=` (editor ADR 1243, amendment 2):
// the tour of a sample starts once the sample has opened, or the link has
// given up; with no sample to wait for it starts at once.

import { expect, test } from "bun:test";
import {
  sampleLinkPending,
  sampleLinkSettled,
  settleSampleLink,
} from "../../src/samples/link";

const env = import.meta.env as Record<string, unknown>;

test("a script on a page without ?sample= starts at once", async () => {
  expect(sampleLinkPending("?script=tour")).toBe(false);
  await sampleLinkSettled("?script=tour");
});

test("without a catalog this build opens no sample, so nothing waits", () => {
  const before = env.VITE_SAMPLES_URL;
  delete env.VITE_SAMPLES_URL;
  expect(sampleLinkPending("?sample=lookbook&script=tour-publication")).toBe(
    env.MODE === "demo",
  );
  if (before !== undefined) env.VITE_SAMPLES_URL = before;
});

test("with a catalog, a script waits until the sample link settles", async () => {
  const before = env.VITE_SAMPLES_URL;
  env.VITE_SAMPLES_URL = "https://host.example/samples/catalog.json";
  try {
    const search = "?sample=lookbook&script=tour-publication";
    expect(sampleLinkPending(search)).toBe(true);
    let started = false;
    const waiting = sampleLinkSettled(search).then(() => (started = true));
    await Promise.resolve();
    expect(started).toBe(false);
    settleSampleLink();
    await waiting;
    expect(started).toBe(true);
  } finally {
    if (before === undefined) delete env.VITE_SAMPLES_URL;
    else env.VITE_SAMPLES_URL = before;
  }
});
