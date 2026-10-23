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

// File ▸ Open as template… (paged.template.openAsTemplate; plan F5, engine
// ADR 1002), over the real engine: a document whose text frame's story is
// tagged with a tagged range, and a tagged picture frame. The command opens
// the dialog, which lists the fields the tags describe and the tag it
// skipped; an editor is asked to take up authoring; one field is left out;
// applying writes the other as the template's field in one undo step.

import { afterEach, describe, expect, test } from "bun:test";
import { createCommandRegistry } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  OPEN_AS_TEMPLATE_COMMANDS,
  OPEN_AS_TEMPLATE_MENU_ITEMS,
  OpenAsTemplateDialog,
} from "../../src/panels/template/open-as-template-dialog";
import { shapesScene, textScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const q = <T extends Element = HTMLElement>(
  h: PanelHarness<unknown>,
  sel: string,
) => document.querySelector<T>(sel) ?? h.root.querySelector<T>(sel);

async function until(
  h: PanelHarness<unknown>,
  sel: string,
): Promise<HTMLElement> {
  for (let i = 0; i < 50; i++) {
    const el = q(h, sel);
    if (el) return el;
    await h.settle();
  }
  throw new Error(`nothing matches ${sel}`);
}

describe("paged.template.openAsTemplate", () => {
  test("the File menu item opens the dialog", async () => {
    covers("command:paged.template.openAsTemplate");
    expect(OPEN_AS_TEMPLATE_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual(
      [["File/Open as template…", "paged.template.openAsTemplate"]],
    );
    const h = await mountPanel(OpenAsTemplateDialog, {
      id: "paged.template.openAsTemplate",
      document: "blank",
    });
    // The command runs in the dialog's editor (its scope).
    const registry = createCommandRegistry(() => ({ scope: h.scope }));
    for (const c of OPEN_AS_TEMPLATE_COMMANDS) registry.register(c);
    expect(q(h, "[data-open-as-template-dialog]")).toBeNull();
    await h.act(() => registry.invoke("paged.template.openAsTemplate"));
    await until(h, "[data-open-as-template-empty]");
    await h.click(q(h, "[data-open-as-template-cancel]")!);
    expect(q(h, "[data-open-as-template-dialog]")).toBeNull();
  });

  test("lists the tagged fields and writes the chosen ones as the author", async () => {
    const h = await mountPanel(OpenAsTemplateDialog, {
      id: "paged.template.openAsTemplate",
      document: "blank",
      scene: async (ctx) => {
        const text = await textScene(ctx);
        const shapes = await shapesScene(ctx);
        return { text, shapes };
      },
    });
    const { text, shapes } = h.scene;
    // Tagging is the author's: the setup takes the role on the engine.
    await h.client.setSessionPolicy({ role: "author", overrides: [] });
    for (const m of [
      {
        op: "tagItem",
        args: { item: String(text.textFrame.id), tag: "Letter" },
      },
      {
        op: "tagRange",
        args: { storyId: text.storyId, start: 6, end: 11, tag: "Who" },
      },
      { op: "tagItem", args: { item: String(shapes.rect.id), tag: "Photo" } },
      {
        op: "setXmlAttribute",
        args: {
          element: String(shapes.rect.id),
          name: "label",
          value: "Picture",
        },
      },
    ]) {
      const r = await h.mutate(m as never);
      expect(r.kind).toBe("mutationApplied");
    }
    await h.client.setSessionPolicy({ role: "editor", overrides: [] });

    await h.act(() =>
      OPEN_AS_TEMPLATE_COMMANDS[0]!.handler({ scope: h.scope } as never),
    );
    await until(h, '[data-open-as-template-field="Who"]');
    // Nothing is a field yet: every derived field is new.
    await h.settle();
    expect(q(h, '[data-open-as-template-status="Who"]')?.textContent).toBe(
      "(new)",
    );
    expect(
      q(h, '[data-open-as-template-field="Photo"]')?.textContent,
    ).toContain("Picture");
    expect(q(h, "[data-open-as-template-skipped]")?.textContent).toContain(
      "Letter: its tagged ranges are the fields",
    );
    // An editor may not write a template: the apply waits for authoring.
    expect(
      q<HTMLButtonElement>(h, "[data-open-as-template-apply]")!.disabled,
    ).toBe(true);
    await h.click(q(h, "[data-open-as-template-author]")!);
    await h.settle();
    // Leave the picture out.
    await h.click(
      q(h, '[data-open-as-template-field="Photo"] input[type="checkbox"]')!,
    );
    const apply = q<HTMLButtonElement>(h, "[data-open-as-template-apply]")!;
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toBe("Make 1 field");
    await h.click(apply);
    await h.settle();
    expect(q(h, "[data-open-as-template-dialog]")).toBeNull();

    const rows = (await h.client.templateFields()) as readonly {
      field: { name: string; kind: string };
      value?: { text?: string } | null;
    }[];
    expect(
      rows.map((r) => [r.field.name, r.field.kind, r.value?.text]),
    ).toEqual([["Who", "textRun", "world"]]);
    // One undo step takes it back.
    await h.client.undo();
    expect(await h.client.templateFields()).toEqual([]);
  });
});
