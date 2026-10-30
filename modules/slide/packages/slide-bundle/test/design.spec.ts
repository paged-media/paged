/*
 * This file is part of paged (https://paged.media).
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

// Slide ADRs 713 and 719 without the document engine: the theme state of a
// deck label, the one batch that applies a theme, the missing references
// and their remap, and what the Design commands register. The theme
// arithmetic is the real slide wasm's.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  applyThemeOps,
  contributeDesignCommands,
  DESIGN_CMD,
  DESIGN_MENU,
  DESIGN_TYPED,
  designTypedCommands,
  DesignStore,
  missingThemeReferences,
  remapOp,
  sameLook,
  themeState,
  type DocLists,
} from "../src/design";
import { slideEngine, type ThemeIr } from "../src/engine";

const MANIFEST = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as {
  contributes: {
    commands: string[];
    panels: string[];
    objectModel: { commands: { id: string }[] };
  };
};

const office: ThemeIr = {
  name: "Office",
  colors: [
    ["dk1", "000000"],
    ["lt1", "FFFFFF"],
    ["dk2", "0E2841"],
    ["lt2", "E8E8E8"],
    ["accent1", "156082"],
    ["accent2", "E97132"],
    ["accent3", "196B24"],
    ["accent4", "0F9ED5"],
    ["accent5", "A02B93"],
    ["accent6", "4EA72E"],
    ["hlink", "467886"],
    ["folHlink", "96607D"],
  ],
  major: "Aptos Display",
  minor: "Aptos",
};

const lists = (): DocLists => ({
  swatch: [
    { id: "Swatch/None", name: "None" },
    { id: "Color/R102030", name: "R102030" },
    ...[
      "dk1",
      "lt1",
      "dk2",
      "lt2",
      "accent1",
      "accent2",
      "accent3",
      "accent4",
      "accent5",
      "accent6",
      "hlink",
      "folHlink",
    ].map((s) => ({ id: `Color/${s}`, name: s })),
    {
      id: "Color/accent1 lumMod60000 lumOff40000",
      name: "Accent 1, Lighter 40%",
    },
  ],
  paragraph: [
    { id: "ParagraphStyle/Title", name: "Title" },
    { id: "ParagraphStyle/Body", name: "Body" },
    { id: "ParagraphStyle/Body L1", name: "Body L1" },
  ],
  character: [
    { id: "CharacterStyle/Headings font", name: "Headings font" },
    { id: "CharacterStyle/Body font", name: "Body font" },
  ],
});

const label = () => ({ deck: { name: "d" }, theme: office, deckTheme: office });

describe("[plugin-slide.import-native] the theme as document resources", () => {
  it("reads the theme the deck label holds", () => {
    const s = themeState(label());
    expect(s.theme?.name).toBe("Office");
    expect(s.deckTheme?.major).toBe("Aptos Display");
    expect(s.remap).toEqual({});
    expect(themeState(null)).toEqual({
      theme: null,
      deckTheme: null,
      remap: {},
    });
    expect(
      themeState({
        theme: { ...office, remap: { "Color/accent6": "Color/X" } },
      }).remap,
    ).toEqual({ "Color/accent6": "Color/X" });
  });

  it("applies a theme as one batch: every theme swatch, the fonts, the label", async () => {
    const engine = await slideEngine();
    const paper = engine.themeGallery().find((g) => g.id === "paper")!;
    const dark = paper.variants[1]!;
    const ops = applyThemeOps(engine, dark, label(), lists());
    const edits = ops.filter((o) => o.op === "editSwatch") as unknown as {
      args: {
        swatchId: string;
        spec: { value: number[]; space: string; name: string };
      };
    }[];
    // The twelve slots and the tint; never a plain colour or None.
    expect(edits.map((e) => e.args.swatchId)).toHaveLength(13);
    expect(edits.some((e) => e.args.swatchId === "Color/R102030")).toBe(false);
    const lt1 = edits.find((e) => e.args.swatchId === "Color/lt1")!;
    expect(lt1.args.spec).toMatchObject({
      space: "RGB",
      value: [0x1b, 0x1b, 0x1b],
      name: "lt1",
    });
    const fonts = ops.filter((o) => o.op === "setStyleProperty") as unknown as {
      args: { collection: string; styleId: string; value: { value: string } };
    }[];
    expect(fonts.map((f) => [f.args.styleId, f.args.value.value])).toEqual([
      ["ParagraphStyle/Title", "Georgia"],
      ["ParagraphStyle/Body", "Verdana"],
      ["CharacterStyle/Headings font", "Georgia"],
      ["CharacterStyle/Body font", "Verdana"],
    ]);
    const last = ops.at(-1)! as unknown as {
      op: string;
      args: { value: string };
    };
    expect(last.op).toBe("setDocumentMetadata");
    const data = JSON.parse(last.args.value).data;
    expect(data.theme.name).toBe("Paper");
    expect(data.theme.variant).toBe("Dark");
    expect(data.deckTheme.name).toBe("Office");
    expect(sameLook(dark, paper.theme)).toBe(false);
  });

  it("counts the references the document lost and remaps one", async () => {
    const l = lists();
    l.swatch = l.swatch.filter((s) => s.id !== "Color/accent6");
    l.paragraph = l.paragraph.filter((s) => s.id !== "ParagraphStyle/Title");
    const state = themeState(label());
    expect(missingThemeReferences(state, l).map((m) => m.id)).toEqual([
      "Color/accent6",
      "ParagraphStyle/Title",
    ]);
    const op = remapOp(label(), "Color/accent6", "Color/R102030")!;
    const remapped = JSON.parse((op.args as { value: string }).value).data;
    expect(remapped.theme.remap).toEqual({ "Color/accent6": "Color/R102030" });
    expect(
      missingThemeReferences(themeState(remapped), l).map((m) => m.id),
    ).toEqual(["ParagraphStyle/Title"]);
    // The stand-in takes the slot's colour when a theme is applied.
    const engine = await slideEngine();
    const ops = applyThemeOps(engine, office, remapped, l);
    const standIn = ops.find(
      (o) =>
        o.op === "editSwatch" &&
        (o.args as { swatchId: string }).swatchId === "Color/R102030",
    ) as unknown as { args: { spec: { value: number[] } } };
    expect(standIn.args.spec.value).toEqual([0x4e, 0xa7, 0x2e]);
    // The lost style is not written.
    expect(
      ops.some(
        (o) =>
          (o.args as { styleId?: string }).styleId === "ParagraphStyle/Title",
      ),
    ).toBe(false);
  });
});

type Cmd = { id: string; when?: () => boolean; handler: () => Promise<void> };

function fakeHost() {
  const commands = new Map<string, Cmd>();
  const menus: { path: string; command: string }[] = [];
  const mutations: unknown[] = [];
  let env: unknown = { v: 1, data: label() };
  const host = {
    supports: () => true,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    contribute: {
      command: (c: Cmd) => {
        commands.set(c.id, c);
        return { dispose: () => commands.delete(c.id) };
      },
      menu: (m: { path: string; command: string }) => {
        menus.push(m);
        return { dispose: () => menus.splice(menus.indexOf(m), 1) };
      },
    },
    document: {
      onDidChange: () => ({ dispose() {} }),
      onDidOpen: () => ({ dispose() {} }),
      getDocumentMetadata: async () => env,
      collection: async (name: string) => {
        const l = lists();
        const of = (rows: { id: string; name: string }[]) =>
          rows.map((r) => ({ selfId: r.id, name: r.name }));
        if (name === "swatches") return of(l.swatch);
        if (name === "paragraphStyles") return of(l.paragraph);
        return of(l.character);
      },
      mutate: async (m: {
        op: string;
        args: {
          value?: string;
          ops?: { op: string; args: { value: string } }[];
        };
      }) => {
        mutations.push(m);
        const set =
          m.op === "setDocumentMetadata"
            ? (m as { op: string; args: { value: string } })
            : m.args.ops?.find((o) => o.op === "setDocumentMetadata");
        if (set) env = JSON.parse(set.args.value);
        return { applied: true };
      },
    },
  } as unknown as BundleHost;
  return { host, commands, menus, mutations };
}

describe("[plugin-slide.object-model] the Design commands", () => {
  it("registers Design and Browse for Themes with their Design menu entries", () => {
    covers("menu:Design/Themes", "menu:Design/Browse for Themes…");
    const f = fakeHost();
    const store = new DesignStore(f.host, slideEngine);
    const h = contributeDesignCommands(
      f.host,
      { store, openPanel: () => true },
      () => true,
    );
    expect([...f.commands.keys()].sort()).toEqual(
      Object.values(DESIGN_CMD).sort(),
    );
    expect(f.menus.map((m) => m.path)).toEqual(DESIGN_MENU.map(([p]) => p));
    for (const id of Object.values(DESIGN_CMD))
      expect(MANIFEST.contributes.commands).toContain(id);
    expect(MANIFEST.contributes.panels).toContain(
      "media.paged.slide.panel.design",
    );
    h.dispose();
    expect(f.commands.size + f.menus.length).toBe(0);
  });

  it("the typed twins list the themes, apply one in one batch and remap", async () => {
    covers(
      "command:media.paged.slide.command.design",
      "command:media.paged.slide.command.browseThemes",
      "command:media.paged.slide.themes",
      "command:media.paged.slide.applyTheme",
      "command:media.paged.slide.remapThemeReference",
    );
    const f = fakeHost();
    const store = new DesignStore(f.host, slideEngine);
    let raised = 0;
    const cmds = new Map(
      designTypedCommands(f.host, () => ({
        store,
        openPanel: () => {
          raised++;
          return true;
        },
      })).map((c) => [c.id, c]),
    );
    const typed = new Set(
      MANIFEST.contributes.objectModel.commands.map((c) => c.id),
    );
    for (const id of cmds.keys()) expect(typed.has(id)).toBe(true);
    expect([...cmds.keys()].sort()).toEqual(
      [...Object.values(DESIGN_CMD), ...Object.values(DESIGN_TYPED)].sort(),
    );
    const run = (id: string, a: unknown) =>
      (cmds.get(id)!.handler as (c: unknown, a: unknown) => Promise<unknown>)(
        null,
        a,
      );
    expect(await run(DESIGN_CMD.design, {})).toEqual({ presented: true });
    expect(raised).toBe(1);
    const listed = (await run(DESIGN_TYPED.themes, {})) as {
      themes: { id: string; variants: string[] }[];
      current: string;
      missing: string[];
    };
    expect(listed.themes[0]!.id).toBe("deck");
    expect(listed.themes.map((t) => t.id)).toContain("office-2007");
    expect(listed.themes[1]!.variants).toEqual([
      "Original",
      "Dark",
      "Shifted",
      "Muted",
    ]);
    expect(listed.current).toBe("Office");
    expect(listed.missing).toEqual([]);

    expect(
      await run(DESIGN_TYPED.applyTheme, {
        theme: "harbour",
        variant: "Muted",
      }),
    ).toEqual({
      applied: true,
    });
    expect(f.mutations).toHaveLength(1);
    const batch = f.mutations[0] as {
      op: string;
      args: { ops: { op: string }[] };
    };
    expect(batch.op).toBe("batch");
    expect(batch.args.ops.filter((o) => o.op === "editSwatch")).toHaveLength(
      13,
    );
    const after = (await run(DESIGN_TYPED.themes, {})) as {
      current: string;
      variant: string;
    };
    expect([after.current, after.variant]).toEqual(["Harbour", "Muted"]);
    await expect(
      run(DESIGN_TYPED.applyTheme, { theme: "nope" }),
    ).rejects.toThrow(/no theme nope/);

    expect(
      await run(DESIGN_TYPED.remapThemeReference, {
        from: "Color/accent6",
        to: "Color/R102030",
      }),
    ).toEqual({ applied: true });
    const deck = readFileSync(
      new URL("../../../slide-conformance/fixtures/text.pptx", import.meta.url),
    );
    expect(
      await run(DESIGN_CMD.browseThemes, {
        data: Buffer.from(deck).toString("base64"),
      }),
    ).toEqual({ applied: true });
    const browsed = (await run(DESIGN_TYPED.themes, {})) as {
      themes: { id: string }[];
    };
    expect(browsed.themes.at(-1)!.id).toBe("file:1");
    store.dispose();
  });
});
