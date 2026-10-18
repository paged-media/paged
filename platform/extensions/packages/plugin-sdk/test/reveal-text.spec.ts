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

// `host.viewport.revealText` — taking the user to a piece of text (an
// outline entry, a find hit, a diagnostic). The camera and the text
// selection are the editor's, so the door runs against a scripted backend.

import { describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost, type TextRevealBackend } from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad" } },
});

function withText(answer: boolean | (() => never) = true) {
  const calls: Array<[{ storyId: string; start: number; end: number }, boolean]> = [];
  const text: TextRevealBackend = {
    revealText(range, select) {
      calls.push([range, select]);
      if (typeof answer === "function") answer();
      return range.storyId === "u1" ? (answer as boolean) : false;
    },
  };
  const fake = makeFakeEditor();
  const handle = createBundleHost(() => fake.editor, manifest(), { console: silent, text });
  return { ...handle, calls };
}

describe("host.viewport.revealText", () => {
  it("reveals and selects a range through the backend", async () => {
    const { host, calls } = withText();
    expect(host.supports("viewport.revealText@1")).toBe(true);
    expect(await host.viewport.revealText({ storyId: "u1", start: 4, end: 12 })).toBe(true);
    expect(await host.viewport.revealText({ storyId: "u1", start: 0, end: 0 }, { select: false })).toBe(true);
    expect(await host.viewport.revealText({ storyId: "missing", start: 0, end: 1 })).toBe(false);
    expect(calls).toEqual([
      [{ storyId: "u1", start: 4, end: 12 }, true],
      [{ storyId: "u1", start: 0, end: 0 }, false],
      [{ storyId: "missing", start: 0, end: 1 }, true],
    ]);
  });

  it("refuses a malformed range without asking the backend", async () => {
    const { host, calls } = withText();
    expect(await host.viewport.revealText({ storyId: "", start: 0, end: 1 })).toBe(false);
    expect(await host.viewport.revealText({ storyId: "u1", start: 5, end: 2 })).toBe(false);
    expect(await host.viewport.revealText({ storyId: "u1", start: -1, end: 2 })).toBe(false);
    expect(await host.viewport.revealText({ storyId: "u1", start: Number.NaN, end: 2 })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("answers false when the backend throws", async () => {
    const { host } = withText(() => {
      throw new Error("no layout");
    });
    expect(await host.viewport.revealText({ storyId: "u1", start: 0, end: 1 })).toBe(false);
  });

  it("answers the honest nothing without a backend", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest(), { console: silent });
    expect(host.supports("viewport.revealText@1")).toBe(false);
    expect(await host.viewport.revealText({ storyId: "u1", start: 0, end: 1 })).toBe(false);
  });
});
