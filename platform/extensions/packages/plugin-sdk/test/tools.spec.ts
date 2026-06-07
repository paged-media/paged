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
  // Declare the tool the bundle registers — capability enforcement is
  // on by default (trust-line W0.11); the manifest must list it.
  contributes: { tools: ["media.paged.test.tool.pen"] },
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

describe("contributeTool (B-15: host derives activation + shortcut)", () => {
  it("registers the tool ONLY — no bundle-side command/keybinding", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeTool(host, TOOL);
    expect(fake.tools.ids()).toEqual(["media.paged.test.tool.pen"]);
    expect(fake.commands.ids()).toEqual([]);
    expect(fake.keybindings.count()).toBe(0);
  });

  it("disposes the registration", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    const d = contributeTool(host, TOOL);
    d.dispose();
    expect(fake.tools.ids()).toHaveLength(0);
  });
});
