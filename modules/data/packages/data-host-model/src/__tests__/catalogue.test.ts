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

// ADR 560: a catalogue's decided values become the mutations the canvas
// engine's template form writes (engine ADR 1001), one copy after another.

import { describe, expect, it } from "bun:test";

import {
  catalogueFieldKind,
  catalogueFillOps,
  fieldValueOps,
  type TemplateFieldRow,
} from "../index";

const text = (name: string, story: string, old: string): TemplateFieldRow => ({
  field: { name, kind: "text" },
  targetId: `tf-${name}`,
  elementId: { kind: "textFrame", id: `tf-${name}` },
  storyId: story,
  value: { kind: "text", text: old },
});

const image: TemplateFieldRow = {
  field: { name: "photo", kind: "image", constraints: { fit: "fill" } },
  targetId: "rphoto",
  elementId: { kind: "rectangle", id: "rphoto" },
  storyId: null,
  value: null,
};

const badge: TemplateFieldRow = {
  field: { name: "badge", kind: "visibility" },
  targetId: "rbadge",
  elementId: { kind: "rectangle", id: "rbadge" },
  storyId: null,
  value: { kind: "visible", visible: true },
};

describe("catalogue values as template-form writes", () => {
  it("a text is inserted before the old one, which is then deleted (code points)", () => {
    expect(
      fieldValueOps(text("title", "s1", "Ä😀c"), {
        outcome: "text",
        text: "Beta",
      }),
    ).toEqual([
      { op: "insertText", args: { storyId: "s1", offset: 0, text: "Beta" } },
      { op: "deleteRange", args: { storyId: "s1", start: 4, end: 7 } },
    ]);
    // An empty value deletes, an empty field only inserts.
    expect(
      fieldValueOps(text("title", "s1", "old"), { outcome: "text", text: "" }),
    ).toEqual([
      { op: "deleteRange", args: { storyId: "s1", start: 0, end: 3 } },
    ]);
    expect(
      fieldValueOps(text("title", "s1", ""), { outcome: "text", text: "x" }),
    ).toEqual([
      { op: "insertText", args: { storyId: "s1", offset: 0, text: "x" } },
    ]);
  });

  it("a picture is placed with the field's fit; a visibility sets elementVisible", () => {
    expect(fieldValueOps(image, { outcome: "image", uri: "a.png" })).toEqual([
      {
        op: "placeImage",
        args: { elementId: "rphoto", uri: "a.png", fit: "fill" },
      },
    ]);
    expect(
      fieldValueOps(badge, { outcome: "visible", visible: false }),
    ).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: { kind: "rectangle", id: "rbadge" },
          path: "elementVisible",
          value: { type: "bool", value: false },
        },
      },
    ]);
  });

  it("leave, a refusal and a value of another kind write nothing", () => {
    expect(fieldValueOps(image, { outcome: "leave" })).toEqual([]);
    expect(
      fieldValueOps(image, {
        outcome: "refused",
        code: "required",
        detail: "",
      }),
    ).toEqual([]);
    expect(fieldValueOps(image, { outcome: "text", text: "x" })).toEqual([]);
  });

  it("only the engine's own kinds are filled", () => {
    expect(
      ["text", "image", "visibility", "module", "choice"].map(
        catalogueFieldKind,
      ),
    ).toEqual(["text", "image", "visibility", null, null]);
  });

  it("every copy's writes go into one list, in copy order; a field a copy lacks is named", () => {
    const fill = catalogueFillOps([
      {
        rows: new Map([["title", text("title", "s1", "T")]]),
        values: [{ field: "title", outcome: "text", text: "A" }],
      },
      {
        rows: new Map([["title", text("title", "s2", "T")]]),
        values: [
          { field: "title", outcome: "text", text: "B" },
          { field: "badge", outcome: "visible", visible: true },
        ],
      },
    ]);
    expect(
      fill.ops.map((o) => (o.args as { storyId?: string }).storyId),
    ).toEqual(["s1", "s1", "s2", "s2"]);
    expect(fill.missing).toEqual({ 1: ["badge"] });
  });
});
