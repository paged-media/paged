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

// The Template panel (paged.template; plan F1, F2): an editor takes up
// authoring, makes the selected text frame a field with a name, a limit and
// an extra permission, sets a document default, previews as a filler (the
// engine then refuses what the template does not permit) and comes back.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { TemplatePanel } from "../../src/panels/template/template-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = () =>
  mountPanel(TemplatePanel, { id: "paged.template", document: "blank" });

const q = <T extends Element = HTMLElement>(
  h: PanelHarness<unknown>,
  sel: string,
) => h.root.querySelector<T>(sel);

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

describe("Template panel", () => {
  test("an author makes a field, sets a default, and previews as a filler", async () => {
    covers("panel:paged.template");
    const h = await mount();
    const made = await h.mutate({
      op: "insertTextFrame",
      args: { pageId: h.handle!.pageIds[0], bounds: [100, 40, 160, 300] },
    } as never);
    const id = (made as { payload: { createdId: never } }).payload.createdId;

    // An editor may not write the template: the panel offers authoring.
    expect(
      q(h, "[data-template-role-line]")?.getAttribute(
        "data-template-role-line",
      ),
    ).toBe("editor");
    expect(q(h, "[data-template-editor]")).toBeNull();
    await h.click(q(h, '[data-template-role="author"]')!);
    await h.settle();
    expect(
      q(h, "[data-template-role-line]")?.getAttribute(
        "data-template-role-line",
      ),
    ).toBe("author");

    await h.select([id]);
    await until(h, "[data-template-editor]");
    const name = q<HTMLInputElement>(h, '[data-template-edit="name"]')!;
    await h.act(async () => {
      await h.user.clear(name);
      await h.user.type(name, "headline");
      const max = q<HTMLInputElement>(h, '[data-template-edit="maxLength"]')!;
      await h.user.type(max, "30");
    });
    await h.click(q(h, '[data-template-allow="text.style"]')!);
    await h.click(q(h, "[data-template-save]")!);
    await h.settle();
    expect(q(h, "[data-template-problem]")).toBeNull();
    const [row] = await h.client.templateFields();
    expect(row?.field).toMatchObject({
      name: "headline",
      kind: "text",
      constraints: { maxLength: 30 },
    });
    await until(h, '[data-template-field-row="headline"]');

    // A document default: a filler may select any item.
    await h.click(q(h, '[data-template-default="select"]')!);
    await h.settle();
    expect(q(h, "[data-template-default-problem]")).toBeNull();
    const meta = await h.client.documentMeta();
    expect(JSON.stringify(meta)).toContain("select");

    // Preview as a filler: the engine refuses a move the template does not
    // permit; back to authoring, the editor is back.
    await h.click(q(h, '[data-template-role="preview"]')!);
    await h.settle();
    expect(
      q(h, "[data-template-role-line]")?.getAttribute(
        "data-template-role-line",
      ),
    ).toBe("filler");
    expect(q(h, "[data-template-editor]")).toBeNull();
    const moved = await h.mutate({
      op: "moveFrame",
      args: {
        frameId: (id as { id: string }).id,
        transform: [1, 0, 0, 1, 20, 20],
      },
    } as never);
    expect(moved.kind).toBe("mutationFailed");
    await h.click(q(h, '[data-template-role="author"]')!);
    await h.settle();
    expect(
      q(h, "[data-template-role-line]")?.getAttribute(
        "data-template-role-line",
      ),
    ).toBe("author");
  });

  test("Remove field takes the field away", async () => {
    covers("panel:paged.template");
    const h = await mount();
    const made = await h.mutate({
      op: "insertTextFrame",
      args: { pageId: h.handle!.pageIds[0], bounds: [100, 40, 160, 300] },
    } as never);
    const id = (made as { payload: { createdId: never } }).payload.createdId;
    await h.click(q(h, '[data-template-role="author"]')!);
    await h.select([id]);
    await until(h, "[data-template-save]");
    await h.click(q(h, "[data-template-save]")!);
    await h.settle();
    expect((await h.client.templateFields()).length).toBe(1);
    await until(h, "[data-template-remove]");
    await h.click(q(h, "[data-template-remove]")!);
    await h.settle();
    expect(await h.client.templateFields()).toEqual([]);
  });
});
