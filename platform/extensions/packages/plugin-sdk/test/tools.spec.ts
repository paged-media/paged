import { describe, expect, it } from "vitest";

import type { PluginManifest, ToolContribution } from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { contributeTool } from "../src/tools";
import { makeFakeEditor } from "./fake-editor";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const TOOL: ToolContribution = {
  id: "media.paged.test.tool.pen",
  title: "Pen",
  icon: "tool-pen",
  shortcut: "p",
  group: "pen",
  section: "drawType",
} as ToolContribution;

describe("contributeTool", () => {
  it("registers tool + activation command + guarded keybinding", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeTool(host, TOOL);
    expect(fake.tools.ids()).toEqual(["media.paged.test.tool.pen"]);
    expect(fake.commands.ids()).toEqual([
      "media.paged.test.tool.pen.activate",
    ]);
    expect(fake.keybindings.count()).toBe(1);
  });

  it("skips the keybinding for shortcut-less tools and disposes all", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    const d = contributeTool(host, { ...TOOL, shortcut: undefined });
    expect(fake.keybindings.count()).toBe(0);
    d.dispose();
    expect(fake.tools.ids()).toHaveLength(0);
    expect(fake.commands.ids()).toHaveLength(0);
  });
});
