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

// Editor ADR 1225 — the filler's progress through a template's fields.

import { describe, expect, test } from "bun:test";

import type { TemplateFieldSummary } from "@paged-media/client";

import {
  fieldFilled,
  formProgress,
  nextIncomplete,
} from "../../src/panels/template/progress";

const row = (
  name: string,
  value: TemplateFieldSummary["value"],
  required = false,
  overset = false,
) =>
  ({
    field: { name, kind: "text", required },
    targetId: name,
    elementId: null,
    storyId: null,
    value,
    overset,
  }) as unknown as TemplateFieldSummary;

describe("template form progress", () => {
  const rows = [
    row("a", { kind: "text", text: "Ada" }),
    row("b", { kind: "text", text: "  " }, true),
    row("c", null),
    row("d", { kind: "image", uri: "p.png" }, true),
    row("e", null, true),
  ];

  test("counts what holds a value; blank text is empty", () => {
    expect(rows.map(fieldFilled)).toEqual([true, false, false, true, false]);
    expect(formProgress(rows)).toEqual({
      total: 5,
      filled: 2,
      requiredMissing: ["b", "e"],
      overset: [],
      next: "b",
      ready: false,
    });
  });

  test("walks the required fields first, round the form, then the optional ones", () => {
    expect(nextIncomplete(rows, null)).toBe("b");
    expect(nextIncomplete(rows, "b")).toBe("e");
    expect(nextIncomplete(rows, "e")).toBe("b");
    const optional = [row("a", null), row("b", { kind: "text", text: "x" })];
    expect(nextIncomplete(optional, null)).toBe("a");
    expect(
      nextIncomplete([row("a", { kind: "text", text: "x" })], null),
    ).toBeNull();
  });

  test("text that does not fit its frame holds Finish back", () => {
    const p = formProgress([row("a", { kind: "text", text: "x" }, true, true)]);
    expect(p).toMatchObject({
      ready: false,
      overset: ["a"],
      requiredMissing: [],
    });
  });
});
