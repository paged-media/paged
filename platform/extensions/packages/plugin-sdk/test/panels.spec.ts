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

import { describe, expect, it, vi } from "vitest";

import type {
  PanelContribution,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { contributePanel } from "../src/panels";
import { makeFakeEditor } from "./fake-editor";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  // Declare the panel the bundle registers — capability enforcement is
  // on by default (trust-line W0.11); the manifest must list it.
  contributes: { panels: ["media.paged.test.panel.source"] },
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const PANEL: PanelContribution = {
  id: "media.paged.test.panel.source",
  title: "Source",
  component: (() => null) as never,
};

describe("contributePanel", () => {
  it("registers the panel ONLY (B-15: host derives show/hide)", () => {
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    const closePanel = vi.fn();
    const pickFile = vi.fn(async () => []);
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      shell: { openPanel, closePanel, pickFile },
    });
    contributePanel(host, PANEL);
    expect(fake.panels.ids()).toEqual(["media.paged.test.panel.source"]);
    expect(fake.commands.ids()).toEqual([]);
    expect(host.supports("shell.openPanel@1")).toBe(true);
  });

  it("warns and no-ops without host-app shell actions", () => {
    const fake = makeFakeEditor();
    const warn = vi.fn();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: { ...silent, warn },
    });
    expect(host.supports("shell.openPanel@1")).toBe(false);
    host.shell.openPanel("media.paged.test.panel.source");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("dispose tears the registration down", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      shell: { openPanel() {}, closePanel() {}, async pickFile() { return []; } },
    });
    const d = contributePanel(host, PANEL);
    d.dispose();
    expect(fake.panels.ids()).toHaveLength(0);
  });
});
