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

// C-9 — the caret/selection-offset read door (`host.text.caret()`).
// The caret lives in EDITOR state (the text-editing layer), so the
// editor injects a `TextCaretBackend`; the SDK owns only the
// pass-through + the honest no-reader default. Coverage:
//   1. the door: a wired backend's caret surfaces as `{storyId, offset}`
//      (the engine text-op offset convention — the value a bundle hands
//      straight to `insertText.offset`);
//   2. the live read: the facade re-reads the backend per call (no
//      snapshotting — the caret moves between calls);
//   3. the no-backend default: `caret()` is `null` and
//      `supports("text.caret@1")` is false (a read door, no capability
//      gate — like text.measureString / viewport).

import { describe, expect, it } from "vitest";

import type { PluginManifest, TextCaret } from "@paged-media/plugin-api";

import { createBundleHost, type TextCaretBackend } from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
};

function makeHost(textCaret?: TextCaretBackend) {
  return createBundleHost(() => makeFakeEditor().editor, manifest, {
    console: silent,
    textCaret,
  });
}

describe("host.text.caret — the C-9 read door", () => {
  it("surfaces the injected reader's caret shape", () => {
    let caret: TextCaret | null = { storyId: "u123", offset: 42 };
    const backend: TextCaretBackend = { read: () => caret };
    const { host } = makeHost(backend);

    expect(host.supports("text.caret@1")).toBe(true);
    expect(host.text.caret()).toEqual({ storyId: "u123", offset: 42 });

    // Live per-call read — the caret MOVES between calls (typing,
    // clicks); the facade must not snapshot.
    caret = { storyId: "u123", offset: 43 };
    expect(host.text.caret()).toEqual({ storyId: "u123", offset: 43 });

    // No active caret is a first-class answer, not an error.
    caret = null;
    expect(host.text.caret()).toBeNull();
  });

  it("defaults to null + unsupported when the host injects no reader", () => {
    const { host } = makeHost(); // no textCaret backend
    expect(host.supports("text.caret@1")).toBe(false);
    // The honest no-reader door: never a throw, always null.
    expect(host.text.caret()).toBeNull();
  });
});
