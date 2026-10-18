/**
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
// A number row that also takes words: core's catalog types a span count
// as `{ kind: "number", unit: "count", members: ["All"] }`. The members
// must survive normalisation, or every write of "All" is refused before
// it reaches the engine (the Paragraph panel's Columns: All did exactly
// that on the first protocol-71 build).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeCoreType } from "../src/core-schema";
import { checkValueType, coerceValue, validateValue } from "../src/object-schema";

describe("a number row's keywords", () => {
  it("survive normalisation of core's catalog row", () => {
    expect(normalizeCoreType({ kind: "number", unit: "count", members: ["All"] })).toEqual({
      kind: "number",
      integer: true,
      keywords: ["All"],
    });
    expect(normalizeCoreType({ kind: "number", unit: "count" })).toEqual({ kind: "number", integer: true });
  });

  it("are taken by validation and text coercion, and nothing else is", () => {
    const t = { kind: "number", integer: true, keywords: ["All"] } as const;
    expect(validateValue(t, "All")).toBeNull();
    expect(validateValue(t, 3)).toBeNull();
    expect(validateValue(t, "Some")).toMatch(/number or one of All/);
    expect(validateValue({ kind: "number" }, "All")).toMatch(/must be a number$/);
    expect(coerceValue(t, "All")).toEqual({ ok: true, value: "All" });
    expect(coerceValue(t, "4")).toEqual({ ok: true, value: 4 });
  });

  it("are checked for shape", () => {
    expect(checkValueType({ kind: "number", keywords: ["All"] })).toBeNull();
    expect(checkValueType({ kind: "number", keywords: [1] })).toMatch(/keywords must be strings/);
  });

  it("the vendored catalog's span count keeps \"All\"", () => {
    const catalog = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../plugin-api/src/catalog.json", import.meta.url)), "utf8"),
    ) as { propertySchemas?: Array<{ path: string; type: { kind: string; unit?: string; members?: string[] } }> };
    const rows = (catalog.propertySchemas ?? []).filter((r) => r.path === "paragraphSpanSplitColumnCount");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(normalizeCoreType(r.type)).toMatchObject({ keywords: ["All"] });
  });
});
