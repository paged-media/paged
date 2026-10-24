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

// The handle's features take a deprecated id (PM-0013, amendment 2): it is
// read as its replacement, an id with no replacement switches nothing, and
// the old id is reported once.

import { describe, expect, test } from "bun:test";

import {
  createFeatureStore,
  createIdAliases,
  type IdDeprecation,
} from "@paged-media/shell";

import { aliasedFeatures } from "../../src/embed/create-editor";

const LIST: IdDeprecation[] = [
  {
    id: "menu:Object/Make clipping mask",
    replacement: "menu:Object/Clipping mask/Make",
    deprecatedIn: "0.76.0",
    removeIn: "0.78.0",
  },
  {
    id: "panel:paged.gone",
    replacement: null,
    deprecatedIn: "0.76.0",
    removeIn: "0.78.0",
  },
];

describe("handle.features with deprecated ids", () => {
  test("an old id switches its replacement and is reported once", () => {
    const store = createFeatureStore();
    const aliases = createIdAliases(LIST);
    const met: string[] = [];
    aliases.subscribe((d) => met.push(d.id));
    const features = aliasedFeatures(store, aliases);
    features.disable("menu:Object/Make clipping mask");
    expect(store.isEnabled("menu:Object/Clipping mask/Make")).toBe(false);
    expect(features.isEnabled("menu:Object/Make clipping mask")).toBe(false);
    features.reset("menu:Object/Make clipping mask");
    expect(store.isEnabled("menu:Object/Clipping mask/Make")).toBe(true);
    expect(met).toEqual(["menu:Object/Make clipping mask"]);
  });

  test("an id with no replacement switches nothing; current ids and globs pass through", () => {
    const store = createFeatureStore();
    const features = aliasedFeatures(store, createIdAliases(LIST));
    features.disable(["panel:paged.gone", "command:paged.object.*"]);
    expect(store.rules().map((r) => r.pattern)).toEqual([
      "command:paged.object.*",
    ]);
    expect(features.allows("command", "paged.object.lock")).toBe(false);
    expect(features.isEnabled("panel:paged.gone")).toBe(true);
  });
});
