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

// The property badge's "is it bound" read: asked of the data door (data@1),
// never of a bundle's own command.

import { describe, expect, test } from "bun:test";

import { probeBound } from "../../src/catalog/property-field-model";

const objects = (map: Record<string, string[]>) => ({
  query: async (selector: string) => map[selector] ?? [],
});
const service = (b: Array<{ target: string; path: string }>) => ({
  bindings: async () => b,
});

describe("probeBound over the data door", () => {
  test("a binding whose target is the address, or a selector selecting it", async () => {
    const svc = service([
      { target: "rectangle:u1", path: "frameFillColor" },
      { target: "frame[oid=x]", path: "frameStrokeWeight" },
    ]);
    const o = objects({ "frame[oid=x]": ["rectangle:u2"] });
    expect(await probeBound(svc, o, ["rectangle:u1"], "frameFillColor")).toBe(
      true,
    );
    expect(
      await probeBound(svc, o, ["rectangle:u2"], "frameStrokeWeight"),
    ).toBe(true);
  });

  test("another path, another object, no service, no bindings door, a failure: not bound", async () => {
    const svc = service([{ target: "rectangle:u1", path: "frameFillColor" }]);
    const o = objects({});
    expect(
      await probeBound(svc, o, ["rectangle:u1"], "frameStrokeWeight"),
    ).toBe(false);
    expect(await probeBound(svc, o, ["rectangle:u9"], "frameFillColor")).toBe(
      false,
    );
    expect(await probeBound(null, o, ["rectangle:u1"], "frameFillColor")).toBe(
      false,
    );
    expect(await probeBound({}, o, ["rectangle:u1"], "frameFillColor")).toBe(
      false,
    );
    const failing = {
      bindings: async () => {
        throw new Error("down");
      },
    };
    expect(
      await probeBound(failing, o, ["rectangle:u1"], "frameFillColor"),
    ).toBe(false);
    expect(await probeBound(svc, o, [], "frameFillColor")).toBe(false);
  });
});
