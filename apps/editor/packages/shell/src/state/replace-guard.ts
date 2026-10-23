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

// The one question before a document replaces the open one (ADR 230).
//
// The editor holds one document, so every open REPLACES it: File ▸ New,
// File ▸ Open…, a file dropped on the canvas, File ▸ Open PDF…, a library
// entry, New from a brief, a plugin's `host.nativeDocument.open` (an
// importer's output) and its `host.documents.open` (a plugin-built
// document). Each of them reaches `confirmReplace` before the engine is
// asked to load anything, and nothing else decides. Before this module the
// drop, Open PDF… and every plugin open skipped the check (finding R8):
// an edited document was gone without a word, and a never-saved one was
// gone for good, since the library versions saved documents only.
//
// The question is InDesign's: Save, Don't save, Cancel. Save runs the
// app's save (the command Cmd+S runs, registered with `setDocumentSaver`)
// and continues only when the document is clean afterwards, so a save the
// user abandons (a cancelled file picker, a failed write) keeps the
// document. Cancel, Escape and the backdrop keep it too: the safe answer
// is the one an unacknowledged prompt gets.
//
// WHERE IT IS ASKED. The shell's `<ReplaceDocumentPrompt>` renders the
// queue below while it is mounted. With no prompt mounted (a failed bundle
// load that still reaches the menu, the unit tests, a host that renders no
// shell) the question falls back to the platform's `confirm`, which needs
// no React tree: OK discards, Cancel keeps. Asking nothing is never an
// option.

import { t } from "@paged-media/strings";
import { REPLACE } from "./messages";
import { cancelPendingPlacement } from "./pending-placement";
import { scoped, type EditorScope } from "./editor-scope";

/** The user's answer to the replace question. */
export type ReplaceAnswer = "save" | "discard" | "cancel";

/** What is about to replace the open document. */
export interface ReplaceRequest {
  /** The replacement, as the subject of a sentence: "Opening Annual.idml",
   *  "Creating a new document". */
  action: string;
  /** The plugin asking, when a plugin asks (`host.documents.open`). */
  requester?: string | null;
  /** The document that would open in place of this one, when it has a
   *  name. */
  documentName?: string | null;
}

/** A question waiting for its answer, as the prompt renders it. */
export interface PendingReplace {
  readonly id: number;
  readonly action: string;
  readonly requester: string | null;
  readonly documentName: string | null;
  /** True when a save is registered: the prompt offers Save. */
  readonly canSave: boolean;
  /** Settle the question; the first answer wins. */
  answer(answer: ReplaceAnswer): void;
}

/** Where the open document's dirty flag is read. */
export interface DirtySource {
  documentMeta(): Promise<{ dirty: boolean }>;
}

/** One editor's question queue, prompt surfaces and save (plan task E1:
 *  the replace question is about THIS editor's document). */
interface GuardState {
  seq: number;
  surfaces: number;
  saver: (() => void | Promise<void>) | null;
  readonly queue: PendingReplace[];
  readonly listeners: Set<() => void>;
  readonly prompts: ReplacePrompts;
}

/** The question queue a prompt renders. */
export interface ReplacePrompts {
  subscribe(listener: () => void): () => void;
  current(): PendingReplace | null;
}

const GUARD = scoped("replaceGuard", (): GuardState => {
  const queue: PendingReplace[] = [];
  const listeners = new Set<() => void>();
  return {
    seq: 0,
    surfaces: 0,
    saver: null,
    queue,
    listeners,
    prompts: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      current: () => queue[0] ?? null,
    },
  };
});

const notify = (g: GuardState): void => {
  for (const l of [...g.listeners]) l();
};

/** The question queue `scope`'s prompt renders (one at a time, oldest
 *  first). */
export function replacePrompts(scope: EditorScope): ReplacePrompts {
  return scope.get(GUARD).prompts;
}

/** A prompt that renders `replacePrompts` mounts itself here; while one is
 *  mounted the question is asked through it instead of `confirm`. Returns
 *  the detach. */
export function attachReplacePromptSurface(scope: EditorScope): () => void {
  const g = scope.get(GUARD);
  g.surfaces += 1;
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    g.surfaces -= 1;
    // A surface going away with questions open (an unmount mid-prompt)
    // answers them the safe way rather than leaving the opens hanging.
    if (g.surfaces === 0) {
      for (const p of [...g.queue]) p.answer("cancel");
    }
  };
}

/** Register what `scope`'s prompt Save button runs (the app's save, the
 *  one Cmd+S runs). Without one the prompt offers Don't save and Cancel
 *  only. Returns the unregister. */
export function setDocumentSaver(
  scope: EditorScope,
  save: () => void | Promise<void>,
): () => void {
  const g = scope.get(GUARD);
  g.saver = save;
  return () => {
    if (g.saver === save) g.saver = null;
  };
}

function ask(g: GuardState, request: ReplaceRequest): Promise<ReplaceAnswer> {
  return new Promise<ReplaceAnswer>((resolve) => {
    const id = ++g.seq;
    g.queue.push({
      id,
      action: request.action,
      requester: request.requester ?? null,
      documentName: request.documentName ?? null,
      canSave: g.saver !== null,
      answer(answer) {
        const idx = g.queue.findIndex((p) => p.id === id);
        if (idx === -1) return; // already settled
        g.queue.splice(idx, 1);
        resolve(answer);
        notify(g);
      },
    });
    notify(g);
  });
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/** The platform `confirm` text, for when no prompt is mounted. Names the
 *  save chord of THIS platform (F-05: it said Cmd+S everywhere). */
export function replaceConfirmText(request: ReplaceRequest): string {
  const who = request.requester
    ? t(REPLACE.requester, {
        requester: request.requester,
        document: request.documentName ?? t(REPLACE.aDocument),
      })
    : "";
  return (
    t(REPLACE.unsaved, { who, action: request.action }) +
    "\n\n" +
    t(REPLACE.saveFirst, { chord: IS_MAC ? "⌘S" : "Ctrl+S" })
  );
}

/**
 * Ask before `request` replaces the open document. Resolves `true` when it
 * is safe to go on: there is no document, it has no unsaved edits, the user
 * chose Don't save, or chose Save and the save left it clean. `false` keeps
 * the document; the caller must then change nothing.
 */
export async function confirmReplace(
  scope: EditorScope,
  client: DirtySource,
  request: ReplaceRequest,
): Promise<boolean> {
  const g = scope.get(GUARD);
  // A placement armed against the OUTGOING document must not resolve
  // into the incoming one. Clicking a menu already cancels it (a click
  // outside the canvas stands the placement down), but the keyboard
  // route — Cmd+N with an image loaded — reaches here with the placement
  // still armed, and the next canvas click would drop that image into a
  // document the user never chose it for.
  cancelPendingPlacement(scope);
  let dirty = false;
  try {
    dirty = (await client.documentMeta()).dirty;
  } catch {
    // No document, or the worker is not answering — nothing to lose.
    return true;
  }
  if (!dirty) return true;
  if (g.surfaces === 0) return globalThis.confirm(replaceConfirmText(request));
  const answer = await ask(g, request);
  if (answer === "discard") return true;
  if (answer === "cancel") return false;
  const save = g.saver;
  if (!save) return false;
  try {
    await save();
  } catch {
    return false;
  }
  try {
    return !(await client.documentMeta()).dirty;
  } catch {
    return false;
  }
}

/** `confirmReplace` for an editor-shaped caller (File ▸ New, File ▸ Open,
 *  the library, New from a brief): `what` is the action. */
export function confirmDiscard(
  editor: { client: DirtySource; scope: EditorScope },
  what: string,
): Promise<boolean> {
  return confirmReplace(editor.scope, editor.client, { action: what });
}

/** The error a plugin open rejects with when the user keeps the document:
 *  an `AbortError`, the platform's name for "the user cancelled". */
export function replaceDeclinedError(): Error {
  const message = "the user kept the open document";
  if (typeof DOMException === "function") {
    return new DOMException(message, "AbortError");
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/** True for the error `replaceDeclinedError` makes (or any AbortError). */
export function isReplaceDeclined(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
