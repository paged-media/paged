/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

import { describe, expect, it } from "vitest";

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
