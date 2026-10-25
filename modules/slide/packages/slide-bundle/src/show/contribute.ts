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

// Slide Show, Presenter View, Rehearse Timings and the Slide Sorter as the
// editor offers them (slide ADR 716): one presentation (extensions ADR 345)
// that draws a single-screen show, a presenter console or an audience
// window by the role the host gives it; the palette commands with their
// typed twins (ADR 323); F5, Shift+F5 and Alt+F5; the Slide Show menu and
// View ▸ Slide Sorter (a module view in place of the canvas).

import type {
  BundleHost,
  Disposable,
  MutationInput,
  PresentationContext,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";
import { t } from "@paged-media/strings";

import type { ImportReport } from "../engine.js";
import { SHOW } from "../messages.js";
import {
  setStateMutation,
  type Slide,
  type SlidesStore,
} from "../slides-model.js";
import { createFrameSource } from "./frames.js";
import { mountConsole } from "./presenter.js";
import type { ShowSlide } from "./show-model.js";
import { mountAudience, mountShow, ShowController } from "./slide-show.js";

export const SHOW_PRESENTATION = "media.paged.slide.show";
export const SORTER_VIEW = "media.paged.slide.view.sorter";

const PREFIX = "media.paged.slide.command";
export const SHOW_CMD = {
  fromBeginning: `${PREFIX}.slideShowFromBeginning`,
  fromCurrent: `${PREFIX}.slideShowFromCurrent`,
  presenterView: `${PREFIX}.presenterView`,
  rehearseTimings: `${PREFIX}.rehearseTimings`,
  slideSorter: `${PREFIX}.slideSorter`,
} as const;

/** PowerPoint's keys: F5 from the beginning, Shift+F5 from the current
 *  slide, Alt+F5 the presenter view. */
export const SHOW_KEYBINDINGS = [
  ["f5", SHOW_CMD.fromBeginning],
  ["shift+f5", SHOW_CMD.fromCurrent],
  ["alt+f5", SHOW_CMD.presenterView],
] as const;

/** `[path, command, group, order]`: the Slide Show menu (folded into
 *  Plugins ▸ Slide Show by the bar) and View ▸ Slide Sorter. */
export const SHOW_MENU: [string, string, string, number][] = [
  ["Slide Show/From Beginning", SHOW_CMD.fromBeginning, "start", 10],
  ["Slide Show/From Current Slide", SHOW_CMD.fromCurrent, "start", 20],
  ["Slide Show/Presenter View", SHOW_CMD.presenterView, "start", 30],
  ["Slide Show/Rehearse Timings", SHOW_CMD.rehearseTimings, "setup", 10],
  ["View/Slide Sorter", SHOW_CMD.slideSorter, "views", 90],
];

/** What a show is asked to be (the presentation's options). */
export interface ShowOptions {
  /** Start at this slide (an index into the deck); absent, the first
   *  slide shown. */
  from?: number;
  presenter?: boolean;
  rehearse?: boolean;
  loop?: boolean;
}

/** The deck's slides as the show plays them: hidden flags, notes, the
 *  transition INTO each slide and its automatic advance (the page label's,
 *  else the deck's own as the import read it). */
export function showSlides(
  slides: readonly Slide[],
  report: ImportReport | null,
): ShowSlide[] {
  const byPart = new Map(report?.slides.map((s) => [s.part, s]) ?? []);
  return slides.map((s) => {
    const tr = s.state.transition;
    const fromReport = s.state.part
      ? byPart.get(s.state.part)?.transition
      : undefined;
    const after =
      tr?.advanceAfterMs !== undefined
        ? tr.advanceAfterMs
        : (fromReport?.advance_after_ms ?? null);
    return {
      pageId: s.pageId,
      number: s.number,
      hidden: s.state.hidden === true,
      advanceAfterMs: typeof after === "number" && after >= 0 ? after : null,
      transition: tr
        ? {
            kind: tr.kind ?? null,
            dir: tr.dir ?? null,
            speed: tr.speed ?? null,
            durationMs: tr.durationMs ?? null,
          }
        : null,
      notes: s.state.notes ?? "",
      sizePt: s.sizePt,
    };
  });
}

/** Rehearsed timings as one batch (one undo step): each timed slide
 *  advances after the time spent on it, rounded to 10 ms, and still on a
 *  click. Null when nothing was timed. */
export function timingsMutation(
  slides: readonly Slide[],
  timings: ReadonlyMap<string, number>,
): MutationInput | null {
  const ops: MutationInput[] = [];
  for (const s of slides) {
    const ms = timings.get(s.pageId);
    if (ms === undefined) continue;
    ops.push(
      setStateMutation(s.pageId, {
        ...s.state,
        transition: {
          ...(s.state.transition ?? {}),
          advanceOnClick: s.state.transition?.advanceOnClick ?? true,
          advanceAfterMs: Math.round(ms / 10) * 10,
        },
      }),
    );
  }
  if (ops.length === 0) return null;
  return { op: "batch", args: { ops } } as MutationInput;
}

export interface ShowDeps {
  store: SlidesStore;
  /** The import report (the deck's own timings), if the deck kept one. */
  readReport(): Promise<ImportReport | null>;
}

const NO_ARGS: ValueType = { kind: "struct", fields: {} } as ValueType;
const PRESENTED: ValueType = {
  kind: "struct",
  fields: { presented: { kind: "bool" } },
} as ValueType;

export interface ShowHandle extends Disposable {
  /** The command ids this host got (the menu offers only those). */
  ids: ReadonlySet<string>;
  /** The typed twins of the commands (ADR 323), for the object model. */
  typedCommands: readonly TypedCommandContribution[];
}

/** The typed twins only, without a host (the object model registers them
 *  before the store exists; `run` is bound once the show is contributed). */
export function showTypedCommands(
  run: (id: string) => Promise<boolean>,
): TypedCommandContribution[] {
  const titles: Record<string, string> = {
    [SHOW_CMD.fromBeginning]: t(SHOW.fromBeginning),
    [SHOW_CMD.fromCurrent]: t(SHOW.fromCurrent),
    [SHOW_CMD.presenterView]: t(SHOW.presenterView),
    [SHOW_CMD.rehearseTimings]: t(SHOW.rehearseTimings),
    [SHOW_CMD.slideSorter]: t(SHOW.slideSorter),
  };
  return Object.values(SHOW_CMD).map(
    (id) =>
      ({
        id,
        title: titles[id],
        args: NO_ARGS,
        result: PRESENTED,
        handler: async () => {
          const presented = await run(id);
          if (!presented)
            throw new Error(
              `unavailable: ${id} needs an open deck and a host that presents`,
            );
          return { presented };
        },
      }) as TypedCommandContribution,
  );
}

/** Register the show on `host`. */
export function contributeShow(
  host: BundleHost,
  deps: ShowDeps,
  sorter: (() => Disposable | null) | null,
): ShowHandle & { run(id: string): Promise<boolean> } {
  const handles: Disposable[] = [];
  const ids = new Set<string>();
  const store = deps.store;
  const log = (why: string) => host.log.info(`paged.slide show: ${why}`);
  const presenting = () =>
    host.supports("shell.present@1") && host.shell.presentation() !== null;
  const deckOpen = () => store.isDeck() && store.list().length > 0;
  const caretActive = () =>
    host.supports("text.caret@1") && host.text.caret() !== null;

  // ---- the presentation: one render, three roles.
  if (host.supports("contribute.presentation@1")) {
    handles.push(
      host.contribute.presentation({
        id: SHOW_PRESENTATION,
        title: t(SHOW.title),
        render: (el, ctx) => renderShow(el, ctx),
      }),
    );
  }

  /** The slides as the show needs them, read when it starts. */
  let slides: ShowSlide[] = [];

  function renderShow(el: HTMLElement, ctx: PresentationContext): () => void {
    const opts = ctx.options as ShowOptions;
    const frames = createFrameSource(host);
    if (ctx.role === "audience") {
      const off = mountAudience(el, ctx.window, ctx.channel, frames);
      return () => {
        off();
        frames.dispose();
      };
    }
    const ctl = new ShowController({
      slides,
      from: opts.from,
      loop: opts.loop,
      rehearse: opts.rehearse,
    });
    const surface = {
      frames,
      thumbnail: (pageId: string) => store.thumbnail(pageId),
      exit: () => ctx.exit(),
    };
    const off =
      ctx.role === "console" || opts.presenter
        ? mountConsole(el, ctx.window, ctl, {
            ...surface,
            subscribeThumbnails: (fn) => store.subscribe(fn),
            channel: ctx.channel,
            audience: ctx.role === "console" && ctx.target === "secondary",
          })
        : mountShow(el, ctx.window, ctl, surface);
    return () => {
      const s = ctl.state();
      const endedOn = s.slides[s.index]?.pageId ?? null;
      const timings = ctl.rehearsed();
      off();
      ctl.dispose();
      frames.dispose();
      // Back in the editor on the slide the show ended on.
      if (endedOn && host.supports("viewport.pages@1"))
        void host.viewport.goToPage(endedOn);
      if (ctl.rehearse && timings.size > 0) {
        const m = timingsMutation(store.list(), timings);
        if (m)
          void host.document.mutate(m).then((out) => {
            if (!out.applied)
              log(`the timings were refused (${String(out.error)})`);
          });
      }
    };
  }

  async function start(opts: ShowOptions, target: "screen" | "secondary") {
    if (!deckOpen()) {
      log("the open document is not a slide deck");
      return false;
    }
    if (!host.supports("shell.present@1")) {
      log("this host cannot present");
      return false;
    }
    slides = showSlides(store.list(), await deps.readReport());
    const out = await host.shell.present({
      id: SHOW_PRESENTATION,
      target,
      options: { ...opts },
    });
    if (!out.presented) log(`not presented: ${out.reason ?? "refused"}`);
    else if (out.reason) log(out.reason);
    return out.presented;
  }

  const activeIndex = () => {
    const a = store.activeSlide();
    return a ? a.number - 1 : 0;
  };

  async function run(id: string): Promise<boolean> {
    switch (id) {
      case SHOW_CMD.fromBeginning:
        return start({}, "screen");
      case SHOW_CMD.fromCurrent:
        return start({ from: activeIndex() }, "screen");
      case SHOW_CMD.presenterView:
        return start({ from: activeIndex(), presenter: true }, "secondary");
      case SHOW_CMD.rehearseTimings:
        return start({ rehearse: true }, "screen");
      case SHOW_CMD.slideSorter: {
        if (!host.supports("shell.views@1")) return false;
        const shown = host.shell.activeView() === SORTER_VIEW;
        host.shell.showView(shown ? null : SORTER_VIEW);
        return true;
      }
    }
    return false;
  }

  // ---- the sorter view
  if (sorter) {
    const d = sorter();
    if (d) handles.push(d);
  }

  // ---- palette commands, keys, menu
  if (host.supports("contribute.command@1")) {
    const titles: Record<string, string> = {
      [SHOW_CMD.fromBeginning]: t(SHOW.fromBeginning),
      [SHOW_CMD.fromCurrent]: t(SHOW.fromCurrent),
      [SHOW_CMD.presenterView]: t(SHOW.presenterView),
      [SHOW_CMD.rehearseTimings]: t(SHOW.rehearseTimings),
      [SHOW_CMD.slideSorter]: t(SHOW.slideSorter),
    };
    const canPresent = () =>
      deckOpen() && host.supports("shell.present@1") && !presenting();
    for (const id of Object.values(SHOW_CMD)) {
      if (id === SHOW_CMD.slideSorter && !sorter) continue;
      ids.add(id);
      handles.push(
        host.contribute.command({
          id,
          title: titles[id],
          category: "Slide",
          when: () =>
            id === SHOW_CMD.slideSorter
              ? deckOpen() && host.supports("shell.views@1")
              : canPresent(),
          handler: async () => {
            try {
              await run(id);
            } catch (err) {
              host.log.warn(
                `paged.slide ${id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
        }),
      );
    }
    if (host.supports("contribute.keybinding@1")) {
      for (const [key, command] of SHOW_KEYBINDINGS) {
        if (!ids.has(command)) continue;
        handles.push(
          host.contribute.keybinding({
            key,
            command,
            when: () => !caretActive() && canPresent(),
          }),
        );
      }
    }
    for (const [path, command, group, order] of SHOW_MENU) {
      if (!ids.has(command)) continue;
      handles.push(host.contribute.menu({ path, command, group, order }));
    }
  }

  return {
    ids,
    typedCommands: showTypedCommands(run),
    run,
    dispose() {
      for (const h of handles.splice(0).reverse()) h.dispose();
      ids.clear();
    },
  };
}
