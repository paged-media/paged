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

// [sheet.plugin.bundle] The suite is evidence about the contract it
// RESOLVED, not the one a manifest names. Pinned here:
//
// 1. the installed plugin-api / plugin-sdk are the workspace packages the
//    devDependencies name (`workspace:*`; a stale node_modules or a stray
//    npm pin would otherwise test some other contract and report green);
// 2. sheet-host-model depends on the SAME plugin-api. Until
//    2026-10-04 it floated on the `canary` dist-tag (resolving 0.2.36)
//    while sheet-bundle pinned 0.2.33 and the editor shipped 0.2.37: two
//    packages of one plugin compiled against different contracts;
// 3. the peers name the same workspace packages as the devDependencies.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const readJson = (p: string): Pkg => JSON.parse(readFileSync(p, "utf8")) as Pkg;
const bundle = readJson(resolve(HERE, "../package.json"));
const hostModelDir = resolve(HERE, "../../sheet-host-model");
const hostModel = readJson(resolve(hostModelDir, "package.json"));

const API = "@paged-media/plugin-api";
const SDK = "@paged-media/plugin-sdk";
const WORKSPACE = "workspace:*";
/** The workspace package a contract name resolves to. */
const workspaceDir = (name: string): string =>
  realpathSync(resolve(HERE, "../../../../../platform/extensions/packages", name.slice("@paged-media/".length)));

/** The version installed under `<pkgDir>/node_modules/<name>` — read from
 *  the file, because the packages' `exports` map hides `./package.json`. */
function installedVersion(pkgDir: string, name: string): string {
  const dir = realpathSync(resolve(pkgDir, "node_modules", name));
  return (JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { version: string })
    .version;
}

describe("the SDK contract the specs run against [sheet.plugin.bundle]", () => {
  for (const name of [API, SDK]) {
    const pin = bundle.devDependencies?.[name] ?? "";

    it(`${name}: sheet-bundle takes the workspace package (no npm version, no range)`, () => {
      expect(pin).toBe(WORKSPACE);
    });

    it(`${name}: installed = the workspace package the devDependency names`, () => {
      expect(realpathSync(resolve(HERE, "..", "node_modules", name))).toBe(workspaceDir(name));
    });

    it(`${name}: the peer names the same workspace package`, () => {
      expect(bundle.peerDependencies?.[name]).toBe(pin);
    });
  }

  it("plugin-api and plugin-sdk are pinned to the same version (they release together)", () => {
    expect(bundle.devDependencies?.[API]).toBe(bundle.devDependencies?.[SDK]);
  });

  it("sheet-host-model depends on the same plugin-api (no floating `canary`)", () => {
    expect(hostModel.dependencies?.[API]).toBe(bundle.devDependencies?.[API]);
    expect(installedVersion(hostModelDir, API)).toBe(installedVersion(resolve(HERE, ".."), API));
  });
});
