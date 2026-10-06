/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// v70 — the doors a presentation plugin needs: `host.render.snapshot`
// (a page as a PNG, items left out on request) and `host.viewport`'s
// page members (go to a page, the active page and its change event).
// The snapshot runs once against the real engine; the page members
// against a scripted backend, since the camera is the editor's.

import { afterEach, describe, expect, it } from "vitest";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError, type PagesBackend } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (
  capabilities: PluginManifest["capabilities"] = { document: { read: "broad" } },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

const isPng = (b: Uint8Array) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

describe("host.render.snapshot (v70)", () => {
  it("renders a page, and leaves the named items out of that image only", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    expect(live.host.supports("render.snapshot@1")).toBe(true);

    const full = await live.host.render.snapshot(pageId, { widthPx: 160 });
    expect(full).not.toBeNull();
    expect(isPng(full!.png)).toBe(true);
    expect(Math.abs(full!.widthPx - 160)).toBeLessThanOrEqual(1);
    expect(full!.heightPx).toBeGreaterThan(0);

    const hidden = await live.host.render.snapshot(pageId, {
      widthPx: 160,
      hideItems: [{ kind: "rectangle", id: "urect" }],
    });
    expect(hidden).not.toBeNull();
    expect(Buffer.from(hidden!.png).equals(Buffer.from(full!.png))).toBe(false);

    // A query, not an edit: the next full render is the first one again.
    const again = await live.host.render.snapshot(pageId, { widthPx: 160 });
    expect(Buffer.from(again!.png).equals(Buffer.from(full!.png))).toBe(true);
  });

  it("answers null for an unknown page and refuses a bad width", async () => {
    live = await createHeadlessHost({ console: silent });
    await live.load(minimalIdml());
    expect(await live.host.render.snapshot("nope", { widthPx: 100 })).toBeNull();
    await expect(live.host.render.snapshot("nope", { widthPx: 0 })).rejects.toThrow(/widthPx/);
  });

  it("is a document read: refused without the read capability", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest({}), {
      console: silent,
      capabilityMode: "enforce",
    });
    await expect(host.render.snapshot("p1", { widthPx: 10 })).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });
});

describe("host.viewport page members (v70)", () => {
  function withPages() {
    const calls: [string, string][] = [];
    let active: string | null = "p1";
    const listeners = new Set<(p: string | null) => void>();
    const backend: PagesBackend = {
      goToPage(pageId, fit) {
        calls.push([pageId, fit]);
        if (pageId !== "p2") return false;
        active = "p2";
        listeners.forEach((l) => l(active));
        return true;
      },
      activePage: () => active,
      onDidChangeActivePage(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const fake = makeFakeEditor();
    const handle = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
      pages: backend,
    });
    return { ...handle, calls, listeners };
  }

  it("goes to a page through the backend and reports the change", async () => {
    const { host, calls } = withPages();
    expect(host.supports("viewport.pages@1")).toBe(true);
    const seen: (string | null)[] = [];
    host.viewport.onDidChangeActivePage((p) => seen.push(p));
    expect(host.viewport.activePage()).toBe("p1");
    expect(await host.viewport.goToPage("p2")).toBe(true);
    expect(await host.viewport.goToPage("zz", { fit: "width" })).toBe(false);
    expect(calls).toEqual([
      ["p2", "page"],
      ["zz", "width"],
    ]);
    expect(seen).toEqual(["p2"]);
    expect(host.viewport.activePage()).toBe("p2");
  });

  it("drops its listener when the bundle is disposed", () => {
    const { host, dispose, listeners } = withPages();
    host.viewport.onDidChangeActivePage(() => {});
    expect(listeners.size).toBe(1);
    dispose();
    expect(listeners.size).toBe(0);
  });

  it("answers the honest nothing without a backend", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest(), { console: silent });
    expect(host.supports("viewport.pages@1")).toBe(false);
    expect(await host.viewport.goToPage("p1")).toBe(false);
    expect(host.viewport.activePage()).toBeNull();
    host.viewport.onDidChangeActivePage(() => {}).dispose();
  });
});
