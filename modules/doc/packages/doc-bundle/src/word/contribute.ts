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

// Word inside paged (doc ADR 608): the editing chrome a Word document gets
// in the `wordDocument` context — the Home control-bar group, the
// shortcuts, the status items — and the document context that makes the
// same context apply to a Word document opened as the whole document
// (Open mode), where there is no frame to enter. Open mode and Insert mode
// share the context, so they share every contribution here.

import type { BundleHost } from "@paged-media/plugin-api";
import { t } from "@paged-media/strings";

import { WORD } from "../messages.js";
import {
  runWordCommand,
  WORD_COMMAND,
  WORD_CONTEXT,
  WORD_KEYS,
  type WordCommandName,
  type WordCommandState,
} from "./commands.js";
import { makeHomeGroup } from "./home-group.js";
import {
  makePageStatus,
  makeWordsStatus,
  makeZoomStatus,
} from "./status-items.js";
import { createWordStore, type WordStore } from "./word-state.js";

export interface WordDeps {
  /** The stories that are the open Word document(s), for the word count. */
  docStories(): Promise<string[]>;
  /** Is the open document a Word document opened as the document (its
   *  standalone label)? Asked on every document open. */
  isWordDocument(): Promise<boolean>;
}

/** The command titles, by command name. */
const TITLES: Record<WordCommandName, () => string> = {
  bold: () => t(WORD.bold),
  italic: () => t(WORD.italic),
  underline: () => t(WORD.underline),
  strikethrough: () => t(WORD.strikethrough),
  subscript: () => t(WORD.subscript),
  superscript: () => t(WORD.superscript),
  allCaps: () => t(WORD.allCaps),
  smallCaps: () => t(WORD.smallCaps),
  clearCharacter: () => t(WORD.clearCharacter),
  growFont: () => t(WORD.growFont),
  shrinkFont: () => t(WORD.shrinkFont),
  alignLeft: () => t(WORD.alignLeft),
  alignCenter: () => t(WORD.center),
  alignRight: () => t(WORD.alignRight),
  justify: () => t(WORD.justify),
  spaceBefore: () => t(WORD.spaceBefore),
  increaseIndent: () => t(WORD.increaseIndent),
  decreaseIndent: () => t(WORD.decreaseIndent),
  heading1: () => t(WORD.heading, { level: 1 }),
  heading2: () => t(WORD.heading, { level: 2 }),
  heading3: () => t(WORD.heading, { level: 3 }),
  normal: () => t(WORD.normal),
  bullets: () => t(WORD.bullets),
  numbering: () => t(WORD.numbering),
  listLevelDown: () => t(WORD.listLevelDown),
  listLevelUp: () => t(WORD.listLevelUp),
  copyFormat: () => t(WORD.copyFormat),
  pasteFormat: () => t(WORD.pasteFormat),
  lineSpacing1: () => `${t(WORD.lineSpacing)}: ${t(WORD.single)}`,
  lineSpacing15: () => `${t(WORD.lineSpacing)}: ${t(WORD.oneAndHalf)}`,
  lineSpacing2: () => `${t(WORD.lineSpacing)}: ${t(WORD.double)}`,
};

/** What `contributeWord` hands back: its teardown, the store (tests read
 *  it) and the document-context switch the importer calls after an open. */
export interface WordContribution {
  dispose(): void;
  store: WordStore;
  /** Hold (true) or drop (false) the document context. */
  setDocumentContext(on: boolean): void;
  /** Run a Word command by id (the typed twins of ADR 323 call this);
   *  false for an id that is not a Word command. */
  run(id: string): Promise<boolean>;
}

/**
 * Contribute the Word chrome. The `wordDocument` edit context must already
 * be registered (every door here borrows it). Each door is probed: a host
 * without one keeps the rest.
 */
export function contributeWord(
  host: BundleHost,
  deps: WordDeps,
): WordContribution {
  const disposers: Array<() => void> = [];
  const store = createWordStore(host, deps.docStories);
  const state: WordCommandState = { copied: null };
  const hasText = () => host.text?.selection() != null;
  const run = (name: WordCommandName) =>
    runWordCommand(host, name, state).catch((err: unknown) =>
      host.log.warn(`paged.doc: ${name} failed: ${String(err)}`),
    );

  for (const name of Object.keys(WORD_COMMAND) as WordCommandName[]) {
    disposers.push(
      host.contribute.command({
        id: WORD_COMMAND[name],
        title: TITLES[name](),
        category: "Word",
        handler: () => run(name),
      }).dispose,
    );
  }

  if (host.supports("contribute.keybinding.scope@1")) {
    for (const k of WORD_KEYS) {
      disposers.push(
        host.contribute.keybinding({
          key: k.key,
          command: k.command,
          scope: { editContext: WORD_CONTEXT },
          // A shortcut acts on text: with no text selected the key stays
          // the host's. Tab and Shift+Tab act only in a list paragraph.
          when: k.list ? () => hasText() && isList(store) : () => hasText(),
        }).dispose,
      );
    }
  }

  if (host.supports("contribute.controlBarGroup@1")) {
    const write = (
      path: "characterFontFamily" | "characterFontSize" | "characterFillColor",
      value:
        | { type: "text"; value: string }
        | { type: "length"; value: number }
        | { type: "colorRef"; value: string },
    ) =>
      void host.text
        .format([{ path, value }])
        .then(() => store.refreshFormat());
    disposers.push(
      host.contribute.controlBarGroup({
        id: "media.paged.doc.controlBar.home",
        title: t(WORD.home),
        scope: { editContext: WORD_CONTEXT },
        render: makeHomeGroup(store, {
          run: (name) => void run(name).then(() => store.refreshFormat()),
          applyParagraphStyle: (id) =>
            void host.text
              .applyStyle("paragraph", id)
              .then(() => store.refreshFormat()),
          setFontFamily: (family) =>
            write("characterFontFamily", { type: "text", value: family }),
          setFontSize: (size) =>
            write("characterFontSize", { type: "length", value: size }),
          setTextColor: (swatch) =>
            write("characterFillColor", { type: "colorRef", value: swatch }),
        }),
      }).dispose,
    );
  }

  if (host.supports("contribute.statusItem@1")) {
    const items = [
      { id: "page", align: "start" as const, render: makePageStatus(store) },
      { id: "words", align: "start" as const, render: makeWordsStatus(store) },
      { id: "zoom", align: "end" as const, render: makeZoomStatus(host) },
    ];
    for (const [order, item] of items.entries()) {
      disposers.push(
        host.contribute.statusItem({
          id: `media.paged.doc.status.${item.id}`,
          scope: { editContext: WORD_CONTEXT },
          align: item.align,
          order: (order + 1) * 10,
          render: item.render,
        }).dispose,
      );
    }
  }

  // Keep the store current: the selection's format on every selection
  // change, the styles and counts on every document change (the counts a
  // beat later, so a burst of typing reads the story once).
  let wordsTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshWordsSoon = () => {
    if (wordsTimer) clearTimeout(wordsTimer);
    wordsTimer = setTimeout(() => {
      wordsTimer = null;
      void store.refreshWords();
    }, 250);
  };
  if (host.supports("text.selection@1")) {
    disposers.push(
      host.text.onDidChangeSelection(() => {
        void store.refreshFormat();
        refreshWordsSoon();
      }).dispose,
    );
  }
  if (host.supports("document.onDidChange@1")) {
    disposers.push(
      host.document.onDidChange(() => {
        void store.refreshFormat();
        void store.refreshDocument();
        void store.refreshPage();
        refreshWordsSoon();
      }).dispose,
    );
  }
  if (host.supports("viewport.pages@1")) {
    disposers.push(
      host.viewport.onDidChangeActivePage(() => void store.refreshPage())
        .dispose,
    );
  }

  // The document context: a Word document opened as the document IS Word
  // content on every page. The importer holds it after an open; a document
  // opened later (a saved .paged of a Word document) is recognised by its
  // label. Each open is answered once, newest wins.
  let asked = 0;
  const setDocumentContext = (on: boolean) => {
    asked++;
    if (!host.supports("shell.documentContext@1")) return;
    host.shell.setDocumentContext(on ? WORD_CONTEXT : null);
    if (on) {
      void store.refreshDocument();
      void store.refreshPage();
      void store.refreshWords();
    }
  };
  if (host.supports("document.onDidOpen@1")) {
    disposers.push(
      host.document.onDidOpen(() => {
        const mine = ++asked;
        void deps.isWordDocument().then((word) => {
          if (mine === asked && word) setDocumentContext(true);
        });
      }).dispose,
    );
  }

  const byId = new Map(
    (Object.keys(WORD_COMMAND) as WordCommandName[]).map((n) => [
      WORD_COMMAND[n] as string,
      n,
    ]),
  );
  return {
    store,
    setDocumentContext,
    async run(id) {
      const name = byId.get(id);
      if (!name) return false;
      await runWordCommand(host, name, state);
      return true;
    },
    dispose() {
      if (wordsTimer) clearTimeout(wordsTimer);
      for (const d of disposers) d();
    },
  };
}

function isList(store: WordStore): boolean {
  const list = store.get().format.paragraphListType;
  return list === "BulletList" || list === "NumberedList";
}
