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

// Editor ADR 1242 — the verbs every object answers: eight host commands in
// one order, applying on a selection or inside a context, each resolving to
// the module's command where the context names one that applies, else to
// the host's.

import { describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  VERB_MENU_ROWS,
  buildVerbCommands,
  resolveVerb,
  verbApplies,
} from "../../src/verb-commands";
import { CANVAS_CONTEXT_MENU } from "../../src/canvas-context-menu";

type Paged = Parameters<typeof resolveVerb>[0];

/** An editor handle inside `context` (or on the page), with the commands
 *  `have` and the ones of them that apply. */
function editor(
  context: string | null,
  verbs: Record<string, string>,
  have: string[],
  applying: string[] = have,
): Paged {
  return {
    editContext: context ? { type: context } : null,
    selection: { elementSelection: [{ kind: "rectangle", id: "u1abc" }] },
    registries: {
      commands: {
        get: (id: string) => (have.includes(id) ? { id } : undefined),
        invoke: async () => undefined,
        applicability: (id: string) => ({
          state: applying.includes(id) ? "here" : "disabled",
        }),
      },
      editContexts: {
        get: (t: string) => (t === context ? { verbs } : undefined),
      },
      objectTypes: { list: () => [] },
    },
  } as unknown as Paged;
}

describe("every object answers the same verbs [editor-shell.context-sensitivity]", () => {
  test("eight host commands, in one order, first in the context menu", () => {
    covers("command:paged.verb.inspect");
    covers("command:paged.verb.transform");
    covers("command:paged.verb.copy");
    covers("command:paged.verb.bindData");
    covers("command:paged.verb.style");
    covers("command:paged.verb.version");
    covers("command:paged.verb.validate");
    covers("command:paged.verb.export");
    const commands = buildVerbCommands();
    expect(commands.map((c) => c.id)).toEqual([
      "paged.verb.inspect",
      "paged.verb.transform",
      "paged.verb.copy",
      "paged.verb.bindData",
      "paged.verb.style",
      "paged.verb.version",
      "paged.verb.validate",
      "paged.verb.export",
    ]);
    expect(commands.map((c) => c.title)).toEqual([
      "Inspect",
      "Transform…",
      "Copy",
      "Bind to data…",
      "Style…",
      "Save a version",
      "Validate",
      "Export…",
    ]);
    expect(CANVAS_CONTEXT_MENU.slice(0, 8)).toEqual([...VERB_MENU_ROWS]);
  });

  test("they apply on a selection, a text selection or inside a context, and say why not", () => {
    covers("command:paged.verb.inspect");
    covers("command:paged.verb.transform");
    covers("command:paged.verb.copy");
    covers("command:paged.verb.bindData");
    covers("command:paged.verb.style");
    covers("command:paged.verb.version");
    covers("command:paged.verb.validate");
    covers("command:paged.verb.export");
    expect(verbApplies({ selection: { elementSelection: [{}] } })).toBe(true);
    expect(verbApplies({ contentSelection: { contentSelection: {} } })).toBe(
      true,
    );
    expect(verbApplies({ editContext: { type: "sheet" } })).toBe(true);
    expect(verbApplies({ selection: { elementSelection: [] } })).toBe(false);
    const [inspect] = buildVerbCommands();
    expect(inspect!.applicability!({})).toEqual({
      state: "disabled",
      reason: "Select an object first",
    });
  });

  test("the module's command where its context names one that applies; the host's otherwise", async () => {
    covers("command:paged.verb.inspect");
    covers("command:paged.verb.transform");
    covers("command:paged.verb.copy");
    covers("command:paged.verb.bindData");
    covers("command:paged.verb.style");
    covers("command:paged.verb.version");
    covers("command:paged.verb.validate");
    covers("command:paged.verb.export");
    const sheet = { copy: "m.sheet.copy", export: "m.sheet.csv" };
    const inSheet = editor("sheet", sheet, ["m.sheet.copy", "m.sheet.csv"]);
    expect(await resolveVerb(inSheet, "copy")).toEqual({
      via: "module",
      command: "m.sheet.copy",
      context: "sheet",
    });
    expect(await resolveVerb(inSheet, "inspect")).toEqual({ via: "host" });
    // A named command this editor lacks, or one that does not apply here,
    // falls back to the host's verb.
    expect(await resolveVerb(editor("sheet", sheet, []), "copy")).toEqual({
      via: "host",
    });
    expect(
      await resolveVerb(editor("sheet", sheet, ["m.sheet.copy"], []), "copy"),
    ).toEqual({ via: "host" });
    // On the page: the host's.
    expect(await resolveVerb(editor(null, {}, []), "export")).toEqual({
      via: "host",
    });
  });
});
