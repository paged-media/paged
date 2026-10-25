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

// The palette commands of paged.slide: the user's verbs on a deck, for the
// command palette and the menu bar (menu.ts). Before these the deck's only
// front door was File ▸ Open of a .pptx; the typed commands (object-model.ts)
// were reachable from scripts and the CLI, not from the editor's chrome.
//
// Each command is offered only where it applies (`when`): the slide verbs
// while a deck is open and a slide is active, Delete while more than one
// slide is left, Move up / down where the slide has a neighbour. A palette
// or menu invoke carries no payload, so every handler reads the active
// slide itself, and a handler that cannot act LOGS why and does nothing: a
// bare invoke never throws.
//
// New slide and Duplicate slide run the typed commands through
// `host.objects`, so the palette, a script and the Node CLI make the same
// slide (the layout's placeholders, emptied; the copy right after its
// source), each one undo step.

import type {
  BundleHost,
  Disposable,
  MutationInput,
} from "@paged-media/plugin-api";
import { parseAddress } from "@paged-media/plugin-sdk";
import { t } from "@paged-media/strings";

import type { ImportReport } from "./engine.js";
import { COMMANDS } from "./messages.js";
import { DUPLICATE_SLIDE_COMMAND, NEW_SLIDE_COMMAND } from "./object-model.js";
import {
  deleteMutation,
  moveMutation,
  type Slide,
  type SlidesStore,
} from "./slides-model.js";

export const COMMAND_PREFIX = "media.paged.slide.command";
export const CMD = {
  newSlide: `${COMMAND_PREFIX}.newSlide`,
  duplicateSlide: `${COMMAND_PREFIX}.duplicateSlide`,
  deleteSlide: `${COMMAND_PREFIX}.deleteSlide`,
  moveSlideUp: `${COMMAND_PREFIX}.moveSlideUp`,
  moveSlideDown: `${COMMAND_PREFIX}.moveSlideDown`,
  importPptx: `${COMMAND_PREFIX}.importPptx`,
  exportPptx: `${COMMAND_PREFIX}.exportPptx`,
  insertShapes: `${COMMAND_PREFIX}.insertShapes`,
} as const;

/**
 * The slide verbs' keys, each a Cmd chord with its Ctrl twin (the registry
 * has no `mod`). PowerPoint's own where the editor leaves them free: Cmd+Up
 * and Cmd+Down move the slide. Its New slide (Cmd+Shift+N, Ctrl+M) and
 * Duplicate slide (Cmd+D) are the browser's new window and the editor's
 * Place, so New slide is Option+Cmd+N and Duplicate slide adds Shift to
 * it. Delete slide takes Option with Backspace, so the Backspace that
 * deletes the selected object never deletes a slide. None of these chords
 * is bound by the editor (its keybinding test holds them free), and each
 * is offered only where its command applies and no text caret is active,
 * where Cmd+Up and the rest move or edit text.
 */
export const SLIDE_KEYBINDINGS = [
  ["alt+cmd+n", CMD.newSlide],
  ["alt+ctrl+n", CMD.newSlide],
  ["alt+shift+cmd+n", CMD.duplicateSlide],
  ["alt+shift+ctrl+n", CMD.duplicateSlide],
  ["alt+cmd+backspace", CMD.deleteSlide],
  ["alt+ctrl+backspace", CMD.deleteSlide],
  ["cmd+arrowup", CMD.moveSlideUp],
  ["ctrl+arrowup", CMD.moveSlideUp],
  ["cmd+arrowdown", CMD.moveSlideDown],
  ["ctrl+arrowdown", CMD.moveSlideDown],
] as const;

/** The palette category (an identity, labelled through the shell). */
const CATEGORY = "Slide";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** What Open a PowerPoint deck asks the picker for: the importer's types. */
export const PPTX_ACCEPT = [".pptx", ".ppsx", ".potx", PPTX_MIME];

export interface SlideCommandDeps {
  /** The deck's slides and the active one; null on a host without the
   *  page doors, where only the file verbs are contributed. */
  store: SlidesStore | null;
  /** The typed commands are live (`host.objects` routes to them). */
  objectModel: boolean;
  /** The Shapes panel's id, where it is contributed (Insert ▸ Shapes…). */
  shapesPanel?: string;
  /** The importer's path. */
  openDeck(name: string, bytes: Uint8Array): Promise<ImportReport | null>;
  /** The exporter's path; null when there is no deck to write. */
  exportDeck(): Promise<{
    bytes: Uint8Array;
    fileName: string;
    diagnostics: string[];
  } | null>;
}

/** Register the commands; one Disposable drops them all, and `ids` names
 *  the ones this host got (the menu offers only those). */
export function contributeSlideCommands(
  host: BundleHost,
  deps: SlideCommandDeps,
): Disposable & { ids: ReadonlySet<string> } {
  const handles: Disposable[] = [];
  const ids = new Set<string>();
  /** Each registered command's `when`, for its keys. */
  const whens = new Map<string, (state: unknown) => boolean>();
  const command = (c: Parameters<BundleHost["contribute"]["command"]>[0]) => {
    ids.add(c.id);
    const w = c.when;
    whens.set(c.id, typeof w === "function" ? w : () => w === undefined);
    return host.contribute.command(c);
  };
  const log = (verb: string, why: string) =>
    host.log.info(`paged.slide ${verb}: ${why}`);

  /** Run `body`, logging (never throwing) what made it fail. */
  const guarded =
    (verb: string, body: () => Promise<void> | void) => async () => {
      try {
        await body();
      } catch (err) {
        host.log.warn(
          `paged.slide ${verb}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

  handles.push(
    command({
      id: CMD.importPptx,
      title: t(COMMANDS.importPptx),
      category: CATEGORY,
      handler: guarded("importPptx", async () => {
        if (!host.supports("shell.pickFile@1")) {
          log("importPptx", "this host has no file picker");
          return;
        }
        const [file] = await host.shell.pickFile({
          accept: PPTX_ACCEPT,
          multiple: false,
        });
        if (!file) return; // cancelled
        await deps.openDeck(file.name, file.bytes);
      }),
    }),
  );

  const store = deps.store;
  const deckOpen = () => store?.isDeck() ?? false;

  if (host.supports("storage.parts@1")) {
    handles.push(
      command({
        id: CMD.exportPptx,
        title: t(COMMANDS.exportPptx),
        category: CATEGORY,
        // Without the page doors there is no synchronous view of the
        // document, so the command stays offered and its handler decides.
        ...(store ? { when: deckOpen } : {}),
        handler: guarded("exportPptx", async () => {
          if (!host.supports("shell.saveFile@1")) {
            log("exportPptx", "this host has no file saver");
            return;
          }
          // Null: not a deck; exportDeck has said why on the diagnostics.
          const out = await deps.exportDeck();
          if (!out) return;
          const saved = await host.shell.saveFile({
            suggestedName: out.fileName,
            bytes: out.bytes,
            mimeType: PPTX_MIME,
          });
          if (!saved) log("exportPptx", "the host did not save the file");
        }),
      }),
    );
  }

  if (store) {
    const active = (): Slide | null =>
      store.isDeck() ? store.activeSlide() : null;
    const position = () => {
      const slide = active();
      return slide
        ? { slide, index: slide.number - 1, count: store.list().length }
        : null;
    };
    /** The active slide, or null after logging why there is none. */
    const need = (verb: string): Slide | null => {
      if (!store.isDeck()) {
        log(verb, "the open document is not a slide deck");
        return null;
      }
      const slide = store.activeSlide();
      if (!slide) log(verb, "no slide is active");
      return slide;
    };
    const mutate = async (verb: string, m: MutationInput | null) => {
      if (!m) return false;
      const out = await host.document.mutate(m);
      if (!out.applied) log(verb, `the engine refused (${String(out.error)})`);
      return out.applied;
    };
    /** The page order as the document has it now (the store re-reads it
     *  after a change, so it can trail an edit that just landed). */
    const order = async () =>
      (await host.document.collection<{ selfId: string }>("pages")).map(
        (p) => p.selfId,
      );
    const goTo = async (pageId: string | null) => {
      if (pageId && host.supports("viewport.pages@1"))
        await host.viewport.goToPage(pageId);
    };
    /** Run a typed command on the active slide and go to the slide it made. */
    const typed = (verb: string, command: string, args: (s: Slide) => object) =>
      guarded(verb, async () => {
        const slide = need(verb);
        if (!slide) return;
        if (!deps.objectModel || !host.supports("objects@1")) {
          log(verb, "this host has no object model");
          return;
        }
        const out = (await host.objects.invoke(command, args(slide))) as {
          slide?: string;
        } | null;
        const made = out?.slide ? parseAddress(out.slide) : null;
        await goTo(made && "id" in made ? made.id : null);
      });

    handles.push(
      command({
        id: CMD.newSlide,
        title: t(COMMANDS.newSlide),
        category: CATEGORY,
        when: () => active() !== null,
        // After the active slide, from its layout (the typed command's
        // default), as the Slides panel's button makes one.
        handler: typed("newSlide", NEW_SLIDE_COMMAND, (s) => ({
          after: s.pageId,
        })),
      }),
      command({
        id: CMD.duplicateSlide,
        title: t(COMMANDS.duplicateSlide),
        category: CATEGORY,
        when: () => active() !== null,
        handler: typed("duplicateSlide", DUPLICATE_SLIDE_COMMAND, (s) => ({
          slide: s.pageId,
        })),
      }),
      command({
        id: CMD.deleteSlide,
        title: t(COMMANDS.deleteSlide),
        category: CATEGORY,
        // The last slide stays: a deck of none is no document.
        when: () => (position()?.count ?? 0) > 1,
        handler: guarded("deleteSlide", async () => {
          const slide = need("deleteSlide");
          if (!slide) return;
          if ((await order()).length < 2) {
            log("deleteSlide", "the last slide cannot be deleted");
            return;
          }
          await mutate("deleteSlide", deleteMutation(slide.pageId));
        }),
      }),
    );

    const move = (verb: string, by: -1 | 1) =>
      guarded(verb, async () => {
        const slide = need(verb);
        if (!slide) return;
        const now = await order();
        const from = now.indexOf(slide.pageId);
        const to = from + by;
        if (from < 0 || to < 0 || to >= now.length) {
          log(verb, `slide ${slide.number} has no slide to pass`);
          return;
        }
        // The viewport follows the slide to its new place.
        if (await mutate(verb, moveMutation(now, slide.pageId, to)))
          await goTo(slide.pageId);
      });
    handles.push(
      command({
        id: CMD.moveSlideUp,
        title: t(COMMANDS.moveSlideUp),
        category: CATEGORY,
        when: () => (position()?.index ?? 0) > 0,
        handler: move("moveSlideUp", -1),
      }),
      command({
        id: CMD.moveSlideDown,
        title: t(COMMANDS.moveSlideDown),
        category: CATEGORY,
        when: () => {
          const p = position();
          return p !== null && p.index < p.count - 1;
        },
        handler: move("moveSlideDown", 1),
      }),
    );
    // Insert ▸ Shapes…: the Shapes panel, where a click inserts a preset
    // on the active slide (ADR 717).
    if (deps.shapesPanel && host.supports("shell.openPanel@1")) {
      const panel = deps.shapesPanel;
      handles.push(
        command({
          id: CMD.insertShapes,
          title: t(COMMANDS.insertShapes),
          category: CATEGORY,
          when: () => active() !== null,
          handler: guarded("insertShapes", () => host.shell.openPanel(panel)),
        }),
      );
    }
  }

  // The keys of the slide verbs this host got, offered where the command
  // is and no text caret is active.
  if (host.supports("contribute.keybinding@1")) {
    const caretActive = () =>
      host.supports("text.caret@1") && host.text.caret() !== null;
    for (const [key, command] of SLIDE_KEYBINDINGS) {
      const when = whens.get(command);
      if (!when) continue;
      handles.push(
        host.contribute.keybinding({
          key,
          command,
          when: (state) => !caretActive() && when(state),
        }),
      );
    }
  }

  return {
    ids,
    dispose() {
      for (const h of handles.splice(0)) h.dispose();
      ids.clear();
    },
  };
}
