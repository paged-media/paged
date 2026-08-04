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

// K-10 — the SAVE-FILE door (RFI "host.shell.pickFile is READ-only, so a
// bundle cannot offer 'Save adjusted copy…'"). Consumer: paged.image,
// which computes adjusted PSD/PNG/JPEG bytes it could previously deliver
// only through the Export Center. Coverage:
//   1. the pass-through: name + bytes + mimeType reach the injected
//      backend verbatim and the backend's verdict is the answer;
//   2. the honest NO-SAVER door: false, never a throw, when the host app
//      wired no saver — and the same when it wired a shell that predates
//      the member (the reason the surface WRAPS the backend);
//   3. the flag: `supports("shell.saveFile@1")` is per-MEMBER, unlike
//      `shell.pickFile@1` which rides the whole shell's presence;
//   4. a declined save is a RESULT (false), not a rejection.

import { describe, expect, it } from "vitest";

import type { PluginManifest, SaveFileOptions } from "@paged-media/plugin-api";

import { createBundleHost, type ShellBackend } from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: {},
});

function makeHost(shell?: ShellBackend) {
  const fake = makeFakeEditor();
  return createBundleHost(() => fake.editor, manifest(), {
    console: silent,
    capabilityMode: "enforce",
    ...(shell ? { shell } : {}),
  });
}

/** A shell backend WITHOUT `saveFile` — a host app that adopted the
 *  option before the door existed (the case the wrapper exists for). */
const legacyShell = (): ShellBackend => ({
  openPanel() {},
  closePanel() {},
  async pickFile() {
    return [];
  },
});

describe("shell.saveFile — the write half of the file door (K-10)", () => {
  it("hands name + bytes + mimeType to the backend and answers its verdict", async () => {
    const saved: SaveFileOptions[] = [];
    const { host } = makeHost({
      ...legacyShell(),
      async saveFile(options) {
        saved.push(options);
        return true;
      },
    });
    const bytes = new Uint8Array([137, 80, 78, 71]);
    await expect(
      host.shell.saveFile({
        suggestedName: "adjusted.png",
        bytes,
        mimeType: "image/png",
      }),
    ).resolves.toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].suggestedName).toBe("adjusted.png");
    expect(saved[0].mimeType).toBe("image/png");
    // Bytes cross verbatim — no copy, no Blob, no DOM File (isolate-ready).
    expect(saved[0].bytes).toBe(bytes);
    expect(host.supports("shell.saveFile@1")).toBe(true);
  });

  it("a DECLINED save is a result (false), never a rejection", async () => {
    const { host } = makeHost({
      ...legacyShell(),
      async saveFile() {
        return false;
      },
    });
    await expect(
      host.shell.saveFile({ suggestedName: "x.psd", bytes: new Uint8Array() }),
    ).resolves.toBe(false);
  });

  it("answers false when the host app wired NO shell at all", async () => {
    const { host } = makeHost();
    await expect(
      host.shell.saveFile({ suggestedName: "x.bin", bytes: new Uint8Array() }),
    ).resolves.toBe(false);
    expect(host.supports("shell.saveFile@1")).toBe(false);
  });

  it("answers false when the wired shell PREDATES the door (per-member flag)", async () => {
    const { host } = makeHost(legacyShell());
    // The picker still works — the shell is valid, only this door is
    // missing, which is exactly what the per-member flag reports.
    expect(host.supports("shell.pickFile@1")).toBe(true);
    expect(host.supports("shell.openPanel@1")).toBe(true);
    expect(host.supports("shell.saveFile@1")).toBe(false);
    await expect(
      host.shell.saveFile({ suggestedName: "x.bin", bytes: new Uint8Array() }),
    ).resolves.toBe(false);
  });
});
