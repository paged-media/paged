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

// The conformance suite is only evidence about the engine it BOOTED.
// `openHost()` probes three places for `@paged-media/canvas-wasm` — this
// package's own devDependency first, then two sibling editor checkouts —
// and on a developer machine all three usually exist, at different
// versions. This pins the answer: the engine every spec here ran against
// is the one `package.json` names, so a bumped pin that silently resolves
// to an older sibling build cannot report green.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { openHost } from "./conformance/host";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("the headless harness boots the pinned engine", () => {
  it("engineVersion is the canvas-wasm devDependency, and its minor is the protocol", async () => {
    const pkg = JSON.parse(
      readFileSync(resolve(HERE, "../package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    const pinned = pkg.devDependencies["@paged-media/canvas-wasm"];
    const h = await openHost();
    try {
      expect(h.engineVersion).toBe(pinned);
      expect(h.protocolVersion).toBe(Number(pinned.split(".")[1]));
    } finally {
      h.dispose();
    }
  });
});
