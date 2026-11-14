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

// The editor's command families say why they do not apply (editor ADR
// 1218): the Object verbs name the edit context, the caret and the missing
// selection, in that order; every command whose `when` is false has a
// reason, and its applicability agrees with its `when`.

import { describe, expect, test } from "bun:test";

import { createCommandRegistry, isEnabled } from "@paged-media/shell";

import {
  buildAppCommands,
  PAGED_VIEW_GO_TO_PAGE,
} from "../../../src/app-commands";
import { buildObjectCommands } from "../../../src/object-commands";

const STATES: Record<string, unknown> = {
  noDocument: {},
  nothingSelected: {
    document: { handle: { pageCount: 1 } },
    selection: { elementSelection: [] },
  },
  selected: {
    document: { handle: { pageCount: 1 } },
    selection: { elementSelection: [{ kind: "rectangle", id: "r" }] },
  },
  inContext: {
    document: { handle: { pageCount: 1 } },
    editContext: { type: "sheetFrame" },
    selection: { elementSelection: [{ kind: "rectangle", id: "r" }] },
  },
  typing: {
    document: { handle: { pageCount: 1 } },
    contentSelection: { contentSelection: { storyId: "s", start: 0, end: 0 } },
    selection: { elementSelection: [{ kind: "textFrame", id: "t" }] },
  },
};

describe("UXI-CMD-002 — the editor's commands give their reasons @uxi:UXI-PNL-004", () => {
  test("Group: select first; leave the context first; then it applies", () => {
    let state: unknown = STATES.nothingSelected;
    const r = createCommandRegistry(() => state);
    for (const c of buildObjectCommands({} as never)) r.register(c);
    expect(r.applicability!("paged.object.group")).toEqual({
      state: "disabled",
      reason: "Select an object first.",
    });
    state = STATES.inContext;
    expect(r.applicability!("paged.object.group")).toEqual({
      state: "elsewhere",
      reason: "Not while editing the sheet frame: press Esc to leave it.",
    });
    state = STATES.selected;
    expect(r.applicability!("paged.object.group").state).toBe("here");
  });

  test("Delete while typing says so", () => {
    const r = createCommandRegistry(() => STATES.typing);
    for (const c of buildObjectCommands({} as never)) r.register(c);
    expect(r.applicability!("paged.object.delete")).toEqual({
      state: "disabled",
      reason: "Not while typing: press Esc to leave the text.",
    });
  });

  test("every command's applicability agrees with its when, in every state", () => {
    const commands = [
      ...buildObjectCommands({} as never),
      ...buildAppCommands({} as never),
    ];
    for (const [name, state] of Object.entries(STATES)) {
      const r = createCommandRegistry(() => state);
      for (const c of commands) r.register(c);
      for (const c of commands) {
        const verdict = r.applicability!(c.id);
        const when = isEnabled(c.when, () => state);
        expect({ name, id: c.id, here: verdict.state === "here" }).toEqual({
          name,
          id: c.id,
          here: when && (c.applicability?.(state).state ?? "here") === "here",
        });
        if (verdict.state !== "here")
          expect({ id: c.id, reason: typeof verdict.reason }).toEqual({
            id: c.id,
            reason: "string",
          });
      }
    }
  });

  test("Go to page needs a document", () => {
    const r = createCommandRegistry(() => STATES.noDocument);
    for (const c of buildAppCommands({} as never)) r.register(c);
    expect(r.applicability!(PAGED_VIEW_GO_TO_PAGE)).toEqual({
      state: "disabled",
      reason: "Open a document first.",
    });
  });
});
