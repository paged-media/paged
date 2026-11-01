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

// Doc ADR 614 — inline content controls poured onto their runs: each
// control's runs become one `characterContentControl` write over their
// range, carrying the engine's JSON (engine ADR 1052).

import { describe, expect, it } from "bun:test";

import { buildTextPour, type LoweredParagraph } from "../src/index.js";

type Op = { op: string; args: Record<string, unknown> };

const checkbox = {
  id: "w11",
  kind: {
    type: "checkbox",
    checked: false,
    checkedGlyph: "☒",
    uncheckedGlyph: "☐",
  },
};

const para: LoweredParagraph = {
  runs: [
    { text: "Agree " },
    { text: "☐", control: checkbox },
    { text: " by " },
    { text: "Ja", control: { id: "w14", kind: { type: "richText" } } },
    { text: "ne", control: { id: "w14", kind: { type: "richText" } } },
  ],
  sourceIndex: 0,
};

describe("content controls (doc ADR 614)", () => {
  it("sets each control on its range, one write per control", () => {
    const { mutations } = buildTextPour([para], "s1", 0, 0) as unknown as {
      mutations: Op[];
    };
    const writes = mutations.filter(
      (m) =>
        m.op === "setElementProperty" &&
        m.args.path === "characterContentControl",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0].args.elementId).toEqual({
      kind: "storyRange",
      id: { story_id: "s1", start: 6, end: 7 },
    });
    const value = writes[0].args.value as { type: string; value: string };
    expect(value.type).toBe("text");
    expect(JSON.parse(value.value)).toEqual(checkbox);
    // The rich text control's two runs make one range.
    expect(writes[1].args.elementId).toEqual({
      kind: "storyRange",
      id: { story_id: "s1", start: 11, end: 15 },
    });
  });
});
