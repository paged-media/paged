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

// The style-manager suite shared by Paragraph, Character and Object
// Styles: one surface (style-apply.tsx over the shell's ApplyList), three
// families. Each panel's own file calls it with its family and a `tag`
// that holds that file's literal `covers("panel:<id>")`, called in every
// test next to the assertions.

import { describe, expect, test } from "bun:test";
import type { ComponentType } from "react";

import type { CollectionName, ElementId } from "@paged-media/client";
import { cockpitActions } from "@paged-media/shell";

import { StyleOptionsPanel } from "../../../src/panels/style-options-panel";
import { richScene, type RichScene } from "../fixtures";
import { mountPanel, type PanelHarness } from "../harness";
import {
  applyAction,
  applyItem,
  appliedItem,
  applySelect,
  optionLabels,
  rowsByName,
} from "./styles";

type H = PanelHarness<RichScene>;

export interface StyleApplyCase {
  panel: ComponentType<never>;
  id: string;
  collection: CollectionName;
  /** The property the applied style is. */
  path: string;
  scope: "content" | "element";
  createOp: string;
  deleteOp: string;
  newName: string;
  /** The family's root style as the list shows it. */
  rootLabel: string;
  /** The scene's own style of this family. */
  styleOf: (s: RichScene) => string;
  /** The covers() call of the panel's file. */
  tag: () => void;
  /** The text range a text family's style is applied to (default: a
   *  caret at 8, inside "world"). */
  range?: readonly [number, number];
}

const addr = (id: ElementId) => `${id.kind}:${String(id.id)}`;

/** Put the panel's target in place: a caret (text families) or the
 *  rectangle (object styles). Returns the address the style is set on. */
async function target(c: StyleApplyCase, h: H): Promise<string> {
  if (c.scope === "content") {
    const [start, end] = c.range ?? [8, 8];
    await h.selectText(h.scene.storyId, start, end);
    return `storyRange:${h.scene.storyId}@${start}..${end}`;
  }
  await h.select([h.scene.rect]);
  return addr(h.scene.rect);
}

export function styleApplySuite(c: StyleApplyCase): void {
  const mount = () => mountPanel(c.panel, { id: c.id, scene: richScene });

  describe(`${c.id}: states`, () => {
    test("no document: an empty list, nothing to apply or delete", async () => {
      c.tag();
      const h = await mountPanel(c.panel, { id: c.id, document: "none" });
      expect(h.root.querySelectorAll("[data-apply-item]")).toHaveLength(0);
      expect(applySelect(h).disabled).toBe(true);
      expect(applyAction(h, "delete").disabled).toBe(true);
      expect(h.engine.errors).toEqual([]);
    });

    test("nothing selected: the styles are listed by display name, none can be applied", async () => {
      c.tag();
      const h = await mount();
      const labels = optionLabels(applySelect(h));
      expect(labels[0]).toBe("[None]");
      expect(labels).toContain(c.rootLabel);
      expect(labels.some((l) => l.startsWith("$ID/"))).toBe(false);
      expect(applySelect(h).disabled).toBe(true);
      for (const row of h.root.querySelectorAll<HTMLButtonElement>(
        "[data-apply-item]",
      )) {
        expect(row.disabled).toBe(true);
      }
      expect(applyAction(h, "new").disabled).toBe(false);
      expect(applyAction(h, "delete").disabled).toBe(true);
    });

    test("with a target: the rows apply, and the applied style is marked", async () => {
      c.tag();
      const h = await mount();
      await target(c, h);
      expect(applySelect(h).disabled).toBe(false);
      expect(applyItem(h, c.styleOf(h.scene)).disabled).toBe(false);
      expect(appliedItem(h)).toBe(applySelect(h).value || null);
    });
  });

  describe(`${c.id}: controls`, () => {
    test("a style row applies the style: one set on the target, read back, marked applied", async () => {
      c.tag();
      const h = await mount();
      const address = await target(c, h);
      const style = c.styleOf(h.scene);
      const from = h.mark();
      await h.click(applyItem(h, style));
      expect(h.mutations(from)).toEqual([
        {
          op: "set",
          args: {
            address,
            path: c.path,
            value: { type: "text", value: style },
          },
        },
      ] as never);
      expect(await h.get(address, c.path)).toEqual({
        type: "text",
        value: style,
      });
      expect(appliedItem(h)).toBe(style);
      expect(applySelect(h).value).toBe(style);
    });

    test("the applied select applies the chosen style the same way", async () => {
      c.tag();
      const h = await mount();
      const address = await target(c, h);
      const style = c.styleOf(h.scene);
      const from = h.mark();
      await h.choose(applySelect(h), style);
      expect(h.mutations(from)).toEqual([
        {
          op: "set",
          args: {
            address,
            path: c.path,
            value: { type: "text", value: style },
          },
        },
      ] as never);
      expect(appliedItem(h)).toBe(style);
    });

    test("one undo takes the applied style back", async () => {
      c.tag();
      const h = await mount();
      const address = await target(c, h);
      const before = await h.get(address, c.path);
      await h.click(applyItem(h, c.styleOf(h.scene)));
      await h.act(() => h.client.undo());
      expect(await h.get(address, c.path)).toEqual(before);
    });

    test("New creates a style with the family's default name and lists it", async () => {
      c.tag();
      const h = await mount();
      const from = h.mark();
      await h.click(applyAction(h, "new"));
      expect(h.mutations(from)).toEqual([
        { op: c.createOp, args: { name: c.newName } },
      ] as never);
      const rows = await rowsByName(h, c.collection);
      const created = rows.get(c.newName);
      expect(created).toBeDefined();
      expect(applyItem(h, created!).textContent).toContain(c.newName);
    });

    test("Delete removes the applied style from the document and the list", async () => {
      c.tag();
      const h = await mount();
      await target(c, h);
      const style = c.styleOf(h.scene);
      await h.click(applyItem(h, style));
      const from = h.mark();
      await h.click(applyAction(h, "delete"));
      expect(h.mutations(from)).toEqual([
        { op: c.deleteOp, args: { styleId: style } },
      ] as never);
      const rows = await rowsByName(h, c.collection);
      expect([...rows.values()]).not.toContain(style);
      expect(
        h.root.querySelector(`[data-apply-item="${CSS.escape(style)}"]`),
      ).toBeNull();
    });

    test("Redefine and Clear override are disabled seams that send nothing", async () => {
      c.tag();
      const h = await mount();
      await target(c, h);
      for (const action of ["redefine", "clear-override"]) {
        const btn = applyAction(h, action);
        expect(btn.disabled).toBe(true);
        const from = h.mark();
        await h.click(btn);
        expect(h.mutations(from)).toEqual([]);
      }
    });

    test("Style Options… brings up the Style Options panel on the applied style", async () => {
      c.tag();
      const h = await mount();
      await target(c, h);
      const style = c.styleOf(h.scene);
      await h.click(applyItem(h, style));
      const button = h.root.querySelector<HTMLButtonElement>(
        '[data-cockpit-action$="-options"]',
      )!;
      expect(button.disabled).toBe(false);
      // The cockpit opens registered panels only; the app registers it.
      h.registries.panels.register({
        id: "paged.style-options",
        title: "Style Options",
        component: StyleOptionsPanel,
      });
      await h.click(button);
      expect(cockpitActions.activeTab?.()).toBe("paged.style-options");
      const options = await mountPanel(StyleOptionsPanel, {
        id: "paged.style-options",
        scene: richScene,
      });
      expect(
        options.root
          .querySelector("[data-style-options-panel]")
          ?.getAttribute("data-style-target"),
      ).toContain(style);
    });
  });
}
