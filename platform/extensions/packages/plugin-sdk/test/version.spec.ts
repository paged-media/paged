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

import { describe, expect, it } from "bun:test";

import { API_VERSION, satisfiesApiVersion } from "../src/version";

describe("satisfiesApiVersion", () => {
  it("wildcard matches anything", () => {
    expect(satisfiesApiVersion("*", "9.9.9")).toBe(true);
  });

  it("exact matches (missing patch = 0)", () => {
    expect(satisfiesApiVersion("0.2.0", "0.2.0")).toBe(true);
    expect(satisfiesApiVersion("0.2", "0.2.0")).toBe(true);
    expect(satisfiesApiVersion("0.2.0", "0.2.1")).toBe(false);
  });

  it("caret on 0.x locks the minor (incubation rule)", () => {
    expect(satisfiesApiVersion("^0.2", "0.2.0")).toBe(true);
    expect(satisfiesApiVersion("^0.2.0", "0.2.5")).toBe(true);
    expect(satisfiesApiVersion("^0.2", "0.3.0")).toBe(false);
    expect(satisfiesApiVersion("^0.1", "0.2.0")).toBe(false);
  });

  it("caret on >=1 locks the major", () => {
    expect(satisfiesApiVersion("^1.2.3", "1.3.0")).toBe(true);
    expect(satisfiesApiVersion("^1.2.3", "1.2.2")).toBe(false);
    expect(satisfiesApiVersion("^1.2.3", "2.0.0")).toBe(false);
  });

  it("defaults to the SDK's own API_VERSION", () => {
    expect(satisfiesApiVersion(`^${API_VERSION}`)).toBe(true);
  });

  it("malformed input is a refusal, not a pass", () => {
    expect(satisfiesApiVersion("latest")).toBe(false);
    expect(satisfiesApiVersion("^x.y")).toBe(false);
  });
});
