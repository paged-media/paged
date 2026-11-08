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

// `paged.text.*` — the text-format verbs as host commands.
//
// WHY THIS LIVES IN THE EDITOR. Bold, the size steps, the four alignments,
// the indent steps and line spacing are verbs on whatever text is selected;
// nothing about them is Word's. Doc carried them (and a slide would need the
// same), so the verbs and their arithmetic are one implementation in
// `@paged-media/helpers` (`runTextVerb`), which doc's Word keys and control
// bar run through `host.text` as well. This file is the host's door for
// them: the content selection, the engine's story-range reads and the
// story-range write, the same ones `host.text.properties` / `format` make.
//
//  1. A COLLAPSED CARET reads the character before it and formats the word
//     around it (the character paths); between words nothing is written.
//  2. ONE BATCH per verb: one undo step.
//  3. A SELECTION IN A TABLE CELL is left alone (cell-local offsets are not
//     story offsets), as the plugin door leaves it.
//  4. THE ENGINE'S REFUSAL is reported in words.

import type {
  CommandContribution,
  KeybindingContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import type { CanvasClient } from "@paged-media/client";
import {
  TEXT_VERBS,
  runTextVerb,
  type TextDoor,
  type TextVerb,
  type TextVerbWrite,
} from "@paged-media/helpers";
import {
  contentToChar,
  formatAddress,
  paragraphTexts,
  wordAroundCaret,
} from "@paged-media/plugin-sdk";
import { refusalText } from "@paged-media/panel-kit";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.textFormatCommands", {
  bold: "Text: Bold",
  italic: "Text: Italic",
  underline: "Text: Underline",
  strikethrough: "Text: Strikethrough",
  subscript: "Text: Subscript",
  superscript: "Text: Superscript",
  allCaps: "Text: All caps",
  smallCaps: "Text: Small caps",
  growFont: "Text: Increase font size",
  shrinkFont: "Text: Decrease font size",
  alignLeft: "Text: Align left",
  alignCenter: "Text: Align center",
  alignRight: "Text: Align right",
  justify: "Text: Justify",
  increaseIndent: "Text: Increase indent",
  decreaseIndent: "Text: Decrease indent",
  lineSpacing1: "Text: Line spacing 1",
  lineSpacing15: "Text: Line spacing 1.5",
  lineSpacing2: "Text: Line spacing 2",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  Format: "Format",
  Bold: "Bold",
  Italic: "Italic",
  Underline: "Underline",
  Strikethrough: "Strikethrough",
  Subscript: "Subscript",
  Superscript: "Superscript",
  "All caps": "All caps",
  "Small caps": "Small caps",
  "Increase font size": "Increase font size",
  "Decrease font size": "Decrease font size",
  "Align left": "Align left",
  "Align center": "Align center",
  "Align right": "Align right",
  Justify: "Justify",
  "Increase indent": "Increase indent",
  "Decrease indent": "Decrease indent",
  "Line spacing 1": "Line spacing 1",
  "Line spacing 1.5": "Line spacing 1.5",
  "Line spacing 2": "Line spacing 2",
});

/** The Problems panel's source id for these commands. */
export const TEXT_FORMAT_DIAGNOSTIC_SOURCE = "paged.text";

/** The command id of a verb. */
export const textCommandId = (verb: TextVerb): string => `paged.text.${verb}`;

interface Entry {
  verb: TextVerb;
  title: string;
  menu: string;
}

const ENTRIES: readonly Entry[] = [
  { verb: "bold", title: M.bold, menu: "Bold" },
  { verb: "italic", title: M.italic, menu: "Italic" },
  { verb: "underline", title: M.underline, menu: "Underline" },
  { verb: "strikethrough", title: M.strikethrough, menu: "Strikethrough" },
  { verb: "subscript", title: M.subscript, menu: "Subscript" },
  { verb: "superscript", title: M.superscript, menu: "Superscript" },
  { verb: "allCaps", title: M.allCaps, menu: "All caps" },
  { verb: "smallCaps", title: M.smallCaps, menu: "Small caps" },
  { verb: "growFont", title: M.growFont, menu: "Increase font size" },
  { verb: "shrinkFont", title: M.shrinkFont, menu: "Decrease font size" },
  { verb: "alignLeft", title: M.alignLeft, menu: "Align left" },
  { verb: "alignCenter", title: M.alignCenter, menu: "Align center" },
  { verb: "alignRight", title: M.alignRight, menu: "Align right" },
  { verb: "justify", title: M.justify, menu: "Justify" },
  { verb: "increaseIndent", title: M.increaseIndent, menu: "Increase indent" },
  { verb: "decreaseIndent", title: M.decreaseIndent, menu: "Decrease indent" },
  { verb: "lineSpacing1", title: M.lineSpacing1, menu: "Line spacing 1" },
  { verb: "lineSpacing15", title: M.lineSpacing15, menu: "Line spacing 1.5" },
  { verb: "lineSpacing2", title: M.lineSpacing2, menu: "Line spacing 2" },
];

/** What a run needs of the app: the client and the live content selection. */
export interface TextFormatDeps {
  client: Pick<CanvasClient, "send" | "mutate">;
  getSelection: () => {
    storyId: string;
    start: number;
    end?: number;
    cell?: unknown;
  } | null;
}

/** The characters a character path applies to; the rest apply per paragraph. */
const isCharacterPath = (path: string): boolean =>
  path.startsWith("character") || path === "appliedCharacterStyle";

type Span = readonly [number, number];

/** The character span of every paragraph (one character per break). */
function spansOf(paras: readonly string[]): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const p of paras) {
    const n = [...p].length;
    out.push([at, at + n]);
    at += n + 1;
  }
  return out;
}

/** The paragraph a character offset sits in. */
function spanAt(spans: readonly Span[], c: number): Span {
  const hit = spans.find((s) => c <= s[1]);
  return hit ?? spans[spans.length - 1] ?? [0, 0];
}

/** The range a read of a collapsed caret looks at: the character before it,
 *  the one after it at a paragraph start, the empty range in an empty one. */
function caretReadRange(paras: readonly string[], content: number): Span {
  const spans = spansOf(paras);
  const c = contentToChar(paras, content);
  const [ps, pe] = spanAt(spans, c);
  if (ps === pe) return [ps, ps];
  return c > ps ? [c - 1, c] : [c, c + 1];
}

/** Every touched paragraph, whole; null when they hold no characters. */
function paragraphsRange(
  paras: readonly string[],
  startContent: number,
  endContent: number,
): Span | null {
  const spans = spansOf(paras);
  const a = spanAt(spans, contentToChar(paras, startContent));
  const b = spanAt(spans, contentToChar(paras, endContent));
  return a[0] === b[1] ? null : [a[0], b[1]];
}

/** The story text of the selection's story, or null when unreadable. */
async function storyParagraphs(
  deps: TextFormatDeps,
  storyId: string,
): Promise<string[] | null> {
  try {
    const reply = await deps.client.send({
      kind: "requestStoryContent",
      payload: { storyId },
    });
    if (reply.kind !== "storyContentResult" || !reply.payload.content)
      return null;
    return paragraphTexts(reply.payload.content);
  } catch {
    return null;
  }
}

/** The verbs' door over the live text selection. */
export function textDoorOf(deps: TextFormatDeps): TextDoor {
  const selection = () => {
    const sel = deps.getSelection();
    return sel && !sel.cell
      ? { storyId: sel.storyId, start: sel.start, end: sel.end ?? sel.start }
      : null;
  };
  return {
    async read(path) {
      const sel = selection();
      if (!sel) return null;
      const paras = await storyParagraphs(deps, sel.storyId);
      if (!paras) return null;
      const [start, end] =
        sel.start === sel.end
          ? caretReadRange(paras, sel.start)
          : [contentToChar(paras, sel.start), contentToChar(paras, sel.end)];
      const address = formatAddress({
        kind: "storyRange",
        story: sel.storyId,
        start,
        end,
      });
      try {
        const reply = await deps.client.send({
          kind: "requestGet",
          payload: { address, path },
        } as never);
        const r = reply as {
          kind: string;
          payload?: {
            value: { value: unknown } | null;
            error: string | null;
            mixed?: boolean;
          };
        };
        if (r.kind !== "propertyValue" || !r.payload || r.payload.error)
          return null;
        if (r.payload.mixed) return "mixed";
        return r.payload.value?.value ?? null;
      } catch {
        return null;
      }
    },
    async format(writes: readonly TextVerbWrite[]) {
      const sel = selection();
      if (!sel) return { applied: false, error: "no text selection" };
      const paras = await storyParagraphs(deps, sel.storyId);
      if (!paras) return { applied: false, error: "the story is not readable" };
      const start = contentToChar(paras, sel.start);
      const end = contentToChar(paras, sel.end);
      const word: Span | null =
        start === end ? wordAroundCaret(paras, sel.start) : [start, end];
      const ops: unknown[] = [];
      for (const w of writes) {
        const r: Span | null = isCharacterPath(w.path)
          ? w.extent === "paragraphs"
            ? paragraphsRange(paras, sel.start, sel.end)
            : word
          : [start, end];
        if (!r)
          return {
            applied: false,
            error: "the caret stands between words: select the text to format",
          };
        ops.push({
          op: "setElementProperty",
          args: {
            elementId: {
              kind: "storyRange",
              id: { story_id: sel.storyId, start: r[0], end: r[1] },
            },
            path: w.path,
            value: w.value,
          },
        });
      }
      if (ops.length === 0) return { applied: true };
      const reply = await deps.client.mutate(
        (ops.length === 1 ? ops[0] : { op: "batch", args: { ops } }) as never,
      );
      return reply.kind === "mutationFailed"
        ? { applied: false, error: refusalText(reply.payload.error, "Text") }
        : { applied: true };
    },
  };
}

/** Run one verb on the live selection. Answers the refusal in words, or null. */
export async function applyTextVerb(
  deps: TextFormatDeps,
  verb: TextVerb,
): Promise<string | null> {
  const out = await runTextVerb(textDoorOf(deps), verb);
  return out.applied ? null : (out.error ?? null);
}

/** The commands. `report` lands a refusal in the Problems panel. */
export function buildTextFormatCommands(
  deps: TextFormatDeps,
  report: (message: string) => void,
  clear: () => void,
): CommandContribution[] {
  return ENTRIES.map((e) => ({
    id: textCommandId(e.verb),
    title: t(e.title),
    category: "Text",
    handler: async () => {
      clear();
      const refusal = await applyTextVerb(deps, e.verb);
      if (refusal) report(refusal);
    },
  }));
}

/** Type > Format > <verb>. */
export const TEXT_FORMAT_MENU_ITEMS: MenuItemContribution[] = ENTRIES.map(
  (e, i) => ({
    path: `Type/Format/${e.menu}`,
    command: textCommandId(e.verb),
    order: 40 + (i + 1) / 100,
    group: "textFormat",
  }),
);

/** The verbs, for tests. */
export const TEXT_FORMAT_VERBS = TEXT_VERBS;

// ---------------------------------------------------------------- keys

/** A text selection to format: a document at its root with a caret or a
 *  range in a story, and no form field (a panel's input, the command
 *  palette) holding the keyboard. The canvas's own text surface is not a form
 *  field: it is where the text is typed, and it leaves these chords alone
 *  (it handles Cmd+Z, Cmd+A, Cmd+C/X and the arrows, none of these).
 *
 *  Guarded on purpose: a guarded binding beats an unguarded one on the same
 *  chord, so Cmd+U underlines while a text selection exists and is still
 *  Smart Guides everywhere else. */
export const textVerbKeysApply = (state: unknown): boolean => {
  const s = state as {
    document?: { handle?: { pageCount?: number } | null } | null;
    editContext?: unknown;
    contentSelection?: { contentSelection?: unknown } | null;
  } | null;
  if (!s?.document?.handle || (s.document.handle.pageCount ?? 0) === 0) {
    return false;
  }
  if (s.editContext) return false;
  if (!s.contentSelection?.contentSelection) return false;
  return !formFieldHasFocus();
};

/** Does a form field outside the canvas's text surface hold focus? */
function formFieldHasFocus(): boolean {
  const el = typeof document === "undefined" ? null : document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  // The canvas text surface (`data-canvas-surface="text"`) is the canvas.
  if (el.hasAttribute("data-canvas-surface")) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

/** Every chord with the verb it runs, written out (the surface gate reads the
 *  table statically), each with its Cmd (macOS) and Ctrl (Linux, Windows)
 *  twin: the registry has no `mod`. Bold, italic and underline are the word
 *  processors'; the rest are InDesign's (Shift+L / C / R / J align, K all
 *  caps, H small caps, / strikethrough, = superscript, Alt+= subscript, . and
 *  , the size steps). A shifted punctuation key reports the shifted glyph on
 *  some layouts, so those register both spellings (the bracket pair's rule,
 *  `OBJECT_KEYBINDINGS`). Not bound, as there is no convention to follow: the
 *  indents and the line spacings. */
const TEXT_CHORDS: ReadonlyArray<readonly [string, string]> = [
  ["cmd+b", "paged.text.bold"],
  ["ctrl+b", "paged.text.bold"],
  ["cmd+i", "paged.text.italic"],
  ["ctrl+i", "paged.text.italic"],
  ["cmd+u", "paged.text.underline"],
  ["ctrl+u", "paged.text.underline"],
  ["shift+cmd+/", "paged.text.strikethrough"],
  ["shift+ctrl+/", "paged.text.strikethrough"],
  ["shift+cmd+?", "paged.text.strikethrough"],
  ["shift+ctrl+?", "paged.text.strikethrough"],
  ["shift+cmd+k", "paged.text.allCaps"],
  ["shift+ctrl+k", "paged.text.allCaps"],
  ["shift+cmd+h", "paged.text.smallCaps"],
  ["shift+ctrl+h", "paged.text.smallCaps"],
  ["shift+cmd+=", "paged.text.superscript"],
  ["shift+ctrl+=", "paged.text.superscript"],
  ["alt+shift+cmd+=", "paged.text.subscript"],
  ["alt+shift+ctrl+=", "paged.text.subscript"],
  ["shift+cmd+l", "paged.text.alignLeft"],
  ["shift+ctrl+l", "paged.text.alignLeft"],
  ["shift+cmd+c", "paged.text.alignCenter"],
  ["shift+ctrl+c", "paged.text.alignCenter"],
  ["shift+cmd+r", "paged.text.alignRight"],
  ["shift+ctrl+r", "paged.text.alignRight"],
  ["shift+cmd+j", "paged.text.justify"],
  ["shift+ctrl+j", "paged.text.justify"],
  ["shift+cmd+.", "paged.text.growFont"],
  ["shift+ctrl+.", "paged.text.growFont"],
  ["shift+cmd+>", "paged.text.growFont"],
  ["shift+ctrl+>", "paged.text.growFont"],
  ["shift+cmd+,", "paged.text.shrinkFont"],
  ["shift+ctrl+,", "paged.text.shrinkFont"],
  ["shift+cmd+<", "paged.text.shrinkFont"],
  ["shift+ctrl+<", "paged.text.shrinkFont"],
];

export const TEXT_FORMAT_KEYBINDINGS: KeybindingContribution[] =
  TEXT_CHORDS.map(([key, command]) => ({
    key,
    command,
    when: textVerbKeysApply,
  }));
