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

// The template notice (ADR 293; docs/composable-editor.md §12, decision 4):
// a template opened as a document by an editor says what it is and offers
// "Edit template" explicitly; a document without fields, or a session whose
// role is not the editor's, shows nothing.

import { afterEach, describe, expect, test } from "bun:test";

import { TemplateNotice } from "../../src/panels/template/template-notice";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

async function makeField(h: PanelHarness<unknown>) {
  await h.client.setSessionPolicy({ role: "author", overrides: [] });
  const reply = await h.mutate({
    op: "insertTextFrame",
    args: { pageId: h.handle!.pageIds[0], bounds: [100, 40, 160, 300] },
  } as never);
  const elementId = (reply as { payload: { createdId: unknown } }).payload
    .createdId;
  await h.mutate({
    op: "setPluginMetadata",
    args: {
      elementId,
      key: "x-paged:template",
      value: JSON.stringify({
        v: 1,
        data: { field: { name: "headline", kind: "text" } },
      }),
    },
  } as never);
  await h.client.setSessionPolicy({ role: "editor", overrides: [] });
}

const notice = () => document.querySelector("[data-template-notice]");

describe("template notice", () => {
  test("an editor sees the template as a template, and Edit template makes them its author", async () => {
    const h = await mountPanel(TemplateNotice, {
      id: "paged.template",
      document: "blank",
    });
    expect(notice()).toBeNull();
    await makeField(h);
    await h.settle();
    await h.settle();
    expect(notice()?.textContent).toContain(
      "This document is a template with 1 field.",
    );
    await h.click(
      document.querySelector<HTMLElement>("[data-template-notice-edit]")!,
    );
    await h.settle();
    // The author role: the notice has said what it had to.
    expect(notice()).toBeNull();
  });

  test("Hide hides it for this document", async () => {
    const h = await mountPanel(TemplateNotice, {
      id: "paged.template",
      document: "blank",
    });
    await makeField(h);
    await h.settle();
    await h.settle();
    expect(notice()).not.toBeNull();
    await h.click(
      document.querySelector<HTMLElement>("[data-template-notice-hide]")!,
    );
    expect(notice()).toBeNull();
  });

  test("without the Template panel there is nothing to offer", async () => {
    const h = await mountPanel(TemplateNotice, {
      id: "test.not-the-template-panel",
      document: "blank",
    });
    await makeField(h);
    await h.settle();
    await h.settle();
    expect(notice()).toBeNull();
  });
});
