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

// Editor ADR 303 — the Find & Replace commands and keys on the headless
// editor (the real engine, the app's registrations): Find opens the
// results panel's search, Replace and Go To open their dialogs, Find next
// and previous walk the hits from the selection.

import { afterEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { findStoreOf, setFindOptions } from "../../src/find/find-state";
import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(() => {
  ed?.dispose();
  ed = null;
});

/** A blank page with one frame of "one two one" / "three one". */
async function withText(): Promise<{ e: HeadlessEditor; storyId: string }> {
  const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
  const pageId = e.state.document.handle!.pageIds[0];
  await e.client.mutate({
    op: "insertTextFrame",
    args: { pageId, bounds: [72, 72, 300, 400] },
  } as never);
  const stories = (await e.client.collection("stories")) as Array<{
    selfId: string;
  }>;
  const storyId = stories.at(-1)!.selfId;
  await e.client.mutate({
    op: "insertText",
    args: { storyId, offset: 0, text: "one two one\nthree one" },
  } as never);
  await e.idle();
  return { e, storyId };
}

const sel = (e: HeadlessEditor) =>
  e.editor.contentSelection.contentSelectionRef.current;

describe("Find & Replace commands (editor ADR 303)", () => {
  test("find, replace and go to open their surfaces; with no document they do not apply", async () => {
    covers("command:paged.edit.find");
    covers("command:paged.edit.replace");
    covers("command:paged.edit.goTo");
    const empty = (ed = await createHeadlessEditor());
    expect(await empty.invoke("paged.edit.replace")).toBeUndefined();
    expect(findStoreOf(empty.editor.scope).get().dialog).toBe(false);
    empty.dispose();

    const { e } = await withText();
    const store = findStoreOf(e.editor.scope);
    await e.invoke("paged.edit.find");
    expect(store.get().focusSearch).toBe(1);
    await e.invoke("paged.edit.replace");
    expect(store.get().dialog).toBe(true);
    await e.invoke("paged.edit.goTo");
    expect(store.get()).toMatchObject({ goTo: true, dialog: false });
  });

  test("find next and previous walk the hits from the selection and wrap", async () => {
    covers("command:paged.edit.findNext");
    covers("command:paged.edit.findPrevious");
    const { e, storyId } = await withText();
    setFindOptions(findStoreOf(e.editor.scope), { find: "one" });
    await e.invoke("paged.edit.findNext");
    expect(sel(e)).toMatchObject({ storyId, start: 0, end: 3 });
    await e.invoke("paged.edit.findNext");
    expect(sel(e)).toMatchObject({ start: 8, end: 11 });
    await e.invoke("paged.edit.findNext");
    // "three one": the paragraph starts at 12, "one" at 18.
    expect(sel(e)).toMatchObject({ start: 18, end: 21 });
    await e.invoke("paged.edit.findNext");
    expect(sel(e)).toMatchObject({ start: 0, end: 3 });
    await e.invoke("paged.edit.findPrevious");
    expect(sel(e)).toMatchObject({ start: 18, end: 21 });
  });

  test("the host's keys reach the commands", async () => {
    covers("keybinding:cmd+f→paged.edit.find");
    covers("keybinding:ctrl+f→paged.edit.find");
    covers("keybinding:cmd+alt+f→paged.edit.replace");
    covers("keybinding:ctrl+h→paged.edit.replace");
    covers("keybinding:cmd+j→paged.edit.goTo");
    const { e } = await withText();
    const store = findStoreOf(e.editor.scope);
    expect(await e.press("cmd+f")).toBe(true);
    expect(await e.press("ctrl+f")).toBe(true);
    expect(store.get().focusSearch).toBe(2);
    expect(await e.press("cmd+alt+f")).toBe(true);
    expect(store.get().dialog).toBe(true);
    await e.invoke("paged.edit.goTo");
    store.set({ ...store.get(), dialog: false, goTo: false });
    expect(await e.press("ctrl+h")).toBe(true);
    expect(store.get().dialog).toBe(true);
    expect(await e.press("cmd+j")).toBe(true);
    expect(store.get().goTo).toBe(true);
  });
});
