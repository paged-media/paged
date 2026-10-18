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

// The suite is evidence about the contract it RESOLVED, not the one the
// manifest names. Two things are pinned here:
//
// 1. the installed plugin-api / plugin-sdk are the workspace packages the
//    devDependencies name (`workspace:*`; a stale node_modules or a stray
//    npm pin would otherwise test some other contract and report green);
// 2. the peers name what these specs ran against: the same workspace
//    packages. Until 2026-10-04 the floor said >=0.2.29, the specs ran
//    0.2.33 and the editor shipped 0.2.37: the bundle claimed a range
//    nobody had tested at either end.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(HERE, "../package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

const CONTRACT = ["@paged-media/plugin-api", "@paged-media/plugin-sdk"] as const;

/** The workspace package a contract name resolves to. */
const workspaceDir = (name: string): string =>
  realpathSync(resolve(HERE, "../../../../platform/extensions/packages", name.slice("@paged-media/".length)));

describe("the SDK contract the specs run against", () => {
  for (const name of CONTRACT) {
    it(`${name}: installed = the workspace package the devDependency names`, () => {
      expect(pkg.devDependencies[name]).toBe("workspace:*");
      expect(realpathSync(resolve(HERE, "../node_modules", name))).toBe(workspaceDir(name));
    });

    it(`${name}: the peer names the same workspace package`, () => {
      expect(pkg.peerDependencies[name]).toBe(pkg.devDependencies[name]);
    });
  }

  it("both packages are pinned to the same version (they release together)", () => {
    expect(pkg.devDependencies[CONTRACT[0]]).toBe(pkg.devDependencies[CONTRACT[1]]);
  });
});
