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

// The editor profile (docs/composable-editor.md §5): resolution of the
// preset chain, region edits by matcher, and the shape check of a profile a
// host hands in. What this file holds them to:
//
//   · the base is today's editor: every region keeps everything, except
//     the form and the actions bar, which only template shapes have;
//   · a layer's region replaces its parent's, absent inherits, null removes;
//   · edits apply after their layer's regions, in order, and an edit that
//     cannot apply is a problem, never a throw;
//   · an unknown preset or a cycle ends the chain and is reported;
//   · bad data is dropped field by field and reported.

import { describe, expect, test } from "bun:test";

import {
  applyRegionEdit,
  baseProfile,
  globMatches,
  matchIndices,
  resolveProfile,
  validateProfile,
  type EditorProfile,
  type ResolvedRegion,
} from "../../src/profile";

const list = (...items: string[]): ResolvedRegion => ({ kind: "list", items });

describe("the base profile", () => {
  test("keeps every region except the template-only ones", () => {
    const base = baseProfile();
    expect(base.regions.menubar).toEqual({
      kind: "all",
      exclude: [],
      append: [],
    });
    expect(base.regions.canvas?.kind).toBe("all");
    expect(base.regions.form).toBeNull();
    expect(base.regions["actions-bar"]).toBeNull();
    expect(base.bundles).toBe("all");
    expect(base.canvas).toEqual({
      titleBar: true,
      rulers: true,
      thumbnails: true,
    });
  });
});

describe("resolveProfile", () => {
  const presets: Record<string, EditorProfile> = {
    full: {},
    focused: {
      extends: "full",
      title: "Focused",
      bundles: ["media.paged.draw"],
      regions: {
        "tool-rail": { items: ["paged.tool.select", "paged.tool.pen"] },
        "mode-bar": null,
      },
      storageScope: ".focused",
    },
    loopA: { extends: "loopB" },
    loopB: { extends: "loopA" },
  };

  test("an empty profile is the base", () => {
    const { profile, problems } = resolveProfile({}, presets);
    expect(problems).toEqual([]);
    expect(profile).toEqual({ ...baseProfile(), chain: [] });
  });

  test("expands the chain base-first and records it outermost last", () => {
    const { profile, problems } = resolveProfile(
      { extends: "focused", title: "Mine" },
      presets,
    );
    expect(problems).toEqual([]);
    expect(profile.chain).toEqual(["full", "focused"]);
    expect(profile.title).toBe("Mine");
    expect(profile.bundles).toEqual(["media.paged.draw"]);
    expect(profile.regions["tool-rail"]).toEqual(
      list("paged.tool.select", "paged.tool.pen"),
    );
    expect(profile.regions["mode-bar"]).toBeNull();
    expect(profile.storageScope).toBe(".focused");
  });

  test("an absent region inherits, null removes, a spec replaces", () => {
    const { profile } = resolveProfile(
      {
        extends: "focused",
        regions: { "mode-bar": { items: "all" }, header: null },
      },
      presets,
    );
    expect(profile.regions["tool-rail"]?.kind).toBe("list");
    expect(profile.regions["mode-bar"]?.kind).toBe("all");
    expect(profile.regions.header).toBeNull();
  });

  test("canvas furniture merges flag by flag", () => {
    const { profile } = resolveProfile({ canvas: { rulers: false } }, presets);
    expect(profile.canvas).toEqual({
      titleBar: true,
      rulers: false,
      thumbnails: true,
    });
  });

  test("edits apply after their layer's regions", () => {
    const { profile, problems } = resolveProfile(
      {
        extends: "focused",
        adjust: [
          {
            region: "tool-rail",
            op: "insert",
            after: "paged.tool.select",
            items: ["paged.tool.text"],
          },
          { region: "menubar", op: "remove", match: "Window" },
        ],
      },
      presets,
    );
    expect(problems).toEqual([]);
    expect(profile.regions["tool-rail"]).toEqual(
      list("paged.tool.select", "paged.tool.text", "paged.tool.pen"),
    );
    expect(profile.regions.menubar).toEqual({
      kind: "all",
      exclude: ["Window"],
      append: [],
    });
  });

  test("an unknown preset is reported and the rest still resolves", () => {
    const { profile, problems } = resolveProfile(
      { extends: "nope", title: "T" },
      presets,
    );
    expect(problems).toEqual([
      { path: "extends", message: 'unknown preset "nope"' },
    ]);
    expect(profile.title).toBe("T");
    expect(profile.chain).toEqual([]);
  });

  test("a cycle is reported and stops the chain", () => {
    const { problems } = resolveProfile({ extends: "loopA" }, presets);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("extends itself");
  });

  test("a preset name is never looked up on the prototype", () => {
    const { problems } = resolveProfile({ extends: "toString" }, presets);
    expect(problems[0]!.message).toBe('unknown preset "toString"');
  });
});

describe("matchers", () => {
  const items = [
    "paged.object.lock",
    "paged.object.hide",
    { kind: "separator" as const },
    "paged.file.save",
  ];

  test("glob, exact, first, last and index", () => {
    expect(matchIndices(items, "paged.object.*")).toEqual([0, 1]);
    expect(matchIndices(items, "paged.file.save")).toEqual([3]);
    expect(matchIndices(items, "first")).toEqual([0]);
    expect(matchIndices(items, "last")).toEqual([3]);
    expect(matchIndices(items, 2)).toEqual([2]);
    expect(matchIndices(items, -1)).toEqual([3]);
    expect(matchIndices(items, 9)).toEqual([]);
  });

  test("a glob escapes everything but the star", () => {
    expect(globMatches("a.b", "aXb")).toBe(false);
    expect(globMatches("Window/*", "Window/Layers")).toBe(true);
    expect(globMatches("*", "anything")).toBe(true);
  });
});

describe("applyRegionEdit", () => {
  test("remove from a list by glob", () => {
    const { region, problems } = applyRegionEdit(
      list("a.1", "a.2", "b.1"),
      { region: "header", op: "remove", match: "a.*" },
      "p",
    );
    expect(problems).toEqual([]);
    expect(region).toEqual(list("b.1"));
  });

  test("insert before, after and at the end", () => {
    const before = applyRegionEdit(
      list("a", "b"),
      { region: "header", op: "insert", before: "b", items: ["x"] },
      "p",
    );
    expect(before.region).toEqual(list("a", "x", "b"));
    const after = applyRegionEdit(
      list("a", "b"),
      { region: "header", op: "insert", after: "a", items: ["x"] },
      "p",
    );
    expect(after.region).toEqual(list("a", "x", "b"));
    const end = applyRegionEdit(
      list("a"),
      { region: "header", op: "insert", items: ["x"] },
      "p",
    );
    expect(end.region).toEqual(list("a", "x"));
  });

  test("a missing anchor inserts at the end and says so", () => {
    const { region, problems } = applyRegionEdit(
      list("a"),
      { region: "header", op: "insert", before: "zz", items: ["x"] },
      "p",
    );
    expect(region).toEqual(list("a", "x"));
    expect(problems).toHaveLength(1);
  });

  test("on an all-region, remove excludes and insert appends", () => {
    const all: ResolvedRegion = { kind: "all", exclude: [], append: [] };
    const removed = applyRegionEdit(
      all,
      { region: "menubar", op: "remove", match: "Window" },
      "p",
    );
    expect(removed.region).toEqual({
      kind: "all",
      exclude: ["Window"],
      append: [],
    });
    const appended = applyRegionEdit(
      all,
      { region: "header", op: "insert", items: ["x"] },
      "p",
    );
    expect(appended.region).toEqual({
      kind: "all",
      exclude: [],
      append: ["x"],
    });
    const positional = applyRegionEdit(
      all,
      { region: "menubar", op: "remove", match: "first" },
      "p",
    );
    expect(positional.region).toBe(all);
    expect(positional.problems).toHaveLength(1);
  });

  test("a removed region comes back only through set", () => {
    const insert = applyRegionEdit(
      null,
      { region: "form", op: "insert", items: ["x"] },
      "p",
    );
    expect(insert.region).toBeNull();
    expect(insert.problems).toHaveLength(1);
    const set = applyRegionEdit(
      null,
      { region: "form", op: "set", items: ["x"] },
      "p",
    );
    expect(set.region).toEqual(list("x"));
  });

  test("never mutates its input", () => {
    const input = list("a", "b");
    applyRegionEdit(input, { region: "header", op: "remove", match: "a" }, "p");
    applyRegionEdit(
      input,
      { region: "header", op: "insert", items: ["c"] },
      "p",
    );
    expect(input).toEqual(list("a", "b"));
  });
});

describe("validateProfile", () => {
  test("keeps a well-formed profile as is", () => {
    const input = {
      extends: "full",
      title: "T",
      bundles: ["media.paged.draw"],
      panels: "all",
      modes: [{ id: "fill", title: "Fill", slots: { left: "paged.layers" } }],
      regions: {
        menubar: null,
        "tool-rail": { items: ["paged.tool.select", { kind: "separator" }] },
      },
      adjust: [{ region: "header", op: "remove", match: "paged.*" }],
      canvas: { rulers: false },
      documentSizePt: [252, 144],
      storageScope: ".card",
    };
    const { profile, problems } = validateProfile(input);
    expect(problems).toEqual([]);
    expect(profile).toEqual(input as unknown as EditorProfile);
  });

  test("drops what is malformed, field by field, and reports it", () => {
    const { profile, problems } = validateProfile({
      title: 5,
      bundles: "some",
      regions: {
        menubar: { items: 3 },
        nowhere: null,
        header: { items: ["ok", 7] },
      },
      adjust: [
        { region: "header", op: "explode" },
        { region: "x", op: "remove", match: "a" },
      ],
      canvas: { rulers: "no" },
      documentSizePt: [0, 10],
      typo: true,
    });
    expect(profile).toEqual({
      regions: { header: { items: ["ok"] } },
      adjust: [],
      canvas: {},
    });
    const paths = problems.map((p) => p.path).sort();
    expect(paths).toEqual(
      [
        "adjust[0]",
        "adjust[1]",
        "bundles",
        "canvas.rulers",
        "documentSizePt",
        "regions.header.items[1]",
        "regions.menubar",
        "regions.nowhere",
        "title",
        "typo",
      ].sort(),
    );
  });

  test("a non-object is an empty profile with one problem", () => {
    expect(validateProfile("full")).toEqual({
      profile: {},
      problems: [{ path: "", message: "a profile is an object; ignored" }],
    });
  });
});

describe("feature switches in a profile", () => {
  test("merge layer by layer; a later key overrides", () => {
    const { profile } = resolveProfile(
      {
        extends: "a",
        features: { "chrome:rulers": true, "panel:paged.layers": false },
      },
      {
        a: {
          features: { "chrome:rulers": false, "command:paged.object.*": false },
        },
      },
    );
    expect(profile.features).toEqual({
      "chrome:rulers": true,
      "command:paged.object.*": false,
      "panel:paged.layers": false,
    });
  });

  test("the shape check keeps feature ids with a known kind and a boolean", () => {
    const { profile, problems } = validateProfile({
      features: {
        "chrome:rulers": false,
        "nope:x": true,
        "panel:": false,
        "tool:paged.tool.pen": "no",
      },
    });
    expect(profile.features).toEqual({ "chrome:rulers": false });
    expect(problems.map((p) => p.path).sort()).toEqual(
      [
        "features.nope:x",
        "features.panel:",
        "features.tool:paged.tool.pen",
      ].sort(),
    );
  });
});
