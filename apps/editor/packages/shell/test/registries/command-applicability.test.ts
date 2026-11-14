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

// Commands say why they do not apply (editor ADR 1218): the registry's one
// answer (unknown and not offered are absent; then the command's needs;
// then its `when`), the needs' fixed order, and `invoke` running only
// what applies.

import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "../../src/registries/command";
import {
  commandNeeds,
  unmetNeed,
  whenNeeds,
} from "../../src/registries/command-reasons";
import { entryApplicability } from "../../src/registries/types";

const docOpen = { document: { handle: { pageCount: 2 } } };

describe("UXI-CMD-002 — a command's applicability and its reason @uxi:UXI-PNL-004", () => {
  test("unknown, not offered, needs, when, here", () => {
    let state: unknown = {};
    const features = {
      allows: (_kind: string, id: string) => id !== "t.hidden",
      onChange: () => ({ dispose() {} }),
    };
    const r = createCommandRegistry(() => state, features as never);
    r.register({ id: "t.hidden", title: "Hidden", handler: () => {} });
    r.register({
      id: "t.group",
      title: "Group",
      when: whenNeeds("document", "selection"),
      applicability: commandNeeds("document", "selection"),
      handler: () => {},
    });
    r.register({
      id: "t.plain",
      title: "Plain",
      when: () => false,
      handler: () => {},
    });
    r.register({ id: "t.free", title: "Free", handler: () => {} });

    expect(r.applicability!("t.nope")).toEqual({
      state: "absent",
      reason: "No such command.",
    });
    expect(r.applicability!("t.hidden")).toEqual({
      state: "absent",
      reason: "This editor does not offer it.",
    });
    expect(r.applicability!("t.group")).toEqual({
      state: "disabled",
      reason: "Open a document first.",
    });
    state = { ...docOpen, selection: { elementSelection: [] } };
    expect(r.applicability!("t.group")).toEqual({
      state: "disabled",
      reason: "Select an object first.",
    });
    state = { ...docOpen, selection: { elementSelection: [{}] } };
    expect(r.applicability!("t.group")).toEqual({ state: "here" });
    expect(r.applicability!("t.plain")).toEqual({
      state: "disabled",
      reason: "Does not apply here.",
    });
    expect(r.applicability!("t.free")).toEqual({ state: "here" });
  });

  test("the first unmet need is the reason: the edit context before the selection", () => {
    const inContext = {
      ...docOpen,
      editContext: { type: "webFrame" },
      selection: { elementSelection: [] },
    };
    expect(
      unmetNeed(inContext, ["document", "outsideContext", "selection"]),
    ).toEqual({
      state: "elsewhere",
      reason: "Not while editing the web frame: press Esc to leave it.",
    });
    expect(
      unmetNeed(
        {
          ...docOpen,
          contentSelection: { contentSelection: { storyId: "s" } },
        },
        ["outsideContext", "noText", "selection"],
      ),
    ).toEqual({
      state: "disabled",
      reason: "Not while typing: press Esc to leave the text.",
    });
    expect(
      unmetNeed({ selection: { pathEditMode: true, elementSelection: [{}] } }, [
        "noPathEdit",
        "selection",
      ])?.reason,
    ).toBe("Not while editing points: press Esc first.");
    expect(unmetNeed(docOpen, ["document"])).toBeNull();
  });

  test("invoke runs only what applies here", async () => {
    let ran = 0;
    let state: unknown = docOpen;
    const r = createCommandRegistry(() => state);
    r.register({
      id: "t.sel",
      title: "Needs a selection",
      applicability: commandNeeds("selection"),
      handler: () => void ran++,
    });
    await r.invoke("t.sel");
    expect(ran).toBe(0);
    state = { ...docOpen, selection: { elementSelection: [{}] } };
    await r.invoke("t.sel");
    expect(ran).toBe(1);
  });

  test("a menu entry: its own when, then the command's answer", () => {
    const r = createCommandRegistry(() => ({}));
    r.register({
      id: "t.sel",
      title: "Needs a selection",
      applicability: commandNeeds("selection"),
      handler: () => {},
    });
    expect(
      entryApplicability(
        () => false,
        "t.sel",
        r,
        () => ({}),
      ),
    ).toEqual({
      state: "disabled",
      reason: "Does not apply here.",
    });
    expect(entryApplicability(undefined, "t.sel", r, () => ({}))).toEqual({
      state: "disabled",
      reason: "Select an object first.",
    });
  });
});
