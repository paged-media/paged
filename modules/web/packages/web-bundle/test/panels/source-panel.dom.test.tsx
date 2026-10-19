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

// The Web source panel, RENDERED (happy-dom) against the real engine: with
// nothing selected it inserts a web frame; on a web frame it edits the
// source, which reaches the document only on "Save to document", as one
// undo step; on a plain frame it makes that frame a web frame.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";
import { DEFAULT_SOURCE } from "@paged-media/web-model";

import { loadWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { drive, mount, webHost, type WebHarness } from "./harness";

const PANEL = "media.paged.web.panel.source";
let w: WebHarness;

beforeEach(async () => {
  w = await webHost();
}, 60_000);

afterEach(() => {
  cleanup();
  w.h.dispose();
});

const q = <T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  sel: string,
) => root.querySelector<T>(sel);

describe("the Web source panel", () => {
  it("with nothing selected, Insert web frame adds one and opens its source", async () => {
    covers("panel:media.paged.web.panel.source");
    const view = mount(w.panel(PANEL));
    await waitFor(() =>
      expect(q(view.container, '[data-web-panel="empty"]')).not.toBeNull(),
    );
    await drive(() => fireEvent.click(q(view.container, "[data-web-insert]")!));
    const [id] = w.host.selection.get();
    expect(id).toBeDefined();
    expect(await loadWebSource(w.host, id!)).toEqual(DEFAULT_SOURCE);
    await waitFor(() =>
      expect(
        q(view.container, '[data-web-editor-fallback="html"]'),
      ).not.toBeNull(),
    );
  });

  it("an HTML edit stays a draft until Save to document, which writes it as one undo step", async () => {
    covers("panel:media.paged.web.panel.source");
    const view = mount(w.panel(PANEL));
    await waitFor(() =>
      expect(q(view.container, "[data-web-insert]")).not.toBeNull(),
    );
    await drive(() => fireEvent.click(q(view.container, "[data-web-insert]")!));
    const [id] = w.host.selection.get();
    const html = await waitFor(() => {
      const el = q<HTMLTextAreaElement>(
        view.container,
        '[data-web-editor-fallback="html"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });
    await drive(() =>
      fireEvent.change(html, { target: { value: "<h1>Edited</h1>" } }),
    );
    await waitFor(() =>
      expect(q(view.container, "[data-web-dirty]")!.dataset.webDirty).toBe(
        "true",
      ),
    );
    // A draft is not the document.
    expect((await loadWebSource(w.host, id!))?.html).toBe(DEFAULT_SOURCE.html);
    await drive(() => fireEvent.click(q(view.container, "[data-web-commit]")!));
    await waitFor(async () =>
      expect((await loadWebSource(w.host, id!))?.html).toBe("<h1>Edited</h1>"),
    );
    await waitFor(() =>
      expect(q(view.container, "[data-web-dirty]")!.dataset.webDirty).toBe(
        "false",
      ),
    );
    await drive(() => w.host.document.undo());
    expect((await loadWebSource(w.host, id!))?.html).toBe(DEFAULT_SOURCE.html);
  });

  it("on a plain frame, Make web frame gives it the default source", async () => {
    covers("panel:media.paged.web.panel.source");
    const out = await w.host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [20, 20, 120, 220] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame created");
    const plain = out.createdId as ElementId;
    await drive(() => w.host.selection.set([plain]));
    const view = mount(w.panel(PANEL));
    await waitFor(() =>
      expect(q(view.container, '[data-web-panel="convert"]')).not.toBeNull(),
    );
    expect(await loadWebSource(w.host, plain)).toBeNull();
    await drive(() => fireEvent.click(q(view.container, "[data-web-make]")!));
    await waitFor(async () =>
      expect(await loadWebSource(w.host, plain)).toEqual(DEFAULT_SOURCE),
    );
  });
});
