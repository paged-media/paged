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

// Animations in the editor (slide ADR 714): the Animations pane, Preview on
// the canvas, the Animation Painter, their palette commands and menu
// entries, and the typed twins (ADR 323) a script, the CLI or an agent
// uses: add, remove, retime, move and list a slide's animations, preview
// them.

import type {
  BundleHost,
  Disposable,
  ElementId,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";
import { parseAddress, toElementId } from "@paged-media/plugin-sdk";
import { t } from "@paged-media/strings";

import type { SlideEngine } from "../engine.js";
import { ANIM, ANIM_MODEL } from "../messages.js";
import type { SlidesStore } from "../slides-model.js";
import { AnimationAuthoring } from "./authoring.js";
import type { EffectStart } from "./model.js";
import { ANIMATIONS_PANEL_ID, makeAnimationsPanel } from "./pane.js";
import { PreviewModel, previewOverlay } from "./preview.js";
import { MotionPathModel, motionPathOverlay } from "./motion-path.js";
import { idOf } from "./shapes.js";

const PREFIX = "media.paged.slide";
export const ANIM_CMD = {
  pane: `${PREFIX}.command.animationPane`,
  preview: `${PREFIX}.command.previewAnimations`,
  painter: `${PREFIX}.command.animationPainter`,
} as const;

/** The typed twins (ADR 323). */
export const ANIM_TYPED = {
  add: `${PREFIX}.addAnimation`,
  remove: `${PREFIX}.removeAnimation`,
  timing: `${PREFIX}.setAnimationTiming`,
  move: `${PREFIX}.moveAnimation`,
  list: `${PREFIX}.listAnimations`,
  preview: `${PREFIX}.previewAnimations`,
} as const;

/** `[path, command, group, order]`: Plugins ▸ Animations. */
export const ANIM_MENU: [string, string, string, number][] = [
  ["Animations/Animation Pane", ANIM_CMD.pane, "animations", 10],
  ["Animations/Preview Animations", ANIM_CMD.preview, "animations", 20],
  ["Animations/Animation Painter", ANIM_CMD.painter, "animations", 30],
];

const SLIDE_REF = { kind: "ref", to: "plugin:media.paged.slide/slide" };
const num = (optional = false) => ({
  kind: "number",
  ...(optional ? { optional } : {}),
});
const text = (optional = false) => ({
  kind: "text",
  ...(optional ? { optional } : {}),
});
const struct = (fields: Record<string, unknown>) =>
  ({ kind: "struct", fields }) as unknown as ValueType;
const EMPTY = struct({});

/** The page a slide reference names (a slide address, a page address or a
 *  bare page id), else the active slide's. */
function pageOf(ref: string | undefined, store: SlidesStore): string {
  if (!ref) {
    const a = store.activeSlide();
    if (!a) throw new Error("unavailable: no slide is active");
    return a.pageId;
  }
  const a = parseAddress(ref) as {
    kind?: string;
    id?: string;
    objectKind?: string;
  } | null;
  const id = a && "id" in a && typeof a.id === "string" ? a.id : ref;
  if (!store.list().some((s) => s.pageId === id))
    throw new Error(`unknownAddress: no slide ${ref}`);
  return id;
}

/** An element address (`polygon:u12`) or bare id as an ElementId. */
function elementOf(ref: string): ElementId {
  const a = parseAddress(ref);
  const id = a ? toElementId(a) : null;
  if (id) return id;
  return { kind: "polygon", id: ref } as ElementId;
}

/** Everything the typed twins need, bound once the store exists. */
export interface AnimBinding {
  authoring: AnimationAuthoring;
  store: SlidesStore;
  preview(pageId: string): void;
}

export function animationTypedCommands(
  binding: () => AnimBinding | null,
): TypedCommandContribution[] {
  const need = () => {
    const b = binding();
    if (!b) throw new Error("unavailable: no slide deck is open");
    return b;
  };
  const ok = async (p: Promise<{ ok: boolean; reason?: string }>) => {
    const out = await p;
    if (!out.ok) throw new Error(`failed: ${out.reason}`);
  };
  const add: TypedCommandContribution<
    {
      slide?: string;
      shape: string;
      effect?: string;
      presetClass?: string;
      presetId?: number;
      direction?: string;
      start?: string;
      durationMs?: number;
      delayMs?: number;
      byParagraph?: boolean;
    },
    { index: number }
  > = {
    id: ANIM_TYPED.add,
    title: t(ANIM_MODEL.addAnimation),
    args: struct({
      slide: { ...SLIDE_REF, optional: true },
      shape: text(),
      effect: text(true),
      presetClass: text(true),
      presetId: num(true),
      direction: text(true),
      start: text(true),
      durationMs: num(true),
      delayMs: num(true),
      byParagraph: { kind: "bool", optional: true },
    }),
    result: struct({ index: num() }),
    async handler(_ctx, args) {
      const b = need();
      const pageId = pageOf(args.slide, b.store);
      const gallery = await b.authoring.presets();
      const name = args.effect?.toLowerCase();
      const preset = gallery.find((g) =>
        name
          ? g.name.toLowerCase() === name &&
            (!args.presetClass || g.class === args.presetClass)
          : g.class === args.presetClass && g.presetId === args.presetId,
      );
      if (!preset)
        throw new Error(
          `failed: no effect ${args.effect ?? `${args.presetClass} ${args.presetId}`}`,
        );
      const dir = args.direction?.toLowerCase();
      const subtype = dir
        ? preset.subtypes.find((s) => s.label.toLowerCase() === dir)?.subtype
        : preset.defaultSubtype;
      if (dir && subtype === undefined)
        throw new Error(
          `failed: ${preset.name} has no direction ${args.direction}`,
        );
      const out = await b.authoring.add(pageId, elementOf(args.shape), {
        presetClass: preset.class,
        presetId: preset.presetId,
        presetSubtype: subtype,
        start: args.start as EffectStart | undefined,
        durationMs: args.durationMs,
        delayMs: args.delayMs,
        byParagraph: args.byParagraph,
      });
      if (!out.ok) throw new Error(`failed: ${out.reason}`);
      return { index: out.index ?? 0 };
    },
  };
  const remove: TypedCommandContribution<
    { slide?: string; index: number },
    Record<string, never>
  > = {
    id: ANIM_TYPED.remove,
    title: t(ANIM_MODEL.removeAnimation),
    args: struct({ slide: { ...SLIDE_REF, optional: true }, index: num() }),
    result: EMPTY,
    async handler(_ctx, args) {
      const b = need();
      await ok(
        b.authoring.edit(pageOf(args.slide, b.store), {
          kind: "remove",
          index: args.index,
        }),
      );
      return {};
    },
  };
  const timing: TypedCommandContribution<
    {
      slide?: string;
      index: number;
      start?: string;
      durationMs?: number;
      delayMs?: number;
      repeat?: string;
      rewind?: boolean;
      trigger?: string;
    },
    Record<string, never>
  > = {
    id: ANIM_TYPED.timing,
    title: t(ANIM_MODEL.setAnimationTiming),
    args: struct({
      slide: { ...SLIDE_REF, optional: true },
      index: num(),
      start: text(true),
      durationMs: num(true),
      delayMs: num(true),
      repeat: text(true),
      rewind: { kind: "bool", optional: true },
      trigger: text(true),
    }),
    result: EMPTY,
    async handler(_ctx, args) {
      const b = need();
      const pageId = pageOf(args.slide, b.store);
      let trigger = undefined;
      if (args.trigger !== undefined) {
        trigger =
          args.trigger === ""
            ? null
            : (await b.authoring.target(pageId, elementOf(args.trigger)))
                .target;
      }
      await ok(
        b.authoring.edit(pageId, {
          kind: "timing",
          index: args.index,
          ...(args.start ? { start: args.start as EffectStart } : {}),
          ...(args.durationMs !== undefined
            ? { durationMs: args.durationMs }
            : {}),
          ...(args.delayMs !== undefined ? { delayMs: args.delayMs } : {}),
          ...(args.repeat !== undefined
            ? {
                repeat:
                  args.repeat === ""
                    ? null
                    : args.repeat === "indefinite"
                      ? "indefinite"
                      : Number(args.repeat),
              }
            : {}),
          // PowerPoint's Rewind: back to as it was when done playing.
          ...(args.rewind !== undefined ? { rewindWhenDone: args.rewind } : {}),
          ...(trigger !== undefined ? { trigger } : {}),
        }),
      );
      return {};
    },
  };
  const move: TypedCommandContribution<
    { slide?: string; from: number; to: number },
    Record<string, never>
  > = {
    id: ANIM_TYPED.move,
    title: t(ANIM_MODEL.moveAnimation),
    args: struct({
      slide: { ...SLIDE_REF, optional: true },
      from: num(),
      to: num(),
    }),
    result: EMPTY,
    async handler(_ctx, args) {
      const b = need();
      await ok(
        b.authoring.edit(pageOf(args.slide, b.store), {
          kind: "move",
          from: args.from,
          to: args.to,
        }),
      );
      return {};
    },
  };
  const list: TypedCommandContribution<
    { slide?: string },
    {
      clicks: number;
      effects: {
        index: number;
        name: string;
        presetClass: string;
        shape: string;
        start: string;
        delayMs: number;
        durationMs: number;
        click: number;
        paragraph: number;
      }[];
    }
  > = {
    id: ANIM_TYPED.list,
    title: t(ANIM_MODEL.listAnimations),
    args: struct({ slide: { ...SLIDE_REF, optional: true } }),
    result: struct({
      clicks: num(),
      effects: {
        kind: "list",
        of: struct({
          index: num(),
          name: text(),
          presetClass: text(),
          shape: text(),
          start: text(),
          delayMs: num(),
          durationMs: num(),
          click: num(),
          paragraph: num(),
        }),
      },
    }),
    async handler(_ctx, args) {
      const b = need();
      const l = await b.authoring.effects(pageOf(args.slide, b.store));
      return {
        clicks: l.clicks,
        effects: l.effects.map((e) => ({
          index: e.index,
          name: e.name,
          presetClass: e.presetClass,
          shape: e.target.item ?? e.target.key ?? e.target.spid,
          start: e.start,
          delayMs: e.delayMs,
          durationMs: e.durationMs,
          click: e.clickGroup,
          paragraph: e.paragraph ?? -1,
        })),
      };
    },
  };
  const preview: TypedCommandContribution<
    { slide?: string },
    Record<string, never>
  > = {
    id: ANIM_TYPED.preview,
    title: t(ANIM_MODEL.previewAnimations),
    args: struct({ slide: { ...SLIDE_REF, optional: true } }),
    result: EMPTY,
    async handler(_ctx, args) {
      const b = need();
      b.preview(pageOf(args.slide, b.store));
      return {};
    },
  };
  return [
    add,
    remove,
    timing,
    move,
    list,
    preview,
  ] as unknown as TypedCommandContribution[];
}

export interface AnimHandle extends Disposable {
  binding: AnimBinding;
  ids: ReadonlySet<string>;
}

/** Register the Animations pane, the preview overlay, the painter and the
 *  palette commands on `host`. */
export function contributeAnimations(
  host: BundleHost,
  store: SlidesStore,
  engine: () => Promise<SlideEngine>,
  opts: { panel: boolean; overlay: boolean },
): AnimHandle {
  const handles: Disposable[] = [];
  const ids = new Set<string>();
  const authoring = new AnimationAuthoring(host, store, engine);
  const preview = new PreviewModel();
  const log = (why: string) => host.log.info(`paged.slide animations: ${why}`);

  // ---- the Animation Painter: armed with a shape, the next shape
  // selected on the same slide gets its effects (the painter command
  // again disarms it).
  let painter: { pageId: string; from: ElementId } | null = null;
  const arm = (pageId: string, from: ElementId) => {
    painter = { pageId, from };
    host.log.info(t(ANIM.painterArmed));
  };
  if (typeof host.selection?.onDidChange === "function")
    handles.push(
      host.selection.onDidChange((sel) => {
        const p = painter;
        if (!p) return;
        // An empty selection on the way to the next one (a click selects by
        // clearing first) keeps the painter armed; the command again or a
        // painted shape disarms it.
        const to = sel[0];
        if (!to) return;
        if (idOf(to) === idOf(p.from)) return;
        painter = null;
        void authoring.paint(p.pageId, p.from, to).then((out) => {
          if (!out.ok) log(`the painter could not paint (${out.reason})`);
        });
      }),
    );

  const startPreview = (pageId: string) => {
    if (!opts.overlay) {
      log("this host shows no overlays; the preview needs one");
      return;
    }
    preview.start(pageId);
  };

  // The picked effect's motion path on the canvas (slide ADR 714,
  // amendment 2026-10-30).
  const motion = opts.overlay
    ? new MotionPathModel(
        host,
        engine,
        authoring,
        (pageId) =>
          store.list().find((s) => s.pageId === pageId)?.sizePt ?? null,
      )
    : null;
  if (opts.panel) {
    handles.push(
      host.contribute.panel({
        id: ANIMATIONS_PANEL_ID,
        title: t(ANIM.title),
        component: makeAnimationsPanel(host, store, {
          authoring,
          preview: startPreview,
          painter: arm,
          motionPath: (pageId, effect) => void motion?.show(pageId, effect),
        }),
        defaultDock: "right",
        // A star with motion lines.
        iconSvg:
          '<path d="M14 4l1.6 3.4 3.7.5-2.7 2.6.7 3.7-3.3-1.8-3.3 1.8.7-3.7-2.7-2.6 3.7-.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
          '<path d="M3 15h6M5 18.5h6M3 22h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      }),
    );
  }
  if (opts.overlay) {
    handles.push(
      host.contribute.overlay(previewOverlay(host, engine, store, preview)),
    );
    if (motion) {
      handles.push(host.contribute.overlay(motionPathOverlay(motion)));
      handles.push(motion);
    }
  }

  if (host.supports("contribute.command@1")) {
    const deckSlide = () => (store.isDeck() ? store.activeSlide() : null);
    const titles: Record<string, string> = {
      [ANIM_CMD.pane]: t(ANIM.animationPane),
      [ANIM_CMD.preview]: t(ANIM.previewAnimations),
      [ANIM_CMD.painter]: t(ANIM.animationPainter),
    };
    const run: Record<string, () => void> = {
      [ANIM_CMD.pane]: () => {
        if (host.supports("shell.openPanel@1"))
          host.shell.openPanel(ANIMATIONS_PANEL_ID);
      },
      [ANIM_CMD.preview]: () => {
        const s = deckSlide();
        if (s) startPreview(s.pageId);
      },
      [ANIM_CMD.painter]: () => {
        const s = deckSlide();
        const from = host.selection.get()[0];
        if (painter) painter = null;
        else if (s && from) arm(s.pageId, from);
        else log("select a shape with animations first");
      },
    };
    const when: Record<string, () => boolean> = {
      [ANIM_CMD.pane]: () => !!deckSlide() && opts.panel,
      [ANIM_CMD.preview]: () => !!deckSlide()?.state.timing && opts.overlay,
      [ANIM_CMD.painter]: () =>
        !!deckSlide() && host.selection.get().length > 0,
    };
    for (const id of Object.values(ANIM_CMD)) {
      ids.add(id);
      handles.push(
        host.contribute.command({
          id,
          title: titles[id],
          category: "Slide",
          when: when[id],
          handler: () => run[id](),
        }),
      );
    }
    for (const [path, command, group, order] of ANIM_MENU)
      handles.push(host.contribute.menu({ path, command, group, order }));
  }

  return {
    binding: { authoring, store, preview: startPreview },
    ids,
    dispose() {
      for (const h of handles.splice(0).reverse()) h.dispose();
      ids.clear();
    },
  };
}
