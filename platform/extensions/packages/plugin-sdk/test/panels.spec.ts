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
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const PANEL: PanelContribution = {
  id: "media.paged.test.panel.source",
  title: "Source",
  component: (() => null) as never,
};

describe("contributePanel", () => {
  it("registers panel + show/hide commands routed through host.shell", () => {
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    const closePanel = vi.fn();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      shell: { openPanel, closePanel },
    });
    contributePanel(host, PANEL);
    expect(fake.panels.ids()).toEqual(["media.paged.test.panel.source"]);
    expect(fake.commands.ids()).toEqual([
      "media.paged.test.panel.source.show",
      "media.paged.test.panel.source.hide",
    ]);
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

  it("dispose tears the trio down", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      shell: { openPanel() {}, closePanel() {} },
    });
    const d = contributePanel(host, PANEL);
    d.dispose();
    expect(fake.panels.ids()).toHaveLength(0);
    expect(fake.commands.ids()).toHaveLength(0);
  });
});
