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

// SH-201 (UX audit F-28, ADR 231): Cut, Copy, Paste, Paste in place and
// Duplicate for page items, against the real engine, through the keys the
// keybinding registry resolves. What is pinned: a copy pastes whole (a
// group with its members) at the centre of the view, selected, in one undo
// step; Cut then Paste in place puts the item back where it was; Duplicate
// steps 12 pt right and down; a copy pastes into another document; text
// from another application becomes a new text frame; with a caret the keys
// are the text's; a browser that refuses the clipboard still pastes our own
// copy.

import { afterEach, describe, expect, test } from "bun:test";

import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";
import { dumpDiff } from "@paged-media/test-kit/headless";

import { pageItemClipboard } from "../../src/clipboard-commands";
import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  pageItemClipboard.set(null);
  await ed?.dispose();
  ed = null;
});

const targets = async () =>
  (ed = await createHeadlessEditor({ idml: gestureFixture("targets") }));

/** A key press runs its command without awaiting it: let it finish. */
async function settle(e: HeadlessEditor): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await e.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** The document's element keys of one kind (`group:…`, `rectangle:…`). */
async function keysOf(e: HeadlessEditor, kind: string): Promise<string[]> {
  return Object.keys((await e.dump()).elements).filter((k) =>
    k.startsWith(`${kind}:`),
  );
}

async function box(
  e: HeadlessEditor,
  id: unknown,
): Promise<[number, number, number, number]> {
  const [g] = await e.client.elementGeometry([id as never]);
  // `bounds` are the inner box; the item transform places it on the page.
  const { bounds: b, itemTransform: m } = g as unknown as {
    bounds: [number, number, number, number];
    itemTransform: [number, number, number, number, number, number] | null;
  };
  const t = m ?? [1, 0, 0, 1, 0, 0];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [b[1], b[0]],
    [b[3], b[0]],
    [b[1], b[2]],
    [b[3], b[2]],
  ]) {
    xs.push(t[0] * x + t[2] * y + t[4]);
    ys.push(t[1] * x + t[3] * y + t[5]);
  }
  return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
}

describe("SH-201 (UX audit F-28): the page-item clipboard", () => {
  test("Cmd+C, Cmd+V: a whole copy of a group at the centre of the view, selected, one undo step", async () => {
    covers("command:paged.edit.copy", "command:paged.edit.paste");
    const e = await targets();
    await e.select([T.group.id]);
    const before = await e.dump();
    const groups = await keysOf(e, "group");
    expect(await e.press("cmd+c")).toBe(true);
    await settle(e);
    expect(pageItemClipboard.current()?.count).toBe(1);
    expect(e.hostApp.systemClipboard.html).toContain("data-paged-clip");
    expect(await e.press("cmd+v")).toBe(true);
    await settle(e);
    const after = await keysOf(e, "group");
    expect(after.length).toBe(groups.length + 1);
    const pasted = e.state.selection.elementSelection;
    expect(pasted).toHaveLength(1);
    expect(pasted[0].kind).toBe("group");
    expect(JSON.stringify(pasted[0])).not.toBe(JSON.stringify(T.group.id));
    // Its members came along (two more leaves).
    expect(Object.keys((await e.dump()).elements).length).toBe(
      Object.keys(before.elements).length + 3,
    );
    // At the centre of the view (the headless camera: scale 1, 1200 × 800).
    const b = await box(e, pasted[0]);
    expect((b[1] + b[3]) / 2).toBeCloseTo(600, 0);
    expect((b[0] + b[2]) / 2).toBeCloseTo(400, 0);
    expect(e.problems()).toEqual([]);
    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("Cut, then Paste in place: the frame comes back where it was", async () => {
    covers("command:paged.edit.cut", "command:paged.edit.pasteInPlace");
    const e = await targets();
    await e.select([T.frame.id]);
    const where = await box(e, T.frame.id);
    expect(await e.press("cmd+x")).toBe(true);
    await settle(e);
    expect(await keysOf(e, "rectangle")).not.toContain("rectangle:uframe");
    await e.select([]);
    expect(await e.press("cmd+alt+shift+v")).toBe(true);
    await settle(e);
    const [pasted] = e.state.selection.elementSelection;
    expect(pasted.kind).toBe("rectangle");
    const now = await box(e, pasted);
    for (let i = 0; i < 4; i++) expect(now[i]).toBeCloseTo(where[i], 2);
  });

  test("Duplicate (Alt+Shift+Cmd+D) steps 12 pt right and down, one undo step", async () => {
    covers("command:paged.edit.duplicate");
    const e = await targets();
    await e.select([T.frame.id]);
    const before = await e.dump();
    const src = await box(e, T.frame.id);
    expect(await e.press("cmd+alt+shift+d")).toBe(true);
    await settle(e);
    const [copy] = e.state.selection.elementSelection;
    expect(JSON.stringify(copy)).not.toBe(JSON.stringify(T.frame.id));
    const b = await box(e, copy);
    expect(b[0] - src[0]).toBeCloseTo(12, 2);
    expect(b[1] - src[1]).toBeCloseTo(12, 2);
    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("a copy pastes into the next document opened", async () => {
    covers("command:paged.edit.paste");
    const e = await targets();
    await e.select([T.group.id]);
    await e.invoke("paged.edit.copy");
    await e.load(gestureFixture("paths"));
    const groups = await keysOf(e, "group");
    await e.invoke("paged.edit.paste");
    await e.idle();
    expect((await keysOf(e, "group")).length).toBe(groups.length + 1);
  });

  test("text copied in another application pastes as a new text frame", async () => {
    covers("command:paged.edit.paste");
    const e = await targets();
    await e.select([T.frame.id]);
    await e.invoke("paged.edit.copy");
    // Something else was copied since: the clipboard's text wins.
    e.hostApp.systemClipboard.text = "Hello from elsewhere";
    e.hostApp.systemClipboard.html = "";
    const frames = await keysOf(e, "textFrame");
    await e.invoke("paged.edit.paste");
    await e.idle();
    expect((await keysOf(e, "textFrame")).length).toBe(frames.length + 1);
    const dump = JSON.stringify(await e.dump());
    expect(dump).toContain("Hello from elsewhere");
  });

  test("a browser that refuses the clipboard still pastes our own copy", async () => {
    covers("command:paged.edit.paste");
    const e = await targets();
    e.hostApp.systemClipboard.denied = true;
    await e.select([T.frame.id]);
    await e.invoke("paged.edit.copy");
    const rects = await keysOf(e, "rectangle");
    await e.invoke("paged.edit.paste");
    await e.idle();
    expect((await keysOf(e, "rectangle")).length).toBe(rects.length + 1);
  });

  test("nothing selected: Copy does not apply; with a caret the keys are the text's", async () => {
    covers("command:paged.edit.copy");
    const e = await targets();
    await e.select([]);
    expect(await e.press("cmd+c")).toBe(false);
    e.state.contentSelection.setContentSelection({
      storyId: "u1",
      start: 0,
      end: 1,
      affinity: false,
    } as never);
    expect(await e.press("cmd+v")).toBe(false);
  });
});
