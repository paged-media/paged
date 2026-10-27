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

// Extensions ADR 348 — the editing doors: C1 contribute.controlBarGroup,
// C2 the keybinding `scope`, C3 contribute.statusItem, C4 host.text's
// selection reads and format writes, and shell.setDocumentContext.

import { describe, expect, it } from "bun:test";

import type {
  ControlBarGroupContribution,
  EditContextContribution,
  PluginManifest,
  StatusItemContribution,
} from "@paged-media/plugin-api";

import {
  contextScopeActive,
  createBundleHost,
  isReservedHostKey,
  PluginCapabilityError,
} from "../src/host-impl";
import { contributeEditContext } from "../src/edit-context";
import {
  caretReadRange,
  contentToChar,
  wordAroundCaret,
} from "../src/text-selection";
import { makeFakeEditor } from "./fake-editor";
import { silentConsole as silent } from "../src/testing";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: {
    document: { read: "broad", write: "broad" },
    keybindings: true,
  },
  contributes: {
    editContexts: [{ type: "wordDocument", entry: "doubleClick" }],
  },
} as PluginManifest;

const wordContext: EditContextContribution = {
  type: "wordDocument",
  entry: "doubleClick",
  matches: () => true,
};

function withRegistries() {
  const fake = makeFakeEditor();
  const groups: ControlBarGroupContribution[] = [];
  const items: StatusItemContribution[] = [];
  const regs = fake.editor.registries as unknown as Record<string, unknown>;
  const recording = <T>(into: T[]) => ({
    register(c: T) {
      into.push(c);
      return {
        dispose() {
          into.splice(into.indexOf(c), 1);
        },
      };
    },
  });
  regs.controlBarGroups = recording(groups);
  regs.statusItems = recording(items);
  return { fake, groups, items };
}

const group: ControlBarGroupContribution = {
  id: "media.paged.test.home",
  title: "Home",
  scope: { editContext: "wordDocument" },
  render: () => null,
};
const item: StatusItemContribution = {
  id: "media.paged.test.words",
  scope: { editContext: "wordDocument" },
  render: () => null,
};

describe("contribute.controlBarGroup / statusItem (C1, C3)", () => {
  it("register through the host registries once the context is registered", () => {
    const { fake, groups, items } = withRegistries();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("contribute.controlBarGroup@1")).toBe(true);
    expect(host.supports("controlBar.groups@1")).toBe(true);
    expect(host.supports("statusBar.items@1")).toBe(true);
    contributeEditContext(host, wordContext);
    const g = host.contribute.controlBarGroup(group);
    const s = host.contribute.statusItem(item);
    expect(groups).toEqual([group]);
    expect(items).toEqual([item]);
    g.dispose();
    s.dispose();
    expect(groups).toEqual([]);
    expect(items).toEqual([]);
  });

  it("refuse an unregistered context, an undeclared one and a foreign id", () => {
    const { fake } = withRegistries();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(() => host.contribute.controlBarGroup(group)).toThrow(
      /no such edit context/,
    );
    contributeEditContext(host, wordContext);
    expect(() =>
      host.contribute.statusItem({ ...item, id: "media.other.words" }),
    ).toThrow();
    const { host: bare } = createBundleHost(
      () => fake.editor,
      { ...MANIFEST, contributes: {} },
      { console: silent },
    );
    expect(() => bare.contribute.statusItem(item)).toThrow(
      PluginCapabilityError,
    );
  });

  it("without registries they register nothing and the probes say so", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("controlBar.groups@1")).toBe(false);
    expect(host.supports("statusBar.items@1")).toBe(false);
    contributeEditContext(host, wordContext);
    expect(() =>
      host.contribute.controlBarGroup(group).dispose(),
    ).not.toThrow();
  });
});

describe("keybinding scope (C2)", () => {
  it("passes a scoped binding to the host and refuses reserved keys", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("contribute.keybinding.scope@1")).toBe(true);
    contributeEditContext(host, wordContext);
    host.contribute.keybinding({
      key: "cmd+b",
      command: "media.paged.test.bold",
      scope: { editContext: "wordDocument" },
    });
    expect(fake.keybindings.last()).toMatchObject({
      key: "cmd+b",
      scope: { editContext: "wordDocument" },
    });
    for (const key of ["cmd+s", "cmd+p", "cmd+\\", "shift+cmd+p", "meta+s"]) {
      expect(() =>
        host.contribute.keybinding({
          key,
          command: "media.paged.test.x",
          scope: { editContext: "wordDocument" },
        }),
      ).toThrow(/reserved/);
    }
    // An unscoped binding on a reserved key is the host's business.
    expect(() =>
      host.contribute.keybinding({
        key: "cmd+s",
        command: "media.paged.test.x",
      }),
    ).not.toThrow();
  });

  it("refuses a scope naming a context the bundle did not register", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(() =>
      host.contribute.keybinding({
        key: "cmd+b",
        command: "media.paged.test.bold",
        scope: { editContext: "wordDocument" },
      }),
    ).toThrow(/no such edit context/);
  });

  it("isReservedHostKey ignores modifier order and spelling", () => {
    expect(isReservedHostKey("shift+cmd+p")).toBe(true);
    expect(isReservedHostKey("ctrl+s")).toBe(true);
    expect(isReservedHostKey("cmd+b")).toBe(false);
    expect(isReservedHostKey("cmd+shift+s")).toBe(false);
  });

  it("contextScopeActive: the frame context first, else the document context", () => {
    expect(contextScopeActive({ editContext: { type: "a" } }, "a")).toBe(true);
    expect(
      contextScopeActive(
        { editContext: { type: "sheet" }, documentContext: "a" },
        "a",
      ),
    ).toBe(false);
    expect(
      contextScopeActive({ editContext: null, documentContext: "a" }, "a"),
    ).toBe(true);
    expect(contextScopeActive(null, "a")).toBe(false);
  });
});

describe("shell.setDocumentContext", () => {
  it("holds the document context for this bundle and drops it on dispose", () => {
    const fake = makeFakeEditor();
    const calls: Array<[string, string | null]> = [];
    const handle = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      documentContext: {
        set(pluginId, type) {
          calls.push([pluginId, type]);
          return true;
        },
      },
    });
    const { host } = handle;
    expect(host.supports("shell.documentContext@1")).toBe(true);
    expect(() => host.shell.setDocumentContext("wordDocument")).toThrow();
    contributeEditContext(host, wordContext);
    expect(host.shell.setDocumentContext("wordDocument")).toBe(true);
    handle.dispose();
    expect(calls).toEqual([
      ["media.paged.test", "wordDocument"],
      ["media.paged.test", null],
    ]);
  });

  it("answers false without a backend", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeEditContext(host, wordContext);
    expect(host.supports("shell.documentContext@1")).toBe(false);
    expect(host.shell.setDocumentContext("wordDocument")).toBe(false);
  });
});

describe("offsets: content → character (C4)", () => {
  const paras = ["Hello wörld", "", "second para"];
  it("drops the synthetic paragraph separators and counts bytes as characters", () => {
    // "Hello wörld" is 12 bytes (ö is two), 11 characters.
    expect(contentToChar(paras, 0)).toBe(0);
    expect(contentToChar(paras, 8)).toBe(7); // after "ö"
    expect(contentToChar(paras, 12)).toBe(11);
    // the empty paragraph sits at content 13, the third starts at 14
    expect(contentToChar(paras, 13)).toBe(11);
    expect(contentToChar(paras, 14)).toBe(11);
    expect(contentToChar(paras, 20)).toBe(17); // "second" read
  });
  it("finds the word around a caret, or none between words", () => {
    expect(wordAroundCaret(paras, 2)).toEqual([0, 5]); // He|llo
    expect(wordAroundCaret(paras, 5)).toEqual([0, 5]); // Hello|
    expect(wordAroundCaret(paras, 16)).toEqual([11, 17]); // se|cond
    expect(wordAroundCaret(["a  b"], 2)).toBeNull();
  });
  it("reads the character before a caret, after it at a paragraph start", () => {
    expect(caretReadRange(paras, 3)).toEqual([2, 3]);
    expect(caretReadRange(paras, 14)).toEqual([11, 12]);
    expect(caretReadRange(paras, 13)).toEqual([11, 11]);
  });
});

describe("host.text selection doors (C4)", () => {
  function textHost(
    sel: { storyId: string; start: number; end: number } | null,
  ) {
    const fake = makeFakeEditor();
    fake.onSend("requestStoryContent", () => ({
      kind: "storyContentResult",
      payload: {
        content: {
          selfId: "u1",
          paragraphs: [
            { runs: [{ text: "One two" }] },
            { runs: [{ text: "three" }] },
          ],
        },
      },
    }));
    const gets: Array<{ address: string; path: string }> = [];
    fake.onSend("requestGet", (p) => {
      const q = p as { address: string; path: string };
      gets.push(q);
      return {
        kind: "propertyValue",
        payload:
          q.path === "characterFontStyle"
            ? { value: null, error: null, mixed: true }
            : { value: { type: "enum", value: "CenterAlign" }, error: null },
      };
    });
    let current = sel;
    const listeners = new Set<() => void>();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      textSelection: {
        read: () => current,
        subscribe(l) {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
    });
    const move = (s: typeof sel) => {
      current = s;
      for (const l of listeners) l();
    };
    return { fake, host, gets, move };
  }

  it("reads effective values in character offsets, mixed included", async () => {
    // "One two\nthree": content 8..13 is "three" = characters 7..12.
    const { host, gets } = textHost({ storyId: "u1", start: 8, end: 13 });
    expect(host.supports("text.selection@1")).toBe(true);
    const props = await host.text.properties([
      "paragraphJustification",
      "characterFontStyle",
    ]);
    expect(props).toEqual({
      paragraphJustification: { value: "CenterAlign" },
      characterFontStyle: "mixed",
    });
    expect(gets[0]!.address).toBe("storyRange:u1@7..12");
  });

  it("formats in one batch: characters on the range, paragraphs on the paragraphs", async () => {
    const { fake, host } = textHost({ storyId: "u1", start: 8, end: 13 });
    const r = await host.text.format([
      { path: "characterFontStyle", value: { type: "text", value: "Bold" } },
      {
        path: "paragraphJustification",
        value: { type: "enum", value: "CenterAlign" },
      },
    ]);
    expect(r.applied).toBe(true);
    const m = fake.mutations.at(-1) as {
      op: string;
      args: { ops: Array<{ args: { elementId: { id: unknown } } }> };
    };
    expect(m.op).toBe("batch");
    expect(m.args.ops.map((o) => o.args.elementId.id)).toEqual([
      { story_id: "u1", start: 7, end: 12 },
      { story_id: "u1", start: 7, end: 12 },
    ]);
  });

  it("formats the word around a collapsed caret, and refuses between words", async () => {
    const { fake, host, move } = textHost({ storyId: "u1", start: 5, end: 5 });
    expect(
      (
        await host.text.format([
          { path: "characterUnderline", value: { type: "bool", value: true } },
        ])
      ).applied,
    ).toBe(true);
    expect(
      (fake.mutations.at(-1) as { args: { elementId: { id: unknown } } }).args
        .elementId.id,
    ).toEqual({ story_id: "u1", start: 4, end: 7 });
    move({ storyId: "u1", start: 3, end: 3 });
    // "One| two": the end of "One" is still a word's end.
    expect(
      (
        await host.text.format([
          { path: "characterUnderline", value: { type: "bool", value: true } },
        ])
      ).applied,
    ).toBe(true);
  });

  it("applies a paragraph style to the caret's paragraph", async () => {
    const { fake, host } = textHost({ storyId: "u1", start: 10, end: 10 });
    expect(
      (await host.text.applyStyle("paragraph", "ParagraphStyle/Heading 1"))
        .applied,
    ).toBe(true);
    expect(fake.mutations.at(-1)).toEqual({
      op: "setElementProperty",
      args: {
        elementId: {
          kind: "storyRange",
          id: { story_id: "u1", start: 9, end: 9 },
        },
        path: "appliedParagraphStyle",
        value: { type: "text", value: "ParagraphStyle/Heading 1" },
      },
    });
  });

  it("notifies selection changes, and answers null / not applied without a selection", async () => {
    const { host, move } = textHost(null);
    let n = 0;
    host.text.onDidChangeSelection(() => n++);
    expect(host.text.selection()).toBeNull();
    expect(await host.text.properties(["characterFontSize"])).toBeNull();
    expect((await host.text.format([])).applied).toBe(false);
    move({ storyId: "u1", start: 0, end: 3 });
    expect(n).toBe(1);
    expect(host.text.selection()).toEqual({ storyId: "u1", start: 0, end: 3 });
  });

  it("without a reader the doors exist and the probes are false", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("text.selection@1")).toBe(false);
    expect(host.supports("text.format@1")).toBe(false);
    expect(host.text.selection()).toBeNull();
  });
});

describe("the headless harness fakes the editing doors", () => {
  it("records groups and status items, plays the caret and drops the document context on load", async () => {
    const { createHeadlessHost } = await import("../src/harness");
    const { defineBundle } = await import("../src/define-bundle");
    const { minimalIdml } = await import("./fixtures/minimal-idml");
    const live = await createHeadlessHost({ console: silent });
    try {
      let seen = 0;
      live.loadBundle(
        defineBundle({
          manifest: MANIFEST,
          activate(h) {
            expect(h.supports("controlBar.groups@1")).toBe(true);
            expect(h.supports("statusBar.items@1")).toBe(true);
            expect(h.supports("text.selection@1")).toBe(true);
            expect(h.supports("shell.documentContext@1")).toBe(true);
            contributeEditContext(h, wordContext);
            h.contribute.controlBarGroup(group);
            h.contribute.statusItem(item);
            h.text.onDidChangeSelection(() => seen++);
            h.shell.setDocumentContext("wordDocument");
            return { dispose() {} };
          },
        }),
      );
      expect(live.controlBarGroupsContributed()).toEqual([group]);
      expect(live.statusItemsContributed()).toEqual([item]);
      expect(live.documentContext()).toEqual({
        pluginId: "media.paged.test",
        type: "wordDocument",
      });
      live.setTextSelection({ storyId: "u1", start: 1, end: 2 });
      expect(seen).toBe(1);
      expect(live.host.text.selection()).toEqual({
        storyId: "u1",
        start: 1,
        end: 2,
      });
      await live.load(minimalIdml());
      expect(live.documentContext()).toBeNull();
    } finally {
      live.dispose();
    }
  });
});

describe("host.text format extent", () => {
  it("a character path with extent paragraphs covers the touched paragraphs whole", async () => {
    const fake = makeFakeEditor();
    fake.onSend("requestStoryContent", () => ({
      kind: "storyContentResult",
      payload: {
        content: {
          selfId: "u1",
          paragraphs: [
            { runs: [{ text: "One two" }] },
            { runs: [{ text: "three" }] },
          ],
        },
      },
    }));
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      textSelection: {
        read: () => ({ storyId: "u1", start: 2, end: 2 }),
        subscribe: () => () => {},
      },
    });
    await host.text.format([
      {
        path: "characterLeading",
        value: { type: "length", value: 18 },
        extent: "paragraphs",
      },
    ]);
    expect(
      (fake.mutations.at(-1) as { args: { elementId: { id: unknown } } }).args
        .elementId.id,
    ).toEqual({ story_id: "u1", start: 0, end: 7 });
  });
});

describe("host.text find, replace and the character range (amendment 1)", () => {
  const HIT = {
    storyId: "u1",
    start: 8,
    end: 13,
    charStart: 7,
    charEnd: 12,
    paragraph: 1,
    text: "three",
    context: "three",
    contextOffset: 0,
    groups: [],
  };
  function findHost(sel: { storyId: string; start: number; end: number }) {
    const fake = makeFakeEditor();
    fake.onSend("requestStoryContent", () => ({
      kind: "storyContentResult",
      payload: {
        content: {
          selfId: "u1",
          paragraphs: [
            { runs: [{ text: "One two" }] },
            { runs: [{ text: "three" }] },
          ],
        },
      },
    }));
    fake.onSend("requestFindText", (p) => {
      const { spec } = p as { spec: { find: string } };
      if (spec.find === "(") {
        return { kind: "foundText", payload: { hits: [], error: "bad" } };
      }
      return {
        kind: "foundText",
        payload: { hits: spec.find === "three" ? [HIT, HIT] : [] },
      };
    });
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      textSelection: { read: () => sel, subscribe: () => () => {} },
    });
    return { fake, host };
  }

  it("finds through RequestFindText with the wire spec, hits in both offsets", async () => {
    const { fake, host } = findHost({ storyId: "u1", start: 0, end: 0 });
    expect(host.supports("text.find@1")).toBe(true);
    const r = await host.text.find({
      find: "three",
      matchCase: true,
      mode: "wildcards",
      storyId: "u1",
      paragraphStyle: "ParagraphStyle/Body",
    });
    expect(r.error).toBeUndefined();
    expect(r.hits).toHaveLength(2);
    expect(r.hits[0]).toEqual({
      storyId: "u1",
      start: 8,
      end: 13,
      charStart: 7,
      charEnd: 12,
      paragraph: 1,
      text: "three",
      context: "three",
      contextOffset: 0,
    });
    expect(fake.sent.at(-1)).toEqual({
      kind: "requestFindText",
      payload: {
        spec: {
          find: "three",
          storyId: "u1",
          mode: "wildcards",
          matchCase: true,
          paragraphStyle: "ParagraphStyle/Body",
        },
      },
    });
    expect((await host.text.find({ find: "(" })).error).toBe("bad");
    expect(await host.text.find({ find: "" })).toEqual({ hits: [] });
  });

  it("replaces in ONE findReplace mutation and counts the hits", async () => {
    const { fake, host } = findHost({ storyId: "u1", start: 0, end: 0 });
    const all = await host.text.replace({
      find: "three",
      replace: "3",
      all: true,
      replaceCharacterStyle: "CharacterStyle/Em",
    });
    expect(all).toEqual({ applied: true, replaced: 2 });
    expect(fake.mutations.at(-1)).toEqual({
      op: "findReplace",
      args: {
        spec: { find: "three" },
        replace: "3",
        replaceAll: true,
        characterStyle: "CharacterStyle/Em",
      },
    });
    expect(await host.text.replace({ find: "three", replace: "3" })).toEqual({
      applied: true,
      replaced: 1,
    });
    const n = fake.mutations.length;
    const none = await host.text.replace({ find: "four", replace: "4" });
    expect(none.applied).toBe(false);
    expect(none.replaced).toBe(0);
    // Nothing matching sends no mutation: no empty undo step.
    expect(fake.mutations).toHaveLength(n);
  });

  it("answers the selection in story characters", async () => {
    const { host } = findHost({ storyId: "u1", start: 8, end: 13 });
    expect(await host.text.characterRange()).toEqual({
      storyId: "u1",
      start: 7,
      end: 12,
    });
  });

  it("openPanel hands the target to the host's shell", () => {
    const fake = makeFakeEditor();
    const opened: unknown[][] = [];
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      shell: {
        openPanel: (...args: unknown[]) => void opened.push(args),
        closePanel: () => {},
        pickFile: async () => [],
      },
    });
    host.shell.openPanel("paged.style-options", {
      target: "style:paragraph/ParagraphStyle/Body",
    });
    host.shell.openPanel("paged.layers");
    expect(opened).toEqual([
      [
        "paged.style-options",
        { target: "style:paragraph/ParagraphStyle/Body" },
      ],
      ["paged.layers"],
    ]);
  });
});
