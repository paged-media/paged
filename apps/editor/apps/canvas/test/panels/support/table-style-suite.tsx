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

// Cell Styles and Table Styles share one shape: a read-only list of the
// family's styles with the applied select as a disabled seam (applying
// lives in the Table panel), an "Options…" per row, Delete per row
// through the typed core command, and New through the typed core command
// form. Each panel's file calls this with its family and a `tag` holding
// its literal `covers()` (the panel and the two core commands).

import { describe, expect, test } from "bun:test";
import type { ComponentType } from "react";

import type { CollectionName } from "@paged-media/client";
import { cockpitActions } from "@paged-media/shell";

import { CoreCommandDialog } from "../../../src/core-command-dialog";
import { StyleOptionsPanel } from "../../../src/panels/style-options-panel";
import { richScene, type RichScene } from "../fixtures";
import { mountPanel, type PanelHarness } from "../harness";
import { applySelect, rowsByName, runCoreCommand } from "./styles";

type H = PanelHarness<RichScene>;

export interface TableStyleCase {
  panel: ComponentType;
  id: string;
  family: "cell" | "table";
  collection: CollectionName;
  createOp: string;
  deleteOp: string;
  /** The default name the New form carries. */
  newName: string;
  /** The empty-list hook (`data-empty-cell-styles`). */
  emptyHook: string;
  styleOf: (s: RichScene) => string;
  /** The panel's covers() (panel id). */
  tag: () => void;
  /** The create command's covers(). */
  tagCreate: () => void;
  /** The delete command's covers(). */
  tagDelete: () => void;
}

export function tableStyleSuite(c: TableStyleCase): void {
  /** The panel with the typed command form beside it, as the app has it
   *  (main.tsx mounts CoreCommandDialog once, at the root). */
  const WithForm = () => (
    <>
      <c.panel />
      <CoreCommandDialog />
    </>
  );
  const mount = () =>
    mountPanel(WithForm as ComponentType<never>, {
      id: c.id,
      scene: richScene,
    });
  const row = (h: H, selfId: string) =>
    h.root.querySelector<HTMLElement>(
      `[data-style-id="${CSS.escape(selfId)}"]`,
    );

  describe(`${c.id}: states`, () => {
    test("no document, and a blank one: the list is empty and says so", async () => {
      c.tag();
      for (const document of ["none", "blank"] as const) {
        const h = await mountPanel(c.panel as ComponentType<never>, {
          id: c.id,
          document,
        });
        expect(h.root.querySelector(`[${c.emptyHook}]`)).not.toBeNull();
        expect(h.root.querySelectorAll("[data-style-id]")).toHaveLength(0);
        h.unmount();
      }
    });

    test("the document's styles are listed by name", async () => {
      c.tag();
      const h = await mount();
      const style = c.styleOf(h.scene);
      const name = (await h.client.collection(c.collection)) as Array<{
        selfId: string;
        name: string;
      }>;
      expect(
        [...h.root.querySelectorAll("[data-style-id]")].map((r) =>
          r.getAttribute("data-style-id"),
        ),
      ).toEqual(name.map((r) => r.selfId));
      expect(row(h, style)?.textContent).toContain(
        name.find((r) => r.selfId === style)!.name,
      );
    });

    test("the applied select is a disabled seam that sends nothing (apply lives in the Table panel)", async () => {
      c.tag();
      const h = await mount();
      await h.select([h.scene.tableFrame]);
      const select = applySelect(h);
      expect(select.disabled).toBe(true);
      const from = h.mark();
      await h.user.click(select);
      await h.settle();
      expect(h.mutations(from)).toEqual([]);
    });
  });

  describe(`${c.id}: controls`, () => {
    test("Delete removes the row's style through the typed core command", async () => {
      c.tag();
      c.tagDelete();
      const h = await mount();
      const style = c.styleOf(h.scene);
      const from = h.mark();
      await h.click(
        row(h, style)!.querySelector(
          `[data-core-command-button="${c.deleteOp}"]`,
        )!,
      );
      expect(h.mutations(from)).toEqual([
        { op: c.deleteOp, args: { styleId: style } },
      ] as never);
      expect([...(await rowsByName(h, c.collection)).values()]).not.toContain(
        style,
      );
      expect(row(h, style)).toBeNull();
      expect(
        row(h, style)?.getAttribute("data-command-error") ?? null,
      ).toBeNull();
    });

    test("one undo brings the deleted style back", async () => {
      c.tag();
      c.tagDelete();
      const h = await mount();
      const style = c.styleOf(h.scene);
      await h.click(
        row(h, style)!.querySelector(
          `[data-core-command-button="${c.deleteOp}"]`,
        )!,
      );
      await h.act(() => h.client.undo());
      expect([...(await rowsByName(h, c.collection)).values()]).toContain(
        style,
      );
      expect(row(h, style)).not.toBeNull();
    });

    test("New opens the typed command form prefilled; Run creates the style and lists it", async () => {
      c.tag();
      c.tagCreate();
      const h = await mount();
      await h.click(
        h.root.querySelector(`[data-core-command-button="${c.createOp}"]`)!,
      );
      const form = h.root.querySelector("[data-core-command-dialog]");
      expect(form?.textContent).toContain(`core.${c.createOp}`);
      const from = h.mark();
      await runCoreCommand(h);
      const sent = h.mutations(from) as unknown as Array<{
        op: string;
        args: { selfId: string; name: string };
      }>;
      expect(sent).toHaveLength(1);
      expect(sent[0].op).toBe(c.createOp);
      expect(sent[0].args.name).toBe(c.newName);
      const created = sent[0].args.selfId;
      expect((await rowsByName(h, c.collection)).get(c.newName)).toBe(created);
      expect(row(h, created)?.textContent).toContain(c.newName);
      expect(h.root.querySelector("[data-core-command-dialog]")).toBeNull();
    });

    test("Options… brings up Style Options on that style", async () => {
      c.tag();
      const h = await mount();
      const style = c.styleOf(h.scene);
      h.registries.panels.register({
        id: "paged.style-options",
        title: "Style Options",
        component: StyleOptionsPanel,
      });
      await h.click(row(h, style)!.querySelector("[data-style-options-open]")!);
      expect(cockpitActions.activeTab?.()).toBe("paged.style-options");
      const options = await mountPanel(StyleOptionsPanel, {
        id: "paged.style-options",
        scene: richScene,
      });
      const panel = options.root.querySelector("[data-style-options-panel]");
      expect(panel?.getAttribute("data-style-family")).toBe(c.family);
      expect(panel?.getAttribute("data-style-target")).toContain(style);
    });
  });

  describe(`${c.id}: findings`, () => {
    // UX audit F-22: internal identifiers shown to users. The New form
    // is generated from the command's args, so it asks for a self id.
    test.failing(
      "PN-154 (UX F-22): the New form asks for a name, not for an internal self id",
      async () => {
        c.tag();
        const h = await mount();
        await h.click(
          h.root.querySelector(`[data-core-command-button="${c.createOp}"]`)!,
        );
        const args = [
          ...h.root.querySelectorAll("[data-core-command-arg]"),
        ].map((f) => f.getAttribute("data-core-command-arg"));
        expect(args).not.toContain("selfId");
      },
    );
  });
}
