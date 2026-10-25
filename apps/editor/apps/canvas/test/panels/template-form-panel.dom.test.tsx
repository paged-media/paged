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

  test("a module field reads and writes through its module", async () => {
    covers("panel:paged.template.form");
    const h = await mount();
    const values = new Map<string, number>([["B4", 12.5]]);
    const registered = h.objects.registry.register({
      plugin: "acme.sheet",
      model: {
        kinds: [],
        templateFields: [
          {
            kind: "acme.sheet.price",
            title: "Price",
            control: { kind: "number", min: 0 },
            read: (_ctx, f) =>
              values.get((f.def as { cell: string }).cell) ?? null,
            write(_ctx, f, value) {
              if (typeof value !== "number" || value < 0)
                return { ok: false, problem: "Not a price." };
              values.set((f.def as { cell: string }).cell, value);
              return { ok: true };
            },
          },
        ],
      },
    });
    await h.client.setSessionPolicy({ role: "author", overrides: [] });
    const made = await h.mutate({
      op: "insertFrame",
      args: { pageId: h.handle!.pageIds[0], bounds: [100, 40, 160, 300] },
    } as never);
    const id = (made as { payload: { createdId: unknown } }).payload.createdId;
    const policy = (kind: string) =>
      JSON.stringify({
        v: 1,
        data: {
          field: {
            name: kind.endsWith("price") ? "price" : "other",
            kind: "module",
            module: { kind, def: { cell: "B4" } },
          },
        },
      });
    await h.mutate({
      op: "setPluginMetadata",
      args: {
        elementId: id,
        key: "x-paged:template",
        value: policy("acme.sheet.price"),
      },
    } as never);
    try {
      await h.client.setSessionPolicy({ role: "filler", overrides: [] });
      await h.settle();
      // The module reads its value asynchronously after the row renders.
      let input: HTMLInputElement | null = null;
      for (let i = 0; i < 50 && !input; i++) {
        await h.settle();
        input = h.root.querySelector<HTMLInputElement>(
          '[data-field-input="price"]',
        );
      }
      if (!input) throw new Error("the module field has no input");
      expect(input.value).toBe("12.5");
      await h.act(async () => {
        input.focus();
        await h.user.clear(input);
        await h.user.type(input, "-3");
        input.blur();
      });
      await h.settle();
      expect(h.root.querySelector("[data-field-problem]")?.textContent).toBe(
        "Not a price.",
      );
      await h.act(async () => {
        input.focus();
        await h.user.clear(input);
        await h.user.type(input, "9");
        input.blur();
      });
      await h.settle();
      expect(values.get("B4")).toBe(9);
    } finally {
      registered.dispose();
    }
  });

  // Engine ADR 1017: a text field written in the styles its author allows.
  test("a styled field offers exactly its styles and writes runs", async () => {
    covers("panel:paged.template.form");
    const h = await mount();
    await h.client.setSessionPolicy({ role: "author", overrides: [] });
    for (const name of ["Bold", "Italic", "Caps"])
      await h.mutate({
        op: "createCharacterStyle",
        args: { selfId: `CharacterStyle/${name}`, name },
      } as never);
    const made = await h.mutate({
      op: "insertTextFrame",
      args: { pageId: h.handle!.pageIds[0], bounds: [100, 40, 160, 300] },
    } as never);
    const id = (made as { payload: { createdId: unknown } }).payload.createdId;
    await h.mutate({
      op: "setPluginMetadata",
      args: {
        elementId: id,
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: {
              name: "headline",
              kind: "text",
              constraints: {
                allowedStyles: ["Bold", "Italic"],
                breaks: "none",
              },
            },
          },
        }),
      },
    } as never);
    const storyId = (await h.client.templateFields())[0]!.storyId!;
    await h.mutate({
      op: "insertText",
      args: { storyId, offset: 0, text: "Ada Lovelace" },
    } as never);
    await h.client.setSessionPolicy({ role: "filler", overrides: [] });
    await h.settle();
    const box = h.root.querySelector<HTMLElement>(
      '[data-field-styled="headline"]',
    )!;
    expect(box.textContent).toBe("Ada Lovelace");
    const styles = [...h.root.querySelectorAll("[data-field-style]")].map((b) =>
      b.getAttribute("data-field-style"),
    );
    expect(styles).toEqual(["Bold", "Italic"]);

    // Enter makes no break in a one-line field.
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await h.act(async () => {
      box.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(box.querySelector("br")).toBeNull();

    // "Lovelace" selected and set in Bold: the value is written as runs.
    const text = box.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 12);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await h.click(h.root.querySelector('[data-field-style="Bold"]')!);
    await h.settle();
    const [row] = await h.client.templateFields();
    expect(row!.value).toEqual({
      kind: "runs",
      runs: [{ text: "Ada " }, { text: "Lovelace", style: "Bold" }],
    });
    expect(h.root.querySelector("[data-field-problem]")).toBeNull();
  });

  // Engine ADR 1017: an alternates field shows the member the filler picks.
  test("an alternates field picks one member in one step", async () => {
    covers("panel:paged.template.form");
    const h = await mount();
    await h.client.setSessionPolicy({ role: "author", overrides: [] });
    for (const [i, name] of ["left", "right"].entries()) {
      const made = await h.mutate({
        op: "insertFrame",
        args: {
          pageId: h.handle!.pageIds[0],
          bounds: [100, 40 + i * 100, 160, 120 + i * 100],
        },
      } as never);
      const id = (made as { payload: { createdId: unknown } }).payload
        .createdId;
      await h.mutate({
        op: "setElementProperty",
        args: {
          elementId: id,
          path: "itemName",
          value: { type: "text", value: name },
        },
      } as never);
      if (i > 0)
        await h.mutate({
          op: "setElementProperty",
          args: {
            elementId: id,
            path: "elementVisible",
            value: { type: "bool", value: false },
          },
        } as never);
    }
    await h.mutate({
      op: "setDocumentMetadata",
      args: {
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            alternates: {
              layout: {
                name: "layout",
                kind: "alternates",
                members: ["left", "right"],
              },
            },
          },
        }),
      },
    } as never);
    await h.client.setSessionPolicy({ role: "filler", overrides: [] });
    await h.settle();
    const left = h.root.querySelector('[data-field-alternate="left"]')!;
    expect(left.getAttribute("aria-checked")).toBe("true");
    await h.click(h.root.querySelector('[data-field-alternate="right"]')!);
    await h.settle();
    const [row] = await h.client.templateFields();
    expect(row!.value).toEqual({ kind: "alternate", member: "right" });
    expect(row!.members?.map((m) => [m.name, m.visible])).toEqual([
      ["left", false],
      ["right", true],
    ]);
  });
});
