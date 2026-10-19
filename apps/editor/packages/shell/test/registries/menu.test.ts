/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The menu registry and the menu MODEL the menu bar renders
// (`buildMenuTree`): how built-in and contributed items merge into one
// tree — the fixed core menus, the Insert-verb relocation, the plugin
// fold into Plugins ▸ <name>, groups and their order (a separator falls
// between two groups), one row per command — and how an accelerator is
// shown on each platform.

import { afterAll, describe, expect, test } from "bun:test";

import {
  buildMenuTree,
  CORE_MENUS,
  type MenuLeaf,
  type MenuNode,
  type MenuSubmenu,
} from "../../src/chrome/MenuBar";
import {
  createMenuRegistry,
  type MenuItemContribution,
  type MenuRegistryEvent,
} from "../../src/registries/menu";

const item = (
  path: string,
  command: string,
  extra: Partial<MenuItemContribution> = {},
): MenuItemContribution => ({ path, command, ...extra });

/** A level as `label` / `[submenu]` strings, in render order. */
const labels = (nodes: MenuNode[]) =>
  nodes.map((n) => (n.type === "submenu" ? `[${n.label}]` : n.label));

/** Where the separators fall: the menu bar draws one wherever the group
 *  changes between two neighbours (renderNodes). */
const withSeparators = (nodes: MenuNode[]) => {
  const out: string[] = [];
  nodes.forEach((n, i) => {
    if (i > 0 && n.group !== nodes[i - 1].group) out.push("---");
    out.push(n.type === "submenu" ? `[${n.label}]` : n.label);
  });
  return out;
};

const menu = (tree: Array<[string, MenuNode[]]>, label: string) => {
  const found = tree.find(([l]) => l === label);
  if (!found) throw new Error(`no top-level menu "${label}"`);
  return found[1];
};

const sub = (nodes: MenuNode[], label: string): MenuSubmenu => {
  const s = nodes.find(
    (n): n is MenuSubmenu => n.type === "submenu" && n.label === label,
  );
  if (!s) throw new Error(`no submenu "${label}" in ${labels(nodes)}`);
  return s;
};

describe("the menu registry", () => {
  test("path is the identity: register, get, list in order, refuse a duplicate", () => {
    const r = createMenuRegistry();
    r.register(item("File/Open…", "paged.file.openIdml"));
    r.register(item("Edit/Undo", "paged.editor.undo"));
    expect(r.get("File/Open…")?.command).toBe("paged.file.openIdml");
    expect(r.list().map((m) => m.path)).toEqual(["File/Open…", "Edit/Undo"]);
    expect(() => r.register(item("File/Open…", "other"))).toThrow(
      /already registered/,
    );
    // The same COMMAND at a second path is legal (two doors, one verb).
    expect(() =>
      r.register(item("Help/Open…", "paged.file.openIdml")),
    ).not.toThrow();
  });

  test("onChange reports registrations and removals exactly once", () => {
    const r = createMenuRegistry();
    const events: MenuRegistryEvent[] = [];
    const sub = r.onChange((e) => void events.push(e));
    const h = r.register(item("View/Zoom in", "paged.view.zoomIn"));
    r.register(item("View/Zoom out", "paged.view.zoomOut"));
    h.dispose();
    h.dispose();
    r.unregister("View/Zoom out");
    r.unregister("View/never");
    sub.dispose();
    r.register(item("View/Fit", "paged.view.zoomFit"));
    expect(
      events.map((e) =>
        e.kind === "registered" ? `+${e.contribution.path}` : `-${e.path}`,
      ),
    ).toEqual([
      "+View/Zoom in",
      "+View/Zoom out",
      "-View/Zoom in",
      "-View/Zoom out",
    ]);
  });
});

describe("the menu model (buildMenuTree)", () => {
  test("the core menus keep their fixed order whatever registered first", () => {
    const tree = buildMenuTree([
      item("Help/About", "h"),
      item("View/Zoom in", "v"),
      item("Window/Layers", "w"),
      item("File/Open…", "f"),
      item("Edit/Undo", "e"),
      item("Layout/Pages", "l"),
      item("Type/Story", "t"),
      item("Object/Group", "o"),
    ]);
    expect(tree.map(([l]) => l)).toEqual([
      "File",
      "Edit",
      "Object",
      "Type",
      "Layout",
      "View",
      "Window",
      "Help",
    ]);
    expect(CORE_MENUS).toEqual([
      "File",
      "Edit",
      "Insert",
      "Object",
      "Type",
      "Layout",
      "View",
      "Plugins",
      "Window",
      "Help",
    ]);
  });

  test("a menu nobody contributes to does not exist; a single-segment path is dropped", () => {
    const tree = buildMenuTree([item("File/Open…", "f"), item("Orphan", "x")]);
    expect(tree.map(([l]) => l)).toEqual(["File"]);
  });

  test("context (plugin) menus follow the core menus, and are folded into Plugins too", () => {
    const tree = buildMenuTree([
      item("Sheet/Insert rows", "media.paged.sheet.command.insertRows"),
      item("File/Open…", "f"),
      item("Draw/Pathfinder/Unite", "media.paged.draw.command.unite"),
    ]);
    expect(tree.map(([l]) => l)).toEqual(["File", "Plugins", "Draw", "Sheet"]);
    const plugins = menu(tree, "Plugins");
    expect(labels(plugins)).toEqual(["[Draw]", "[Sheet]"]);
    // The context copy is untouched by the fold.
    expect(labels(menu(tree, "Draw"))).toEqual(["[Pathfinder]"]);
    expect(labels(sub(plugins, "Draw").children)).toEqual(["[Pathfinder]"]);
  });

  test("submenus nest by path, with the default order 100", () => {
    const tree = buildMenuTree([
      item("Window/Styles/Swatches", "paged.panel.show.paged.swatches"),
      item("Window/Styles/Gradients", "paged.panel.show.paged.gradients"),
      item("Window/Layers", "paged.panel.show.paged.layers", { order: 5 }),
    ]);
    const w = menu(tree, "Window");
    expect(labels(w)).toEqual(["Layers", "[Styles]"]);
    const styles = sub(w, "Styles");
    expect(styles.order).toBe(100);
    // Same group, same order: alphabetical.
    expect(labels(styles.children)).toEqual(["Gradients", "Swatches"]);
  });

  test("a submenu sits where its lowest child does", () => {
    const tree = buildMenuTree([
      item("Object/Arrange/Send to back", "b", { order: 40, group: "arr" }),
      item("Object/Group", "g", { order: 20, group: "grp" }),
      item("Object/Arrange/Bring to front", "f", { order: 10, group: "arr" }),
    ]);
    const o = menu(tree, "Object");
    expect(labels(o)).toEqual(["[Arrange]", "Group"]);
    expect(sub(o, "Arrange").order).toBe(10);
    expect(labels(sub(o, "Arrange").children)).toEqual([
      "Bring to front",
      "Send to back",
    ]);
  });

  test("groups rank by their lowest member; members sort inside; a separator divides groups", () => {
    const tree = buildMenuTree([
      item("File/Export PDF…", "pdf", { order: 58, group: "produce" }),
      item("File/Save (.paged)", "save", { order: 31, group: "save" }),
      item("File/Open PDF…", "openPdf", { order: 15, group: "open" }),
      item("File/Save As IDML…", "saveIdml", { order: 33, group: "save" }),
      item("File/Open…", "open", { order: 10, group: "open" }),
    ]);
    expect(withSeparators(menu(tree, "File"))).toEqual([
      "Open…",
      "Open PDF…",
      "---",
      "Save (.paged)",
      "Save As IDML…",
      "---",
      "Export PDF…",
    ]);
  });

  test("a contributed item merges into a built-in menu at its own order (Edit: Undo first)", () => {
    const builtIn = [
      item("Edit/Undo", "paged.editor.undo", { order: -20, group: "undo" }),
      item("Edit/Redo", "paged.editor.redo", { order: -10, group: "undo" }),
      item("Edit/Select all", "paged.edit.selectAll", {
        order: 10,
        group: "select",
      }),
    ];
    const contributed = [
      item("Edit/Selection to mask", "media.paged.image.command.toMask", {
        order: 5,
        group: "image",
      }),
    ];
    for (const items of [
      [...builtIn, ...contributed],
      [...contributed, ...builtIn],
    ]) {
      expect(withSeparators(menu(buildMenuTree(items), "Edit"))).toEqual([
        "Undo",
        "Redo",
        "---",
        "Selection to mask",
        "---",
        "Select all",
      ]);
    }
  });

  test("Insert verbs filed under a core menu gather in Insert; a context menu keeps its own", () => {
    const tree = buildMenuTree([
      item("Object/Insert spreadsheet…", "media.paged.sheet.command.insert"),
      item("Layout/Insert page", "paged.insert.newPage"),
      item("Sheet/Insert rows", "media.paged.sheet.command.insertRows"),
      // Deeper than two segments: stays where it was put.
      item("Object/Insert/Text frame", "paged.insert.textFrame"),
    ]);
    expect(labels(menu(tree, "Insert"))).toEqual(["Page", "Spreadsheet…"]);
    expect(labels(menu(tree, "Sheet"))).toEqual(["Insert rows"]);
    expect(labels(menu(tree, "Object"))).toEqual(["[Insert]"]);
  });

  test("one command, one row per level", () => {
    const tree = buildMenuTree([
      item("View/Zoom in", "paged.view.zoomIn"),
      item("View/Zoom in (again)", "paged.view.zoomIn"),
      item("View/Sub/Zoom in", "paged.view.zoomIn"),
    ]);
    const v = menu(tree, "View");
    expect(labels(v)).toEqual(["[Sub]", "Zoom in"]);
    expect(labels(sub(v, "Sub").children)).toEqual(["Zoom in"]);
  });

  test("a plugin's own menu merges with its panels under Plugins ▸ <name>, without duplicates", () => {
    const tree = buildMenuTree([
      // The shell's Window-menu derivation files a plugin panel here.
      item(
        "Plugins/Data/Data sources",
        "paged.panel.show.media.paged.data.panel.sources",
        { group: "panels", groupLabel: "Panels" },
      ),
      // The plugin's own top-level menu opens the same panel, and more.
      item(
        "Data/Data sources…",
        "paged.panel.show.media.paged.data.panel.sources",
      ),
      item("Data/Run query", "media.paged.data.command.runQuery"),
      item("Draw/Stroke", "paged.panel.show.media.paged.draw.panel.stroke", {
        group: "panels",
      }),
    ]);
    const data = sub(menu(tree, "Plugins"), "Data");
    const commands = data.children
      .filter((n): n is MenuLeaf => n.type === "leaf")
      .map((n) => n.command);
    // The panel command appears once.
    expect(
      commands.filter(
        (c) => c === "paged.panel.show.media.paged.data.panel.sources",
      ),
    ).toHaveLength(1);
    expect(commands).toContain("media.paged.data.command.runQuery");
    // Every plugin submenu is one alphabetical section with no heading.
    for (const n of menu(tree, "Plugins")) {
      expect(n.group).toBe("plugins");
      expect(n.groupLabel).toBeUndefined();
      expect(n.order).toBe(0);
    }
    expect(labels(menu(tree, "Plugins"))).toEqual(["[Data]", "[Draw]"]);
  });

  test("a plugin panel named like one of its command submenus moves into it as '<name> panel'", () => {
    const tree = buildMenuTree([
      item(
        "Plugins/Draw/Appearance",
        "paged.panel.show.media.paged.draw.panel.appearance",
        { group: "panels" },
      ),
      item("Draw/Appearance/Add fill", "media.paged.draw.command.addFill", {
        order: 10,
      }),
      item("Draw/Appearance/Add stroke", "media.paged.draw.command.addStroke", {
        order: 20,
      }),
    ]);
    const draw = sub(menu(tree, "Plugins"), "Draw");
    expect(labels(draw.children)).toEqual(["[Appearance]"]);
    expect(labels(sub(draw.children, "Appearance").children)).toEqual([
      "Appearance panel",
      "Add fill",
      "Add stroke",
    ]);
  });

  test("a leaf carries what the bar renders: when, labelFor, seam, label kind, icon, accelerator, heading", () => {
    const when = () => true;
    const labelFor = () => "Undo Brush stroke";
    const [[, nodes]] = buildMenuTree([
      item("Edit/Undo", "paged.editor.undo", {
        when,
        labelFor,
        accelerator: "cmd+z",
        icon: "ui-undo",
        group: "undo",
        groupLabel: "History",
      }),
      item("Edit/Soon", "paged.soon", { disabled: true }),
      item("Edit/Version", "paged.help.version", { kind: "label" }),
    ]);
    const undo = nodes.find(
      (n): n is MenuLeaf => n.type === "leaf" && n.label === "Undo",
    )!;
    expect(undo).toMatchObject({
      command: "paged.editor.undo",
      accelerator: "cmd+z",
      icon: "ui-undo",
      group: "undo",
      groupLabel: "History",
    });
    expect(undo.when).toBe(when);
    expect(undo.labelFor).toBe(labelFor);
    const soon = nodes.find((n) => n.label === "Soon") as MenuLeaf;
    expect(soon.disabled).toBe(true);
    const version = nodes.find((n) => n.label === "Version") as MenuLeaf;
    expect(version.kind).toBe("label");
  });
});

describe("accelerators per platform", () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(nav, "platform");
  const load = async (platform: string, tag: string) => {
    Object.defineProperty(nav, "platform", {
      value: platform,
      configurable: true,
    });
    // A fresh instance of the module: IS_MAC is read at load.
    return (await import(
      `../../src/chrome/MenuBar.tsx?platform=${tag}`
    )) as typeof import("../../src/chrome/MenuBar");
  };
  afterAll(() => {
    if (original) Object.defineProperty(nav, "platform", original);
    else delete nav.platform;
  });

  test("macOS: the cmd twin, in Apple's modifier order with glyphs", async () => {
    const mac = await load("MacIntel", "mac");
    expect(mac.nativeKey(["ctrl+s", "cmd+s"])).toBe("cmd+s");
    expect(mac.nativeKey(["cmd+s", "ctrl+s"])).toBe("cmd+s");
    expect(mac.prettyKey("cmd+shift+s")).toBe("⇧⌘S");
    expect(mac.prettyKey("cmd+alt+shift+k")).toBe("⌥⇧⌘K");
    expect(mac.prettyKey("ctrl+tab")).toBe("⌃Tab");
    expect(mac.prettyKey("shift+arrowleft")).toBe("⇧←");
    expect(mac.prettyKey("backspace")).toBe("⌫");
    expect(mac.prettyKey("delete")).toBe("⌦");
    expect(mac.prettyKey("v")).toBe("V");
  });

  test("Windows / Linux: the ctrl twin, spelled out, cmd shown as Ctrl", async () => {
    const pc = await load("Win32", "pc");
    expect(pc.nativeKey(["cmd+s", "ctrl+s"])).toBe("ctrl+s");
    expect(pc.prettyKey("ctrl+shift+s")).toBe("Ctrl+Shift+S");
    // A display-only accelerator authored as cmd (Undo) reads as Ctrl.
    expect(pc.prettyKey("cmd+z")).toBe("Ctrl+Z");
    expect(pc.prettyKey("alt+arrowup")).toBe("Alt+↑");
    expect(pc.prettyKey("escape")).toBe("Escape");
  });

  test("a binding with no platform twin is shown as it is on both", async () => {
    const mac = await load("MacIntel", "mac2");
    const pc = await load("Linux x86_64", "linux");
    // An unmodified key is native everywhere.
    expect(mac.nativeKey(["w"])).toBe("w");
    expect(pc.nativeKey(["w"])).toBe("w");
    // A cmd-only binding is still the one picked on a PC (first key).
    expect(pc.nativeKey(["cmd+d"])).toBe("cmd+d");
  });

  // Finding SH-5: `cmd` is the Meta key in the registry on every
  // platform (a binding is `metaKey` exact), but on Windows and Linux the
  // display spells `cmd` as Ctrl. A binding registered without its ctrl
  // twin (Sheet ▸ Fill down is cmd+d only) is shown as Ctrl+D, and Ctrl+D
  // runs Place instead.
  test.failing(
    "SH-5: a PC never shows Ctrl for a binding Ctrl does not fire",
    async () => {
      const pc = await load("Win32", "pc2");
      expect(pc.prettyKey(pc.nativeKey(["cmd+d"]))).not.toBe("Ctrl+D");
    },
  );
});
