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

// The contract every id-keyed shell registry shares (panels, tools,
// overlays, importers, exporters): unique ids, insertion order, a
// Disposable whose second dispose is harmless, one change event per real
// change and none for a no-op, a listener that can leave. Plus what each
// adds: the tool rail's groups, the importer's file resolution, the
// semantic dock groups.

import { describe, expect, test } from "bun:test";

import {
  createExporterRegistry,
  createImporterRegistry,
  fileExtension,
} from "../../src/registries/document-io";
import { createOverlayRegistry } from "../../src/registries/overlay";
import { createPanelRegistry } from "../../src/registries/panel";
import { createSemanticGroupRegistry } from "../../src/registries/semantic-group";
import { createToolRegistry, DEFAULT_TOOLS } from "../../src/registries/tool";

interface IdRegistry {
  register(c: never): { dispose(): void };
  unregister(id: never): void;
  get?(id: never): unknown;
  list(): Array<{ id: string }>;
  onChange(h: (e: { kind: string; id?: string }) => void): {
    dispose(): void;
  };
}

const REGISTRIES: Array<[string, () => IdRegistry, (id: string) => unknown]> = [
  [
    "panels",
    () => createPanelRegistry() as unknown as IdRegistry,
    (id) => ({ id, title: id, component: () => null }),
  ],
  [
    "tools",
    () => createToolRegistry() as unknown as IdRegistry,
    (id) => ({ id, title: id, icon: "x", group: "g", order: 0 }),
  ],
  [
    "overlays",
    () => createOverlayRegistry() as unknown as IdRegistry,
    (id) => ({ id, component: () => null }),
  ],
  [
    "importers",
    () => createImporterRegistry() as unknown as IdRegistry,
    (id) => ({ id, title: id, extensions: [".x"], import: async () => {} }),
  ],
  [
    "exporters",
    () => createExporterRegistry() as unknown as IdRegistry,
    (id) => ({ id, title: id, extension: ".x", export: async () => {} }),
  ],
];

describe.each(REGISTRIES)("the %s registry", (_name, make, contribution) => {
  test("unique ids, insertion order, harmless double dispose", () => {
    const r = make();
    const a = r.register(contribution("a") as never);
    r.register(contribution("b") as never);
    r.register(contribution("c") as never);
    expect(r.list().map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(() => r.register(contribution("b") as never)).toThrow(
      /already registered/,
    );
    a.dispose();
    a.dispose();
    expect(r.list().map((x) => x.id)).toEqual(["b", "c"]);
    // A freed id can be registered again, at the end.
    r.register(contribution("a") as never);
    expect(r.list().map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  test("one event per real change, none for a no-op, and a listener can leave", () => {
    const r = make();
    const events: string[] = [];
    const sub = r.onChange((e) =>
      events.push(
        `${e.kind}:${e.id ?? (e as { contribution?: { id: string } }).contribution?.id}`,
      ),
    );
    const h = r.register(contribution("a") as never);
    h.dispose();
    h.dispose();
    r.register(contribution("b") as never);
    r.unregister("b" as never);
    r.unregister("b" as never);
    r.unregister("never" as never);
    sub.dispose();
    r.register(contribution("c") as never);
    expect(events).toEqual([
      "registered:a",
      "unregistered:a",
      "registered:b",
      "unregistered:b",
    ]);
  });
});

describe("the tool registry's rail groups", () => {
  test("groups keep first-seen order; members sort by order, ties by registration", () => {
    const r = createToolRegistry();
    const t = (id: string, group: string, order?: number) =>
      r.register({ id, title: id, icon: "x", group, order } as never);
    t("pen", "pen", 2);
    t("rect", "shape", 1);
    t("pencil", "pen", 1);
    t("ellipse", "shape", 1);
    t("addAnchor", "pen");
    const groups = r.groups();
    expect([...groups.keys()]).toEqual(["pen", "shape"]);
    expect(groups.get("pen")!.map((x) => x.id)).toEqual([
      "addAnchor",
      "pencil",
      "pen",
    ]);
    expect(groups.get("shape")!.map((x) => x.id)).toEqual(["rect", "ellipse"]);
  });

  test("the seed tools: Selection (v) and Type (t), group defaults", () => {
    expect(
      DEFAULT_TOOLS.map((t) => [t.id, t.shortcut, t.isGroupDefault]),
    ).toEqual([
      ["paged.tool.select", "v", true],
      ["paged.tool.type", "t", true],
    ]);
  });
});

describe("the importer registry resolves a file", () => {
  const r = createImporterRegistry();
  r.register({
    id: "sheet",
    title: "Spreadsheet",
    extensions: [".XLSX", ".csv"],
    mimeTypes: ["text/csv"],
    import: async () => {},
  } as never);
  r.register({
    id: "doc",
    title: "Word",
    extensions: [".docx"],
    import: async () => {},
  } as never);

  test("by extension, case-blind, then by MIME type, else null (the IDML default)", () => {
    expect(r.resolve("Budget.xlsx")?.id).toBe("sheet");
    expect(r.resolve("C:\\Users\\a\\memo.DOCX")?.id).toBe("doc");
    expect(r.resolve("export", "text/csv")?.id).toBe("sheet");
    expect(r.resolve("layout.idml")).toBeNull();
    expect(r.resolve("noext")).toBeNull();
  });

  test("the picker's accept list is the lowercase union", () => {
    expect(r.acceptExtensions()).toEqual([".xlsx", ".csv", ".docx"]);
  });

  test("fileExtension: the last dot of the base name, lowercase; a dotfile has none", () => {
    expect(fileExtension("a/b/c.Tar.GZ")).toBe(".gz");
    expect(fileExtension("dir.with.dots/file")).toBe("");
    expect(fileExtension(".hidden")).toBe("");
    expect(fileExtension("x\\y.Paged")).toBe(".paged");
  });
});

describe("the semantic dock groups", () => {
  test("a name creates its dock group once; forget re-creates it", () => {
    const r = createSemanticGroupRegistry();
    let n = 0;
    const create = (dock: string) => `${dock}-${++n}`;
    expect(r.lookup("structure")).toBeUndefined();
    expect(r.resolve("structure", "right", create)).toBe("right-1");
    expect(r.resolve("structure", "left", create)).toBe("right-1");
    expect(n).toBe(1);
    r.forget("structure");
    expect(r.lookup("structure")).toBeUndefined();
    expect(r.resolve("structure", "left", create)).toBe("left-2");
  });
});
