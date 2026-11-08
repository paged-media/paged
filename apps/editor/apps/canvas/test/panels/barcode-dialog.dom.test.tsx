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

// Object ▸ Insert barcode… (paged.insert.barcode): the dialog collects the
// data and the symbology and runs the command; the command encodes through the
// engine's `paged.barcode` and draws the symbol, grouped, as ONE undo step;
// the menu row is in every kind of document (a doc or a slide deck included).

import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import {
  BARCODE_MENU_ITEMS,
  PAGED_INSERT_BARCODE,
  buildBarcodeCommands,
} from "../../src/barcode-commands";
import {
  BarcodeDialog,
  openBarcodeDialog,
} from "../../src/panels/barcode-dialog";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const q = <T extends Element = HTMLElement>(
  h: PanelHarness<unknown>,
  sel: string,
) => document.querySelector<T>(sel) ?? h.root.querySelector<T>(sel);

/** The element kinds the scene tree lists, document-wide. */
async function kinds(h: PanelHarness<unknown>): Promise<string[]> {
  const r = await h.client.executeScript("paged.tree()");
  const out: string[] = [];
  const visit = (n: { id?: { kind: string } | null; children?: unknown[] }) => {
    if (n.id) out.push(n.id.kind);
    for (const c of (n.children ?? []) as (typeof n)[]) visit(c);
  };
  for (const root of JSON.parse(r.output[0] ?? "[]")) visit(root);
  return out;
}

describe("paged.insert.barcode [editor-shell.insert-barcode]", () => {
  test("the menu row is Object > Insert barcode…, in every kind of document", () => {
    covers("menu:Object/Insert barcode…");
    expect(BARCODE_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      ["Object/Insert barcode…", PAGED_INSERT_BARCODE],
    ]);
    const when = BARCODE_MENU_ITEMS[0]!.when as (state: unknown) => boolean;
    // The gate reads an open document at its root, never the document's kind:
    // a Word document, a deck and a layout all qualify.
    for (const _kind of ["layout", "doc", "slide"]) {
      expect(when({ document: { handle: { pageCount: 1 } } })).toBe(true);
    }
    expect(when({ document: { handle: { pageCount: 0 } } })).toBe(false);
    expect(
      when({ document: { handle: { pageCount: 1 } }, editContext: {} }),
    ).toBe(false);
  });

  test("the dialog runs the command with the symbology and the data", async () => {
    covers("command:paged.insert.barcode");
    const h = await mountPanel(BarcodeDialog, {
      id: "paged.insert.barcode",
      document: "blank",
    });
    const calls = h.spyCommand(PAGED_INSERT_BARCODE);
    expect(q(h, "[data-barcode-dialog]")).toBeNull();
    await h.act(() => openBarcodeDialog(h.scope));
    const ok = q<HTMLButtonElement>(h, "[data-barcode-ok]")!;
    // Nothing to encode yet.
    expect(ok.disabled).toBe(true);
    await h.choose(q(h, "[data-barcode-symbology]")!, "ean13");
    fireEvent.change(q<HTMLInputElement>(h, "[data-barcode-data]")!, {
      target: { value: "4006381333931" },
    });
    await h.settle();
    await h.click(q(h, "[data-barcode-ok]")!);
    expect(calls).toEqual([{ symbology: "ean13", data: "4006381333931" }]);
    expect(q(h, "[data-barcode-dialog]")).toBeNull();
  });

  test("the command draws the symbol as one group in one undo step; a bad value is refused in words", async () => {
    covers("command:paged.insert.barcode");
    const reports: string[] = [];
    const h = await mountPanel(BarcodeDialog, {
      id: "paged.insert.barcode",
      document: "blank",
      registries: (r) => {
        for (const c of buildBarcodeCommands(
          (_s, m) => reports.push(m),
          () => {},
        ))
          r.commands.register(c);
      },
    });
    const before = await kinds(h);
    await h.act(() =>
      h.registries.commands.invoke(PAGED_INSERT_BARCODE, {
        symbology: "ean13",
        data: "4006381333931",
      }),
    );
    expect(reports).toEqual([]);
    const after = await kinds(h);
    expect(after.filter((k) => k === "group").length).toBe(
      before.filter((k) => k === "group").length + 1,
    );
    expect(
      after.filter((k) => k === "polygon").length -
        before.filter((k) => k === "polygon").length,
    ).toBeGreaterThan(10);
    await h.client.undo();
    await h.settle();
    expect(await kinds(h)).toEqual(before);

    await h.act(() =>
      h.registries.commands.invoke(PAGED_INSERT_BARCODE, {
        symbology: "ean13",
        data: "12ab",
      }),
    );
    expect(reports.join("\n")).toContain("refused");
    expect(await kinds(h)).toEqual(before);
  });
});
