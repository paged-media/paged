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

// The browser preview reloads when its source changes, and only then.
//
// Setting an iframe's srcdoc navigates it, also to the same markup, and React
// sets the attribute again whenever the value it is handed is a different
// object. Under Trusted Types (editor ADR 240) the value is a TrustedHTML
// object, a new one per `createHTML` call. Made on every render, it reloaded
// the preview on every render of the panel: each keystroke, each document
// change. A page that is screencast paints every reload, and the web film's
// editor stopped answering input while it did. happy-dom has no Trusted
// Types, so the spec installs a stand-in whose `createHTML` returns a new
// object each call, as Chrome's does.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { drive, mount, webHost, type WebHarness } from "./harness";

const PANEL = "media.paged.web.panel.source";

type Factory = {
  createPolicy(
    name: string,
    rules: { createHTML?: (input: string) => string },
  ): { createHTML(input: string): unknown };
};

const g = globalThis as unknown as { trustedTypes?: Factory };
let saved: Factory | undefined;

beforeAll(() => {
  saved = g.trustedTypes;
  g.trustedTypes = {
    createPolicy: (_name, rules) => ({
      // A new object per call, which stringifies to the policy's output.
      createHTML: (input) => {
        const html = rules.createHTML ? rules.createHTML(input) : input;
        return { toString: () => html };
      },
    }),
  };
});

afterAll(() => {
  g.trustedTypes = saved;
});

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

describe("the Web source panel's browser preview", () => {
  it("is not reloaded by a render that leaves its source unchanged", async () => {
    covers("panel:media.paged.web.panel.source");
    const view = mount(w.panel(PANEL));
    await waitFor(() =>
      expect(q(view.container, "[data-web-insert]")).not.toBeNull(),
    );
    await drive(() => fireEvent.click(q(view.container, "[data-web-insert]")!));
    const preview = await waitFor(() => {
      const el = q<HTMLIFrameElement>(
        view.container,
        "iframe[data-web-preview]",
      );
      expect(el).not.toBeNull();
      return el!;
    });
    const html = await waitFor(() => {
      const el = q<HTMLTextAreaElement>(
        view.container,
        '[data-web-editor-fallback="html"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });
    // Let the first preview settle (the debounce, the font and binding
    // reads), then count every srcdoc the panel sets from here on.
    await new Promise((r) => setTimeout(r, 500));
    await drive(() => {});
    const sets: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records)
        if (r.attributeName === "srcdoc")
          sets.push(preview.getAttribute("srcdoc") ?? "");
    });
    observer.observe(preview, { attributes: true });

    // Renders that change nothing the preview shows: a document change
    // elsewhere on the page (the panel re-reads the frame's size and its
    // bound values) and a draft edit undone before the debounce ends.
    const out = await w.host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [300, 20, 360, 120] },
    } as never);
    expect(out.applied).toBe(true);
    await drive(() => {});
    const before = html.value;
    await drive(() =>
      fireEvent.change(html, { target: { value: `${before}<p>x</p>` } }),
    );
    await drive(() => fireEvent.change(html, { target: { value: before } }));
    await new Promise((r) => setTimeout(r, 500));
    await drive(() => {});
    expect(sets, "no srcdoc was set for an unchanged source").toEqual([]);

    // A changed source does reach the preview, once it settles.
    await drive(() =>
      fireEvent.change(html, { target: { value: "<h1>Edited</h1>" } }),
    );
    await waitFor(
      () => expect(sets.some((s) => s.includes("<h1>Edited</h1>"))).toBe(true),
      { timeout: 3_000 },
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(sets.length, "one srcdoc for one settled edit").toBe(1);
    observer.disconnect();
  });
});
