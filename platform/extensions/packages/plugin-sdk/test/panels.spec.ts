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
