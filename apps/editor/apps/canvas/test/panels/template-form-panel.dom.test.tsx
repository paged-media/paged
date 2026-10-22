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

// Template form (paged.template.form; docs/composable-editor.md §7.10): the
// template's fields with a control each, over the real engine. Without
// fields it says so; a text field takes typed text when the input commits,
// as a filler, and the engine holds the new value; a visibility field
// toggles its item.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { TemplateFormPanel } from "../../src/panels/template/form-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = (document: "none" | "blank" = "blank") =>
  mountPanel(TemplateFormPanel, { id: "paged.template.form", document });

async function field(
  h: PanelHarness<unknown>,
  name: string,
  kind: "text" | "visibility",
  maxLength?: number,
): Promise<{ id: unknown; storyId: string | null }> {
  await h.client.setSessionPolicy({ role: "author", overrides: [] });
  const op = kind === "text" ? "insertTextFrame" : "insertFrame";
  const reply = await h.mutate({
    op,
    args: { pageId: h.handle!.pageIds[0], bounds: [100, 40, 160, 300] },
  } as never);
  const id = (reply as { payload: { createdId: unknown } }).payload.createdId;
  await h.mutate({
    op: "setPluginMetadata",
    args: {
      elementId: id,
      key: "x-paged:template",
      value: JSON.stringify({
        v: 1,
        data: {
          field: {
            name,
            kind,
            label: name.toUpperCase(),
            constraints: maxLength ? { maxLength } : {},
          },
        },
      }),
    },
  } as never);
  const rows = await h.client.templateFields();
  const row = rows.find((r) => r.field.name === name)!;
  return { id, storyId: row.storyId ?? null };
}

describe("Template form", () => {
  test("a document without fields says so", async () => {
    covers("panel:paged.template.form");
    const h = await mount();
    expect(
      h.root.querySelector("[data-template-form-empty]")?.textContent,
    ).toContain("no fields");
  });

  test("a filler fills a text field through its input", async () => {
    covers("panel:paged.template.form");
    const h = await mount();
    const { storyId } = await field(h, "headline", "text", 30);
    await h.mutate({
      op: "insertText",
      args: { storyId: storyId!, offset: 0, text: "Old title" },
    } as never);
    await h.client.setSessionPolicy({ role: "filler", overrides: [] });
    await h.settle();
    const input = h.root.querySelector<HTMLInputElement>(
      '[data-field-input="headline"]',
    )!;
    expect(input.value).toBe("Old title");
    expect(
      h.root.querySelector('[data-field-count="headline"]')?.textContent,
    ).toBe("9/30");
    await h.act(async () => {
      input.focus();
      await h.user.clear(input);
      await h.user.type(input, "Ada{Enter}");
    });
    const [row] = await h.client.templateFields();
    expect(row!.value).toEqual({ kind: "text", text: "Ada" });
    expect(h.root.querySelector("[data-field-problem]")).toBeNull();
  });

  test("a visibility field toggles its item", async () => {
    covers("panel:paged.template.form");
    const h = await mount();
    await field(h, "badge", "visibility");
    await h.client.setSessionPolicy({ role: "filler", overrides: [] });
    await h.settle();
    const box = h.root.querySelector<HTMLInputElement>(
      '[data-field-input="badge"]',
    )!;
    expect(box.checked).toBe(true);
    await h.click(box);
    const [row] = await h.client.templateFields();
    expect(row!.value).toEqual({ kind: "visible", visible: false });
  });
});
