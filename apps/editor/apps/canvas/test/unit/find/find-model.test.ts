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

// Editor ADR 303 — the pure half of Find & Replace (find-model.ts) and the
// commands over a fake editor: the spec the options make, where Find next
// goes, a replacement's specials and groups, a hit's context, and what each
// command opens or selects.

import { describe, expect, test } from "bun:test";

import { createEditorScope } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  FIND_COMMANDS,
  FIND_KEYBINDINGS,
} from "../../../src/find/find-commands";
import {
  contextParts,
  DEFAULT_FIND_OPTIONS,
  findSpecOf,
  nextHitIndex,
  pageIndexOf,
  replacementFor,
} from "../../../src/find/find-model";
import { findStoreOf, setFindOptions } from "../../../src/find/find-state";

const hit = (storyId: string, start: number, end: number, text = "x") => ({
  storyId,
  start,
  end,
  charStart: start,
  charEnd: end,
  paragraph: 0,
  text,
  context: text,
  contextOffset: 0,
});

describe("find-model", () => {
  test("the spec carries only what differs from the wire defaults", () => {
    expect(findSpecOf({ ...DEFAULT_FIND_OPTIONS, find: "a" })).toEqual({
      find: "a",
    });
    expect(
      findSpecOf(
        {
          ...DEFAULT_FIND_OPTIONS,
          find: "a",
          mode: "wildcards",
          matchCase: true,
          wholeWord: true,
          paragraphStyle: "ParagraphStyle/H",
          characterStyle: "CharacterStyle/E",
          storyOnly: true,
        },
        "u1",
      ),
    ).toEqual({
      find: "a",
      mode: "wildcards",
      matchCase: true,
      wholeWord: true,
      paragraphStyle: "ParagraphStyle/H",
      characterStyle: "CharacterStyle/E",
      storyId: "u1",
    });
  });

  test("find next goes on from the selection, across stories, wrapping", () => {
    const hits = [hit("a", 0, 1), hit("a", 5, 6), hit("b", 2, 3)];
    expect(nextHitIndex(hits, null)).toBe(0);
    expect(nextHitIndex(hits, { storyId: "a", start: 0, end: 1 })).toBe(1);
    expect(nextHitIndex(hits, { storyId: "a", start: 5, end: 6 })).toBe(2);
    expect(nextHitIndex(hits, { storyId: "b", start: 2, end: 3 })).toBe(0);
    expect(nextHitIndex(hits, { storyId: "a", start: 3, end: 3 })).toBe(1);
    expect(nextHitIndex(hits, { storyId: "a", start: 5, end: 6 }, true)).toBe(
      0,
    );
    expect(nextHitIndex(hits, { storyId: "a", start: 0, end: 1 }, true)).toBe(
      2,
    );
    expect(nextHitIndex([], null)).toBe(-1);
  });

  test("a replacement spells Word's specials and the groups", () => {
    const h = { text: "cat", groups: ["c", "at"] };
    expect(replacementFor("^& and ^&", h, "literal")).toBe("cat and cat");
    expect(replacementFor("a^pb^tc^ld^^", h, "literal")).toBe(
      "a\nb\tc\u2028d^",
    );
    expect(replacementFor("$2-$1", h, "regex")).toBe("at-c");
    expect(replacementFor("\\2\\1", h, "wildcards")).toBe("atc");
    expect(replacementFor("$1", h, "literal")).toBe("$1");
    expect(replacementFor("x^m", h, "literal")).toBeNull();
  });

  test("a hit's context splits around the match, counting bytes", () => {
    expect(
      contextParts({ context: "Grüße an alle", contextOffset: 8, text: "an" }),
    ).toEqual({ before: "Grüße ", match: "an", after: " alle" });
  });

  test("Go To takes a page within the document", () => {
    expect(pageIndexOf("2", 3)).toBe(1);
    expect(pageIndexOf("0", 3)).toBeNull();
    expect(pageIndexOf("4", 3)).toBeNull();
    expect(pageIndexOf("x", 3)).toBeNull();
  });
});

describe("the Find & Replace commands", () => {
  const command = (id: string) => FIND_COMMANDS.find((c) => c.id === id)!;
  const withDoc = { document: { handle: { pageCount: 1 } } };

  test("apply with a document only, and open the panel, the dialog or Go To", async () => {
    covers("command:paged.edit.find");
    covers("command:paged.edit.replace");
    covers("command:paged.edit.goTo");
    for (const c of FIND_COMMANDS) {
      expect(c.when?.({ document: { handle: null } })).toBe(false);
      expect(c.when?.(withDoc)).toBe(true);
    }
    const scope = createEditorScope();
    const paged = { scope } as never;
    await command("paged.edit.find").handler(paged);
    expect(findStoreOf(scope).get().focusSearch).toBe(1);
    await command("paged.edit.replace").handler(paged);
    expect(findStoreOf(scope).get().dialog).toBe(true);
    await command("paged.edit.goTo").handler(paged);
    expect(findStoreOf(scope).get()).toMatchObject({
      goTo: true,
      dialog: false,
    });
  });

  test("find next / previous select the engine's hits", async () => {
    covers("command:paged.edit.findNext");
    covers("command:paged.edit.findPrevious");
    const scope = createEditorScope();
    let selection: unknown = null;
    const paged = {
      scope,
      client: {
        send: async () => ({
          kind: "foundText",
          payload: { hits: [hit("u", 0, 3, "one"), hit("u", 8, 11, "one")] },
        }),
      },
      contentSelection: {
        contentSelectionRef: {
          get current() {
            return selection;
          },
        },
        setContentSelection: (s: unknown) => (selection = s),
      },
    } as never;
    setFindOptions(findStoreOf(scope), { find: "one" });
    await command("paged.edit.findNext").handler(paged);
    expect(selection).toEqual({ storyId: "u", start: 0, end: 3 });
    await command("paged.edit.findNext").handler(paged);
    expect(selection).toEqual({ storyId: "u", start: 8, end: 11 });
    await command("paged.edit.findPrevious").handler(paged);
    expect(selection).toEqual({ storyId: "u", start: 0, end: 3 });
  });

  test("the keys name the commands", () => {
    expect(FIND_KEYBINDINGS.map((k) => `${k.key}→${k.command}`)).toEqual([
      "cmd+f→paged.edit.find",
      "ctrl+f→paged.edit.find",
      "cmd+alt+f→paged.edit.replace",
      "ctrl+h→paged.edit.replace",
      "cmd+j→paged.edit.goTo",
    ]);
  });
});
