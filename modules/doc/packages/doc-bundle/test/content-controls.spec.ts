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

// Doc ADR 614 — the content control at the caret: found in the story read
// by content offset, and each panel action one engine mutation (engine ADR
// 1052) — toggle, choose an item, set a value.

import { describe, expect, it } from "bun:test";

import {
  controlAt,
  controlMutation,
  type ControlAtCaret,
} from "../src/word/controls";

const paragraphs = [
  { runs: [{ text: "First." }] },
  {
    runs: [
      { text: "Agree " },
      { text: "☐", control: { id: "w11", kind: "checkbox", checked: false } },
      { text: " colour " },
      {
        text: "Red",
        control: {
          id: "w12",
          kind: "dropDown",
          items: [
            { display: "Red", value: "r" },
            { display: "Blue", value: "b" },
          ],
          value: "r",
        },
      },
    ],
  },
];

describe("content control at the caret (doc ADR 614)", () => {
  it("finds the control whose text holds the caret", () => {
    // "First." + mark = 7 bytes; "Agree " 6 more; ☐ is 3 bytes.
    expect(controlAt(paragraphs, 13)?.control.id).toBe("w11");
    expect(controlAt(paragraphs, 16)?.control.id).toBe("w11");
    expect(controlAt(paragraphs, 18)).toBeNull();
    const dd = controlAt(paragraphs, 25);
    expect(dd?.control.id).toBe("w12");
    expect(dd?.text).toBe("Red");
    expect(controlAt(paragraphs, 3)).toBeNull();
  });

  it("maps each action to its one-step mutation", () => {
    const at: ControlAtCaret = {
      storyId: "s",
      text: "Red",
      control: { id: "w12", kind: "dropDown" },
    };
    expect(controlMutation(at, { kind: "toggle" })).toEqual({
      op: "toggleContentControl",
      args: { storyId: "s", controlId: "w12" },
    });
    expect(controlMutation(at, { kind: "choose", index: 1 })).toEqual({
      op: "chooseContentControlItem",
      args: { storyId: "s", controlId: "w12", index: 1 },
    });
    expect(controlMutation(at, { kind: "set", value: "2026-10-30" })).toEqual({
      op: "setContentControlValue",
      args: { storyId: "s", controlId: "w12", value: "2026-10-30" },
    });
  });
});
