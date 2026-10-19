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

// The headless editor's own contract (harness.ts): it boots on the real
// engine, opens a document, runs a command through the real registry, and
// every door it offers (commands, Boa scripts, editor.* automation, plugin
// hosts) reaches the SAME document — read back through the canonical model
// dump.

import { afterEach, describe, expect, test } from "bun:test";

import {
  covers,
  dumpDiff,
  elementKey,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";

import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

const FRAME = elementKey(T.frame.id);

describe("headless editor", () => {
  test("opens a document through the real client and dumps its model", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    expect(ed.state.document.handle?.pageIds).toEqual([
      T.pageId,
      T.secondPageId,
    ]);
    const dump = await ed.dump();
    expect(Object.keys(dump.elements)).toContain(FRAME);
    expect(dump.elements[elementKey(T.group.childA)]).not.toBeNull();
    expect((dump.collections.pages as unknown[]).length).toBe(2);
    // Byte-stable: two reads of one model are one string.
    expect(await ed.dumpJson()).toBe(await ed.dumpJson());
  });

  test("a command runs through the registry, and undo restores the model byte for byte", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const before = await ed.dump();
    await ed.select([T.frame.id]);
    await ed.invoke("paged.object.delete");
    await ed.idle();
    covers("command:paged.object.delete", "command:paged.editor.undo");
    expect(ed.problems()).toEqual([]);
    const after = await ed.dump();
    expect(Object.keys(after.elements)).not.toContain(FRAME);
    await ed.invoke("paged.editor.undo");
    await ed.idle();
    const undone = await ed.dump();
    expect(dumpDiff(before, undone)).toEqual([]);
  });

  test("every live menu item names a registered command", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const commands = new Set(ed.registries.commands.list().map((c) => c.id));
    const menus = ed.registries.menus.list();
    expect(menus.length).toBeGreaterThan(20);
    // Not headless: the `paged.panel.show.<id>` pairs derive from the panel
    // registry (no panels mount here), a seam item is disabled by design,
    // and Help ▸ About is a label.
    const live = menus.filter(
      (m) =>
        !m.disabled &&
        !m.command.startsWith("paged.panel.show.") &&
        m.command !== "paged.help.version",
    );
    expect(live.filter((m) => !commands.has(m.command))).toEqual([]);
    expect(commands.has("paged.object.group")).toBe(true);
    expect(commands.has("paged.insert.textFrame")).toBe(true);
    expect(commands.has("paged.edit.selectAll")).toBe(true);
  });

  test("a Boa script and editor.* automation reach the same document", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const pages = await ed.script("console.log(paged.pages())");
    covers("script:paged.pages");
    expect(pages.error).toBeNull();
    const parsed = JSON.parse(
      pages.output[0].replace(/^\[log\] /, ""),
    ) as Array<{
      selfId: string;
    }>;
    expect(parsed.map((p) => p.selfId)).toEqual([T.pageId, T.secondPageId]);

    const { editor } = ed.automation;
    await editor.select([T.frame.id, T.path.id]);
    covers("script:editor.select", "script:editor.runCommand");
    expect(ed.state.selection.elementSelection).toHaveLength(2);
    await editor.runCommand("paged.object.group");
    await ed.idle();
    expect(ed.problems()).toEqual([]);
    // A new group holds the two.
    const after = await ed.dump();
    const groups = Object.keys(after.elements).filter((k) =>
      k.startsWith("group:"),
    );
    expect(groups).toHaveLength(2);
  });

  test("a plugin host's document door writes the document the commands read", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const host = ed.host();
    const outcome = await host.document.mutate({
      op: "deleteFrame",
      args: { frameId: T.frame.id.id },
    } as never);
    expect((outcome as { applied?: boolean }).applied).toBe(true);
    expect(Object.keys((await ed.dump()).elements)).not.toContain(FRAME);
  });

  test("two editors share the wasm module, never a document", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const other = await createHeadlessEditor({ blank: [300, 300] });
    try {
      expect(other.state.document.handle?.pageCount).toBe(1);
      expect(ed.state.document.handle?.pageCount).toBe(2);
      expect(Object.keys((await other.dump()).elements)).not.toContain(FRAME);
    } finally {
      await other.dispose();
    }
  });
});
