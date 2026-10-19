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

// The Web frame properties panel: a schema panel of property rows and
// lists, RENDERED (happy-dom) through the SDK's schema-panel component and a
// minimal renderer (./schema-renderer.tsx) on the real engine. With a web
// frame selected it shows the frame's render options; a CSS variable picked
// from its list is written back into the frame's CSS, as one undo step.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { CommandContribution } from "@paged-media/plugin-api";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";
import { DEFAULT_SOURCE } from "@paged-media/web-model";

import { loadWebSource, writeWebSource } from "../../src/source-part";
import { drive, mountSchema, webHost, type WebHarness } from "./harness";

const PANEL = "media.paged.web.panel.properties";
let w: WebHarness;

beforeEach(async () => {
  w = await webHost();
}, 60_000);

afterEach(() => {
  cleanup();
  w.h.dispose();
});

async function insertWebFrame() {
  const c = w.h.contributions.find(
    (x) =>
      x.kind === "command" && x.id === "media.paged.web.command.insertWebFrame",
  )!;
  await (c.value as CommandContribution).handler(undefined);
  return w.host.selection.get()[0]!;
}

describe("the Web frame properties panel", () => {
  it("shows the selected web frame's media and overflow, and writes a new overflow in one undo step", async () => {
    covers("panel:media.paged.web.panel.properties");
    const view = mountSchema(w, PANEL);
    const media = () =>
      view.container.querySelector<HTMLInputElement>('[data-path="media"]')!;
    expect(media().hasAttribute("data-empty")).toBe(true);
    const id = await insertWebFrame();
    await drive(() => w.host.selection.set([id]));
    await waitFor(() => expect(media().value).toBe("print"));
    const overflow = view.container.querySelector<HTMLInputElement>(
      '[data-path="overflow"]',
    )!;
    expect(overflow.value).toBe("clip");
    await drive(() =>
      fireEvent.change(overflow, { target: { value: "grow" } }),
    );
    await drive(() => fireEvent.blur(overflow));
    await waitFor(async () =>
      expect((await loadWebSource(w.host, id))?.options?.overflow).toBe("grow"),
    );
    await drive(() => w.host.document.undo());
    expect((await loadWebSource(w.host, id))?.options?.overflow ?? "clip").toBe(
      "clip",
    );
  });

  it("lists the frame's CSS variables; a value written for the picked one lands in its CSS", async () => {
    covers("panel:media.paged.web.panel.properties");
    const id = await insertWebFrame();
    expect(
      (
        await writeWebSource(w.host, id, {
          ...DEFAULT_SOURCE,
          css: ":root{--accent:#ff0000} h1{color:var(--accent)}",
        })
      ).applied,
    ).toBe(true);
    const view = mountSchema(w, PANEL);
    await drive(() => w.host.selection.set([id]));
    const item = await waitFor(() => {
      const el = view.container.querySelector<HTMLButtonElement>(
        '[data-list="web.properties.cssVars"] [data-list-item]',
      );
      expect(el?.textContent).toContain("--accent");
      return el!;
    });
    await drive(() => fireEvent.click(item));
    const value = await waitFor(() => {
      const el = [
        ...view.container.querySelectorAll<HTMLInputElement>(
          '[data-path="value"]',
        ),
      ].find((e) => e.dataset.target === item.dataset.listItem);
      expect(el).toBeDefined();
      return el!;
    });
    expect(value.value).toBe("#ff0000");
    await drive(() =>
      fireEvent.change(value, { target: { value: "#00ff00" } }),
    );
    await drive(() => fireEvent.blur(value));
    await waitFor(async () =>
      expect((await loadWebSource(w.host, id))?.css).toContain(
        "--accent:#00ff00",
      ),
    );
    await drive(() => w.host.document.undo());
    expect((await loadWebSource(w.host, id))?.css).toContain(
      "--accent:#ff0000",
    );
  });
});
