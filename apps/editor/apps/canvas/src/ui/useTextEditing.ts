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

// Keyboard typing + caret navigation → mutation / selection dispatch.
//
// Phase 3 UI-2 — when there's a `ContentSelection`, intercept printable
// keystrokes + Backspace/Delete and route them through the worker's
// `Mutation` channel. Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z drive Undo/Redo.
//
// W2.11 — arrow-key caret navigation + Home/End. Left/Right move ±1
// offset locally (cheap, char-granular). Up/Down and Home/End need line
// metrics the main thread doesn't have, so they round-trip through the
// engine: `client.caretNav` (the engine owns the InDesign desired-x
// "goal column") and `client.lineBounds`. Shift extends from a stable
// anchor; the focus end moves via the same nav.
//
// ONE KEY AT A TIME (ED-18). Every key's work runs on a single promise
// chain, in the order the keys arrived, against the selection the
// previous key left behind (`selRef`, written synchronously — the React
// state it mirrors lands a render later). The engine round-trips of
// End / Home / Up / Down hold the chain until they answer. Before this,
// "End" then " A" typed quickly put the space at the OLD caret, and the
// late line-bounds answer then dragged the caret back over it, so the
// next letter landed in front of the space ("for" + End + " A" → "forA ").
// An engine answer is dropped when something outside this handler (a
// click, a panel) moved the selection while it was in flight.
//
// OFFSETS ARE UTF-8 BYTES. The engine addresses story text by byte
// (`wordBounds`, `lineBounds`, `insertText.offset` alike), so an insert
// advances the caret by the text's UTF-8 length, not its UTF-16 length —
// "ü" is two bytes, and advancing by one left the caret inside it.
//
// Escape (ED-1) leaves the text — the caret clears and the host selects
// the frame that held it with the Selection tool in hand — instead of
// leaving the caret live for the next key to type into.
//
// TEXT ARRIVES AS INPUT, NOT AS KEYS (F-36, ADR 234). While a caret is in
// a story, focus sits on the text input surface (TextInputSurface.tsx), a
// textarea at the caret. Its `beforeinput` carries every character the
// operating system produces — a plain key, Option and AltGr characters,
// the emoji picker, dictation — and its composition events carry input
// method text (CJK, and dead keys: ´ then e is é), committed into the
// story at `compositionend`. Keydown keeps navigation, deletion, Enter,
// Tab and the chords; a key pressed during a composition is the IME's
// and nothing here sees it. When focus is somewhere else that types
// nothing (the page, a chrome button just clicked), a printable keydown
// still types, and hands focus back to the surface for the next one.
//
// Enter is a paragraph break and Shift+Enter a forced line break
// (U+2028), Tab a tab character — InDesign's keys. In a table cell Tab is
// left alone: InDesign moves to the next cell there, which nothing does
// yet.
//
// Paste (ED-2) arrives as the DOM `paste` event, whose plain-text payload
// needs no clipboard permission; copy and cut read the range from the
// engine and write it through `navigator.clipboard`.
//
// Cmd/Ctrl+A (ED-14) selects the whole story (or the whole cell) the
// caret is in.
//
// Listener runs in the CAPTURE phase: the page-navigation shortcuts
// (`useKeyboardShortcuts`) bind Home/End/PageUp/PageDown on `window`
// too, and listener order between two `window` keydown handlers isn't
// guaranteed. Capturing here lets us consume the key and
// `stopPropagation()` before the bubble-phase page-nav listener runs
// whenever a content selection is active.
//
// W2.11 (tables v2) — the selection's `cell` qualifier (v35) rides
// straight through. When `sel.cell` is set, `start`/`end` are
// cell-local offsets into that table cell's paragraph stream, and the
// `insertText` / `deleteRange` mutations must carry the SAME qualifier
// so the edit lands in the cell, not the body story. The qualifier is
// additive: body selections leave it `undefined` and the wire shape is
// byte-identical to before. Undo is correct because the engine's
// inverse op carries the same `cell` (proven by the cell-text probe).

import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import type {
  CanvasClient,
  CaretDirection,
  ContentSelection,
  Mutation,
} from "@paged-media/client";
import {
  canvasKeyYields,
  canvasSurfaceOf,
  focusCanvasViewport,
  heldTypingStyle,
  insideKeyOwningContainer,
  isCanvasSurface,
  isFormField,
  DIRECT_SELECT_TOOL_ID,
  HAND_TOOL_ID,
  SELECT_TOOL_ID,
  TEXT_TOOL_ID,
  ZOOM_TOOL_ID,
  useOptionalTool,
} from "@paged-media/shell";

import { textInputSurface } from "./TextInputSurface";

export interface TextEditingContext {
  client: CanvasClient | null;
  selection: ContentSelection | null;
  setSelection: (s: ContentSelection | null) => void;
  /** ADR-012 — true while an active edit context owns undo (it declares
   *  `onUndo`). The edit-context controller routes Cmd-Z to that context;
   *  this hook must then leave the document stack alone. */
  undoOwnedByContext?: () => boolean;
  /** True while an edit context is active: its controller owns Escape
   *  (it cancels the context), so leaving the text is not ours to do. */
  escapeOwnedByContext?: () => boolean;
  /** Escape left the text. The caret is already cleared; the host puts
   *  the user back on the object level (InDesign: the frame that held
   *  the caret selected, the Selection tool in hand). */
  onLeaveText?: (left: ContentSelection) => void;
}

/** One key's work, run against the selection the previous key left. */
type Task = (
  sel: ContentSelection,
  client: CanvasClient,
) => void | Promise<void>;

const utf8 = new TextEncoder();

/** The engine's offsets are UTF-8 bytes. */
export function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/** Past the end of any story: the engine clamps a paragraph query to the
 *  story's last paragraph, whose end is then the story's end. */
const PAST_THE_END = 0x7fff_ffff;

/** The tools a live caret survives being picked with: the Type tool, the
 *  two selection tools, the tools you look with, and the two that work
 *  ON the text selection (the Eyedropper samples into it, a Note is
 *  placed at the caret). */
const TOOLS_THAT_KEEP_THE_CARET: ReadonlySet<string> = new Set([
  TEXT_TOOL_ID,
  SELECT_TOOL_ID,
  DIRECT_SELECT_TOOL_ID,
  HAND_TOOL_ID,
  ZOOM_TOOL_ID,
  "paged.tool.eyedropper",
  "paged.tool.note",
]);

/**
 * Whether picking `toolId` leaves text editing (InDesign: reaching for the
 * Pen, a frame or a shape tool ends the text selection). The caret used
 * to outlive the switch, so the keys meant for the new tool were typed
 * into the story — Enter that commits a Pen path became a paragraph break
 * and the path was never placed.
 */
export function toolEndsTextEditing(toolId: string): boolean {
  return !TOOLS_THAT_KEEP_THE_CARET.has(toolId);
}

export function useTextEditing(ctx: TextEditingContext) {
  // Shift-extend anchor: the offset that stays fixed while the focus
  // end moves. Reset to the caret offset on any non-extending move so a
  // fresh Shift+arrow grows from the current caret, not a stale anchor.
  const anchorRef = useRef<number | null>(null);
  // The context of the latest render, read by the listeners when a key
  // arrives (they are attached once, below).
  const latest = useEffectEvent(() => ctx);

  // The selection as the last key left it. Synced from the prop only
  // when the prop CHANGES, so a render that has not caught up with this
  // handler's own writes cannot roll it back.
  const selRef = useRef<ContentSelection | null>(ctx.selection);
  // Set by Escape until the queued exit runs, so keys pressed in between
  // (the "v" after Escape) are not typed into the text being left.
  const leavingRef = useRef(false);
  useLayoutEffect(() => {
    selRef.current = ctx.selection;
    leavingRef.current = false;
  }, [ctx.selection]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  // A deliberate switch to a tool that does not edit text ends the text
  // selection (a spring-loaded hold, a "suspend", keeps it: the caret is
  // there when the key comes up).
  const tool = useOptionalTool();
  const effectiveTool = tool?.effectiveTool ?? null;
  const toolChange = tool?.lastReason ?? "switch";
  const seenToolRef = useRef(effectiveTool);
  useEffect(() => {
    if (seenToolRef.current === effectiveTool) return;
    seenToolRef.current = effectiveTool;
    if (effectiveTool === null || toolChange !== "switch") return;
    if (!toolEndsTextEditing(effectiveTool) || !selRef.current) return;
    selRef.current = null;
    latest().setSelection(null);
  }, [effectiveTool, toolChange]);

  useEffect(() => {
    const setSel = (s: ContentSelection | null) => {
      selRef.current = s;
      latest().setSelection(s);
    };
    const after = (work: () => unknown) => {
      queueRef.current = queueRef.current.then(async () => {
        try {
          await work();
        } catch {
          /* worker reload / disconnect — leave the caret put */
        }
      });
    };
    const enqueue = (task: Task) =>
      after(async () => {
        const sel = selRef.current;
        const client = latest().client;
        if (!sel || !client) return;
        await task(sel, client);
      });
    /** An engine answer still applies only if nothing outside this
     *  handler moved the selection while the question was in flight. */
    const stillAt = (sel: ContentSelection) => selRef.current === sel;

    const onKey = (e: KeyboardEvent) => {
      // A field, a dialog, an open menu, a composition: not the text's
      // (R9, R10).
      if (canvasKeyYields(e)) return;
      const ctx = latest();
      const client = ctx.client;
      if (!client) return;

      const cmd = e.metaKey || e.ctrlKey;
      const key = e.key;

      // Cmd+Z / Cmd+Shift+Z. Always handled when client exists,
      // regardless of selection state.
      if (cmd && (key === "z" || key === "Z")) {
        // Both this hook and the edit-context controller listen on
        // `window` in the capture phase, so stopPropagation in one never
        // stops the other and their order is registration order. While a
        // context owns undo, a document undo here as well would unwind
        // the document under the context's own step — inside a sheet it
        // undid the placed table's cell pour and emptied every cell.
        if (e.defaultPrevented || ctx.undoOwnedByContext?.()) return;
        e.preventDefault();
        // Behind any key still in flight, so it undoes what was typed.
        const redo = e.shiftKey;
        after(() => (redo ? client.redo() : client.undo()));
        return;
      }

      // The remaining shortcuts require an active selection.
      if (!selRef.current || leavingRef.current) return;

      if (key === "Escape") {
        if (e.defaultPrevented || ctx.escapeOwnedByContext?.()) return;
        e.preventDefault();
        e.stopPropagation();
        leavingRef.current = true;
        anchorRef.current = null;
        enqueue((left) => {
          leavingRef.current = false;
          setSel(null);
          latest().onLeaveText?.(left);
        });
        return;
      }

      // Select All inside text: the whole story, or the whole cell.
      if (cmd && !e.altKey && !e.shiftKey && (key === "a" || key === "A")) {
        e.preventDefault();
        e.stopPropagation();
        anchorRef.current = null;
        enqueue(async (sel, c) => {
          const all = await wholeStorySelection(c, sel);
          if (all && stillAt(sel)) setSel(all);
        });
        return;
      }

      // Copy / cut a range. Pastes arrive as the `paste` event below.
      const letter = key.toLowerCase();
      if (
        cmd &&
        !e.altKey &&
        !e.shiftKey &&
        (letter === "c" || letter === "x")
      ) {
        const sel = selRef.current;
        if (sel.start === sel.end) return;
        e.preventDefault();
        const cut = letter === "x";
        enqueue(async (s, c) => {
          if (s.start === s.end) return;
          const text = await rangeText(c, s);
          if (text === null) return;
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            // Nothing reached the clipboard, so nothing may leave the
            // story either: a cut that lost the text would be data loss.
            return;
          }
          if (!cut) return;
          void c.mutate({
            op: "deleteRange",
            args: {
              storyId: s.storyId,
              start: s.start,
              end: s.end,
              cell: s.cell ?? undefined,
            },
          });
          setSel({ ...s, end: s.start, affinity: false });
        });
        return;
      }

      if (key === "Backspace") {
        e.preventDefault();
        anchorRef.current = null;
        enqueue((sel, c) => {
          const cell = sel.cell ?? undefined;
          if (sel.start === sel.end && sel.start === 0) return;
          if (sel.start === sel.end) {
            // Caret: delete one character backwards.
            const start = sel.start - 1;
            void c.mutate({
              op: "deleteRange",
              args: { storyId: sel.storyId, start, end: sel.start, cell },
            });
            setSel({ ...sel, start, end: start, affinity: false });
          } else {
            void c.mutate({
              op: "deleteRange",
              args: {
                storyId: sel.storyId,
                start: sel.start,
                end: sel.end,
                cell,
              },
            });
            setSel({ ...sel, end: sel.start, affinity: false });
          }
        });
        return;
      }

      if (key === "Delete") {
        e.preventDefault();
        anchorRef.current = null;
        enqueue((sel, c) => {
          const cell = sel.cell ?? undefined;
          if (sel.start === sel.end) {
            // Forward delete — defer correct end-of-story handling
            // (worker will reject if out of range).
            void c.mutate({
              op: "deleteRange",
              args: {
                storyId: sel.storyId,
                start: sel.start,
                end: sel.start + 1,
                cell,
              },
            });
          } else {
            void c.mutate({
              op: "deleteRange",
              args: {
                storyId: sel.storyId,
                start: sel.start,
                end: sel.end,
                cell,
              },
            });
            setSel({ ...sel, end: sel.start, affinity: false });
          }
        });
        return;
      }

      // Printable input. On the text input surface the character arrives
      // as `beforeinput` (below), so an input method, a dead key, Option
      // or AltGr all reach the story the same way. Anywhere else (the
      // page, a button just clicked) this key types it, and focus comes
      // back to the surface for the next one.
      if (isPrintable(e)) {
        if (canvasSurfaceOf(e.target) === "text") return;
        e.preventDefault();
        anchorRef.current = null;
        enqueue((sel, c) => insertAt(c, sel, key, setSel));
        focusTextSurface();
        return;
      }

      // Enter: a paragraph break; Shift+Enter: a forced line break.
      if (key === "Enter" && !cmd && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        anchorRef.current = null;
        const text = e.shiftKey ? FORCED_LINE_BREAK : "\n";
        enqueue((sel, c) => insertAt(c, sel, text, setSel));
        return;
      }

      // Tab: a tab character in body text (InDesign). In a table cell it
      // is left to move focus until cell navigation exists.
      if (key === "Tab" && !cmd && !e.altKey && !e.shiftKey) {
        if (selRef.current.cell) return;
        e.preventDefault();
        e.stopPropagation();
        anchorRef.current = null;
        enqueue((sel, c) => insertAt(c, sel, "\t", setSel));
        return;
      }

      // ── Caret navigation ────────────────────────────────────────
      // The caret offset (the "focus" the user steers) is the end the
      // last extend moved. For a collapsed selection both ends equal
      // the caret; for a range we treat `end` as the focus and `start`
      // as the implicit anchor, falling back to anchorRef when set.
      const shift = e.shiftKey;

      // Left / Right arrows move the caret by one offset. Cmd+Left /
      // Cmd+Right jump to the line start / end (macOS line-nav
      // convention) via lineBounds.
      if (key === "ArrowLeft" || key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const toLineEdge = cmd; // Cmd+Arrow = line start/end on mac
        enqueue(async (sel, c) => {
          const caretFocus = focusOffset(sel, anchorRef.current);
          if (toLineEdge) {
            await applyLineEdge(
              c,
              sel,
              key === "ArrowLeft" ? "start" : "end",
              shift,
              anchorRef,
              caretFocus,
              setSel,
              stillAt,
            );
            return;
          }
          const delta = key === "ArrowLeft" ? -1 : 1;
          const newFocus = Math.max(0, caretFocus + delta);
          applyMove(sel, newFocus, shift, anchorRef, caretFocus, setSel);
        });
        return;
      }

      // Up / Down arrows: vertical nav owned by the engine (line
      // metrics + desired-x). Returned offset is the new focus.
      if (key === "ArrowUp" || key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        const direction: CaretDirection = key === "ArrowUp" ? "up" : "down";
        enqueue(async (sel, c) => {
          const caretFocus = focusOffset(sel, anchorRef.current);
          const offset = await c.caretNav(
            sel.storyId,
            caretFocus,
            direction,
            sel.cell ?? null,
          );
          // null = no-op (already at first/last line): keep the caret.
          if (offset === null || !stillAt(sel)) return;
          applyMove(sel, offset, shift, anchorRef, caretFocus, setSel);
        });
        return;
      }

      // Home / End: line start / end via lineBounds. Stop propagation
      // so the page-navigation shortcut (also on window) doesn't also
      // fire while we own the caret.
      if (key === "Home" || key === "End") {
        e.preventDefault();
        e.stopPropagation();
        enqueue((sel, c) =>
          applyLineEdge(
            c,
            sel,
            key === "Home" ? "start" : "end",
            shift,
            anchorRef,
            focusOffset(sel, anchorRef.current),
            setSel,
            stillAt,
          ),
        );
        return;
      }
    };

    // Paste — the DOM event carries the clipboard's plain text without a
    // permission prompt. Lands through the same insert as typing; a range
    // is replaced in ONE batch, so one undo takes the whole paste back.
    const onPaste = (e: ClipboardEvent) => {
      if (isFormField(e.target) || insideKeyOwningContainer(e.target)) return;
      if (!selRef.current || leavingRef.current || !latest().client) return;
      const raw = e.clipboardData?.getData("text/plain") ?? "";
      if (!raw) return;
      e.preventDefault();
      // Another app's line breaks (CRLF, CR) are each one paragraph break.
      const text = raw.replace(/\r\n?/g, "\n");
      anchorRef.current = null;
      enqueue((sel, c) => insertAt(c, sel, text, setSel));
    };

    // Text input (F-36). Everything the surface's `beforeinput` would put
    // into the textarea goes into the story instead; the textarea stays
    // empty. A composition is the exception: its text must show in the
    // textarea while it is marked (that event cannot be cancelled), and
    // lands in the story when it is committed.
    const onBeforeInput = (e: InputEvent) => {
      if (canvasSurfaceOf(e.target) !== "text") return;
      switch (e.inputType) {
        case "insertCompositionText":
          return;
        case "insertText":
        case "insertReplacementText": {
          e.preventDefault();
          const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
          if (!text || !selRef.current || leavingRef.current) return;
          anchorRef.current = null;
          enqueue((sel, c) => insertAt(c, sel, text, setSel));
          return;
        }
        case "insertLineBreak":
        case "insertParagraph": {
          // Keydown takes Enter; this is a soft keyboard's.
          e.preventDefault();
          if (!selRef.current || leavingRef.current) return;
          anchorRef.current = null;
          enqueue((sel, c) => insertAt(c, sel, "\n", setSel));
          return;
        }
        default:
          // Deletion, history and formatting arrive as keys (handled
          // above) or not at all: nothing may edit the textarea itself.
          e.preventDefault();
      }
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      if (canvasSurfaceOf(e.target) !== "text") return;
      (e.target as HTMLTextAreaElement).value = "";
      const text = e.data;
      if (!text || !selRef.current || leavingRef.current) return;
      anchorRef.current = null;
      enqueue((sel, c) => insertAt(c, sel, text, setSel));
    };
    // Whatever reached the textarea without a cancellable beforeinput
    // (a browser that commits a composition differently) is typed too,
    // so nothing the user entered is dropped or left behind.
    const onInput = (e: Event) => {
      if (canvasSurfaceOf(e.target) !== "text") return;
      if ((e as InputEvent).isComposing) return;
      const area = e.target as HTMLTextAreaElement;
      const text = area.value;
      if (!text) return;
      area.value = "";
      if (!selRef.current || leavingRef.current) return;
      anchorRef.current = null;
      enqueue((sel, c) => insertAt(c, sel, text, setSel));
    };
    // Focus that drops to nothing (a click on a panel's background, a
    // script's blur) comes back to the text while the caret is live, so
    // the next key — or IME commit — has its target.
    const onFocusOut = (e: FocusEvent) => {
      if (canvasSurfaceOf(e.target) !== "text") return;
      if (e.relatedTarget !== null) return;
      queueMicrotask(() => {
        if (!selRef.current || !document.hasFocus()) return;
        const active = document.activeElement;
        if (active === null || active === document.body) focusTextSurface();
      });
    };

    // Capture phase — preempt the bubble-phase page-nav shortcuts.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("paste", onPaste, true);
    window.addEventListener("beforeinput", onBeforeInput, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    window.addEventListener("input", onInput, true);
    window.addEventListener("focusout", onFocusOut, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("paste", onPaste, true);
      window.removeEventListener("beforeinput", onBeforeInput, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
      window.removeEventListener("input", onInput, true);
      window.removeEventListener("focusout", onFocusOut, true);
    };
  }, []);

  // Keyboard focus follows the caret: a caret placed in a story takes
  // focus for the text input surface when nothing else holds it (the
  // page, the canvas), and a caret that goes away hands focus back to
  // the canvas. Focus in a panel's field stays there — a caret placed
  // from Find/Change does not steal it.
  const hasCaret = ctx.selection !== null;
  useEffect(() => {
    const surface = textInputSurface();
    if (!surface) return;
    const active = document.activeElement;
    if (hasCaret) {
      if (active === surface) return;
      if (
        active === null ||
        active === document.body ||
        isCanvasSurface(active)
      ) {
        surface.focus({ preventScroll: true });
      }
    } else if (active === surface) {
      // The surface sits INSIDE the viewport, and focusCanvasViewport
      // leaves focus alone that is already within it — so without the
      // blur the caretless textarea kept focus and ate the arrows and
      // Backspace that are the selected frame's again (AC-OBJ-24).
      surface.blur();
      focusCanvasViewport();
    }
  }, [hasCaret, ctx.selection]);
}

/** Insert `text` at the caret, or replace the range with it, and move
 *  the caret past it. A replace is one `batch`, so it undoes as one. */
export function insertAt(
  client: CanvasClient,
  sel: ContentSelection,
  text: string,
  setSel: (s: ContentSelection | null) => void,
): void {
  const cell = sel.cell ?? undefined;
  const insert: Mutation = {
    op: "insertText",
    args: { storyId: sel.storyId, offset: sel.start, text, cell },
  };
  // Finding PN-152 (ADR 236): a character style chosen at this caret
  // goes on the text typed there, in the insert's one undo step.
  const style = sel.cell ? null : heldTypingStyle(sel);
  if (style) {
    const end = sel.start + byteLength(text);
    void client.mutate({
      op: "batch",
      args: {
        ops: [
          insert,
          {
            op: "set",
            args: {
              address: `storyRange:${sel.storyId}@${sel.start}..${end}`,
              path: "appliedCharacterStyle",
              value: { type: "text", value: style },
            },
          },
        ],
      },
    } as Mutation);
  } else if (sel.start === sel.end) {
    void client.mutate(insert);
  } else {
    void client.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "deleteRange",
            args: {
              storyId: sel.storyId,
              start: sel.start,
              end: sel.end,
              cell,
            },
          },
          insert,
        ],
      },
    });
  }
  const caret = sel.start + byteLength(text);
  setSel({ ...sel, start: caret, end: caret, affinity: false });
}

/** The selection spanning the whole story (or cell) `sel` is in. */
export async function wholeStorySelection(
  client: CanvasClient,
  sel: ContentSelection,
): Promise<ContentSelection | null> {
  const last = await client.paragraphBounds(
    sel.storyId,
    PAST_THE_END,
    sel.cell ?? null,
  );
  if (!last) return null;
  return { ...sel, start: 0, end: last.end, affinity: false };
}

/** The text of a body range, read from the engine. Paragraphs join with
 *  the engine's own "\n" boundary and the offsets are UTF-8 bytes, so the
 *  range is cut from the encoded text. `null` when the story cannot be
 *  read or the range sits in a table cell (whose text the story content
 *  read does not carry). */
async function rangeText(
  client: CanvasClient,
  sel: ContentSelection,
): Promise<string | null> {
  if (sel.cell) return null;
  const reply = await client.send({
    kind: "requestStoryContent",
    payload: { storyId: sel.storyId },
  });
  if (reply.kind !== "storyContentResult" || !reply.payload.content)
    return null;
  const text = reply.payload.content.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join("\n");
  const bytes = utf8.encode(text);
  return new TextDecoder().decode(bytes.slice(sel.start, sel.end));
}

/** The frame that holds the caret — where it is laid out, or, for an
 *  overset caret with no geometry, the last frame of the story's thread. */
export async function frameHoldingCaret(
  client: CanvasClient,
  sel: ContentSelection,
): Promise<string | null> {
  try {
    const caret = await client.caretGeometry({ ...sel, end: sel.start });
    if (caret?.frameId) return caret.frameId;
  } catch {
    /* fall through to the thread */
  }
  try {
    const links = await client.frameChain(sel.storyId);
    return links[links.length - 1]?.frameId ?? null;
  } catch {
    return null;
  }
}

/** The steerable end of the selection. For a collapsed caret both ends
 *  are the focus; for a range, `end` is the focus unless a recorded
 *  anchor says otherwise (an extend that collapsed the focus onto the
 *  anchor's far side). */
function focusOffset(sel: ContentSelection, anchor: number | null): number {
  if (sel.start === sel.end) return sel.start;
  if (anchor === sel.start) return sel.end;
  if (anchor === sel.end) return sel.start;
  return sel.end;
}

/** Apply a focus move. Non-shift collapses to the new focus and clears
 *  the anchor; shift extends from a stable anchor (seeded from the
 *  current caret on the first extend) to the new focus. */
function applyMove(
  sel: ContentSelection,
  newFocus: number,
  shift: boolean,
  anchorRef: React.MutableRefObject<number | null>,
  caretFocus: number,
  setSelection: (s: ContentSelection | null) => void,
): void {
  if (shift) {
    const anchor = anchorRef.current ?? caretFocus;
    anchorRef.current = anchor;
    setSelection({
      ...sel,
      start: Math.min(anchor, newFocus),
      end: Math.max(anchor, newFocus),
      affinity: false,
    });
  } else {
    anchorRef.current = null;
    setSelection({
      ...sel,
      start: newFocus,
      end: newFocus,
      affinity: false,
    });
  }
}

/** Resolve the line containing the caret focus and move/extend to its
 *  start or end. */
async function applyLineEdge(
  client: CanvasClient,
  sel: ContentSelection,
  edge: "start" | "end",
  shift: boolean,
  anchorRef: React.MutableRefObject<number | null>,
  caretFocus: number,
  setSelection: (s: ContentSelection | null) => void,
  stillAt: (sel: ContentSelection) => boolean,
): Promise<void> {
  const bounds = await client.lineBounds(
    sel.storyId,
    caretFocus,
    sel.cell ?? null,
  );
  if (!bounds || !stillAt(sel)) return;
  const target = edge === "start" ? bounds.lineStart : bounds.lineEnd;
  applyMove(sel, target, shift, anchorRef, caretFocus, setSelection);
}

/** U+2028, the forced line break (InDesign's Shift+Return). */
const FORCED_LINE_BREAK = "\u2028";

/** A key that types one character: a single code point (an emoji is two
 *  UTF-16 units), with no Cmd, and no Ctrl unless Alt rides along (AltGr
 *  on Windows reports Ctrl+Alt). Option and AltGr characters type. */
function isPrintable(e: KeyboardEvent): boolean {
  if (e.metaKey || (e.ctrlKey && !e.altKey)) return false;
  return [...e.key].length === 1;
}

/** Put keyboard focus on the text input surface, if one is mounted. */
function focusTextSurface(): void {
  const surface = textInputSurface();
  if (surface && document.activeElement !== surface) {
    surface.focus({ preventScroll: true });
  }
}
