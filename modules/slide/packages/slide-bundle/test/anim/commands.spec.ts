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

// Slide ADR 714 — the animations' commands, without the engine: the typed
// twins turn their arguments into the authoring calls (a preset by its
// PowerPoint name and direction label, a slide by address or the active
// one) and refuse what they cannot do; the palette commands open the pane,
// preview the slide and arm the Animation Painter, which paints the next
// shape selected.

import { describe, expect, it } from "bun:test";

import type {
  BundleHost,
  ElementId,
  TypedCommandContribution,
} from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import type { AnimationAuthoring } from "../../src/anim/authoring";
import {
  ANIM_CMD,
  ANIM_MENU,
  ANIM_TYPED,
  animationTypedCommands,
  contributeAnimations,
  type AnimBinding,
} from "../../src/anim/contribute";
import type {
  EffectInfo,
  GalleryPreset,
  TimingEdit,
} from "../../src/anim/model";
import type { SlidesStore } from "../../src/slides-model";

const GALLERY: GalleryPreset[] = [
  {
    class: "entr",
    presetId: 2,
    name: "Fly In",
    subtypes: [
      { subtype: 4, label: "From Bottom" },
      { subtype: 8, label: "From Left" },
    ],
    defaultSubtype: 4,
  },
  { class: "emph", presetId: 8, name: "Spin", subtypes: [], defaultSubtype: 0 },
];

const effect = (name: string, index: number): EffectInfo =>
  ({
    index,
    name,
    presetClass: "entr",
    target: { spid: "4", item: "u4" },
    start: "click",
    delayMs: 0,
    durationMs: 500,
    clickGroup: index + 1,
    paragraph: null,
  }) as EffectInfo;

function fakes() {
  const calls: unknown[] = [];
  const store = {
    list: () => [
      {
        pageId: "p1",
        number: 1,
        sizePt: [960, 540],
        state: { timing: { nodes: [{}] } },
      },
    ],
    activeSlide: () => ({
      pageId: "p1",
      number: 1,
      sizePt: [960, 540],
      state: { timing: { nodes: [{}] } },
    }),
    isDeck: () => true,
  } as unknown as SlidesStore;
  const authoring = {
    presets: async () => GALLERY,
    add: async (pageId: string, el: ElementId, preset: unknown) => {
      calls.push(["add", pageId, el, preset]);
      return { ok: true, timing: { nodes: [] }, index: 0 };
    },
    edit: async (pageId: string, edit: TimingEdit) => {
      calls.push(["edit", pageId, edit]);
      return { ok: true, timing: { nodes: [] } };
    },
    effects: async () => ({ effects: [effect("Fly In", 0)], clicks: 1 }),
    target: async () => ({
      target: { spid: "7", item: "u7" },
      paragraphs: 1,
      hasText: false,
    }),
    paint: async (pageId: string, from: ElementId, to: ElementId) => {
      calls.push(["paint", pageId, from, to]);
      return { ok: true, timing: { nodes: [] } };
    },
  } as unknown as AnimationAuthoring;
  const previews: string[] = [];
  const binding: AnimBinding = {
    authoring,
    store,
    preview: (p) => previews.push(p),
  };
  return { calls, binding, previews, store };
}

const run = async (
  cmds: TypedCommandContribution[],
  id: string,
  args: Record<string, unknown>,
) => {
  const c = cmds.find((x) => x.id === id)!;
  return (c.handler as (ctx: unknown, a: unknown) => Promise<unknown>)(
    {},
    args,
  );
};

describe("the animations' typed commands (slide ADR 714) [plugin-slide.animations]", () => {
  it("add a preset by its name and direction to a shape, on the active slide", async () => {
    covers(
      "command:media.paged.slide.addAnimation",
      "command:media.paged.slide.removeAnimation",
      "command:media.paged.slide.setAnimationTiming",
      "command:media.paged.slide.moveAnimation",
      "command:media.paged.slide.listAnimations",
      "command:media.paged.slide.previewAnimations",
    );
    const f = fakes();
    const cmds = animationTypedCommands(() => f.binding);
    expect(cmds.map((c) => c.id)).toEqual(Object.values(ANIM_TYPED));
    expect(
      await run(cmds, ANIM_TYPED.add, {
        shape: "polygon:u4",
        effect: "fly in",
        direction: "From Left",
        start: "after",
      }),
    ).toEqual({ index: 0 });
    expect(f.calls[0]).toEqual([
      "add",
      "p1",
      { kind: "polygon", id: "u4" },
      {
        presetClass: "entr",
        presetId: 2,
        presetSubtype: 8,
        start: "after",
        durationMs: undefined,
        delayMs: undefined,
        byParagraph: undefined,
      },
    ]);
    await expect(
      run(cmds, ANIM_TYPED.add, {
        shape: "u4",
        effect: "Fly In",
        direction: "Sideways",
      }),
    ).rejects.toThrow(/no direction Sideways/);
    await expect(
      run(cmds, ANIM_TYPED.add, { shape: "u4", effect: "Nope" }),
    ).rejects.toThrow(/no effect Nope/);
    await expect(run(cmds, ANIM_TYPED.list, { slide: "p9" })).rejects.toThrow(
      /no slide p9/,
    );
  });

  it("retime, move, remove, list and preview", async () => {
    const f = fakes();
    const cmds = animationTypedCommands(() => f.binding);
    await run(cmds, ANIM_TYPED.timing, {
      slide: "p1",
      index: 0,
      durationMs: 1500,
      repeat: "indefinite",
      rewind: true,
      trigger: "polygon:u7",
    });
    expect(f.calls.at(-1)).toEqual([
      "edit",
      "p1",
      {
        kind: "timing",
        index: 0,
        durationMs: 1500,
        repeat: "indefinite",
        rewindWhenDone: true,
        trigger: { spid: "7", item: "u7" },
      },
    ]);
    await run(cmds, ANIM_TYPED.timing, { index: 0, trigger: "" });
    expect((f.calls.at(-1) as unknown[])[2]).toEqual({
      kind: "timing",
      index: 0,
      trigger: null,
    });
    await run(cmds, ANIM_TYPED.move, { from: 1, to: 0 });
    expect((f.calls.at(-1) as unknown[])[2]).toEqual({
      kind: "move",
      from: 1,
      to: 0,
    });
    await run(cmds, ANIM_TYPED.remove, { index: 0 });
    expect((f.calls.at(-1) as unknown[])[2]).toEqual({
      kind: "remove",
      index: 0,
    });
    expect(await run(cmds, ANIM_TYPED.list, {})).toEqual({
      clicks: 1,
      effects: [
        {
          index: 0,
          name: "Fly In",
          presetClass: "entr",
          shape: "u4",
          start: "click",
          delayMs: 0,
          durationMs: 500,
          click: 1,
          paragraph: -1,
        },
      ],
    });
    await run(cmds, ANIM_TYPED.preview, {});
    expect(f.previews).toEqual(["p1"]);
    // Without a deck, the commands say so.
    const none = animationTypedCommands(() => null);
    await expect(run(none, ANIM_TYPED.list, {})).rejects.toThrow(/unavailable/);
  });
});

describe("the animations' palette commands (slide ADR 714) [plugin-slide.animations]", () => {
  it("register with a menu entry each; the painter paints the next shape selected", async () => {
    covers(
      "command:media.paged.slide.command.animationPane",
      "command:media.paged.slide.command.previewAnimations",
      "command:media.paged.slide.command.animationPainter",
    );
    const commands = new Map<
      string,
      { handler: () => unknown; when?: () => boolean }
    >();
    const menus: { path: string; command: string }[] = [];
    const opened: string[] = [];
    let selection: ElementId[] = [{ kind: "polygon", id: "u4" } as ElementId];
    const listeners = new Set<(ids: ElementId[]) => void>();
    const host = {
      supports: (f: string) =>
        f === "contribute.command@1" || f === "shell.openPanel@1",
      log: { info() {}, warn() {} },
      selection: {
        get: () => selection,
        onDidChange: (l: (ids: ElementId[]) => void) => {
          listeners.add(l);
          return { dispose: () => listeners.delete(l) };
        },
      },
      shell: { openPanel: (id: string) => opened.push(id) },
      contribute: {
        command: (c: {
          id: string;
          handler: () => unknown;
          when?: () => boolean;
        }) => {
          commands.set(c.id, c);
          return { dispose: () => commands.delete(c.id) };
        },
        menu: (m: { path: string; command: string }) => {
          menus.push(m);
          return { dispose: () => menus.splice(menus.indexOf(m), 1) };
        },
      },
    } as unknown as BundleHost;
    const f = fakes();
    const painted: unknown[] = [];
    const engine = async () => {
      throw new Error("no engine here");
    };
    const h = contributeAnimations(host, f.store, engine, {
      panel: false,
      overlay: false,
    });
    expect([...commands.keys()]).toEqual(Object.values(ANIM_CMD));
    expect(menus.map((m) => m.path)).toEqual(ANIM_MENU.map(([p]) => p));
    commands.get(ANIM_CMD.pane)!.handler();
    expect(opened).toEqual(["media.paged.slide.panel.animations"]);
    // Without the pane (no panel door) its command is not offered.
    expect(commands.get(ANIM_CMD.pane)!.when!()).toBe(false);
    expect(commands.get(ANIM_CMD.painter)!.when!()).toBe(true);
    // Armed with u4; selecting u9 paints it (through the authoring the
    // handle binds).
    (h.binding.authoring as unknown as { paint: unknown }).paint = async (
      ...a: unknown[]
    ) => {
      painted.push(a);
      return { ok: true };
    };
    commands.get(ANIM_CMD.painter)!.handler();
    selection = [{ kind: "polygon", id: "u9" } as ElementId];
    for (const l of listeners) l(selection);
    await Promise.resolve();
    expect(painted).toEqual([
      ["p1", { kind: "polygon", id: "u4" }, { kind: "polygon", id: "u9" }],
    ]);
    h.dispose();
    expect(commands.size).toBe(0);
    expect(menus).toEqual([]);
  });
});
