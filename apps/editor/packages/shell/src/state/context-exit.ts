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

// One way out of an edit context (editor ADR 1214; the interaction
// specification's D-04, UXI-CTX-006, UXI-CTX-007).
//
// An edit context used to end in five ways with five meanings: Escape
// cancelled it, a press outside the frame committed it, the breadcrumb
// only popped it (neither commit nor cancel ran), picking another tool and
// selecting something else committed it, and a document switch left it on
// the stack. `resolveContextExit` is the one decision every one of them
// now asks: from WHY the user is leaving, WHETHER the context holds
// unfinished work and the module's declared `exitPolicy`, it answers
//
//   commit   keep the work: the context's onCommit, then onExit;
//   cancel   revert the work: onCancel, then onExit;
//   pop      leave with nothing to keep or revert: onExit only (a clean
//            context on a document switch: the document itself goes);
//   ask      the user decides: Commit, Discard (cancel) or Cancel (stay).
//
// The table (rows: the reason; columns: the context's state and policy):
//
//                     clean          dirty, commit-  dirty, ask   dirty,
//                                    if-safe                      discard-allowed
//   escape            commit*/cancel ask             ask          cancel
//   click-outside     commit         commit          ask          commit
//   breadcrumb        commit         commit          ask          commit
//   tool-pick         commit         commit          ask          commit
//   selection-change  commit         commit          ask          commit
//   profile-change    commit         commit          ask          commit
//   document-switch   pop            ask             ask          cancel
//
//   * Escape commits a clean context whose policy is commit-if-safe (the
//     module keeps what is done, as paged.slide's chart sheet and
//     paged.image do), and cancels it otherwise (there is nothing to
//     revert, and the module's onCancel is how it closes its session).
//
// Nothing is ever discarded without either an explicit cancel or the
// module's own declaration that discarding is allowed. A dirty context on
// Escape is normally resolved one tier earlier, by its sub-edit (a cell
// being typed, a transform box: the arbiter's `context-dirty` tier, ADR
// 1207); the escape row applies to a dirty context that has no sub-edit of
// its own.

import type { EditContextExitPolicy } from "@paged-media/plugin-api";

import { scoped, type EditorScope } from "./editor-scope";

/** Why the user is leaving the context. */
export type ContextExitReason =
  | "escape"
  | "click-outside"
  | "breadcrumb"
  | "tool-pick"
  | "selection-change"
  | "document-switch"
  | "profile-change";

/** How the module lets the host leave its dirty context (the contract's
 *  `exitPolicy`). */
export type ContextExitPolicy = EditContextExitPolicy;

/** What leaving does. */
export type ContextExitResolution = "commit" | "cancel" | "ask" | "pop";

/** The answer of the resolve prompt: Commit, Discard, or Cancel (stay). */
export type ContextExitAnswer = "commit" | "discard" | "cancel";

/** A context that declares no policy: the host's behaviour before the
 *  field existed (Escape cancels, every other exit commits). */
export const DEFAULT_EXIT_POLICY: ContextExitPolicy = "discard-allowed";

export interface ContextExitState {
  /** Does the context hold unfinished work (its `isDirty()`)? */
  dirty: boolean;
  /** The module's declared policy; absent is {@link DEFAULT_EXIT_POLICY}. */
  exitPolicy?: ContextExitPolicy | null;
}

/** The one exit decision (see the module header for the table). Pure. */
export function resolveContextExit(
  reason: ContextExitReason,
  { dirty, exitPolicy }: ContextExitState,
): ContextExitResolution {
  const policy = exitPolicy ?? DEFAULT_EXIT_POLICY;
  if (!dirty) {
    if (reason === "document-switch") return "pop";
    if (reason === "escape")
      return policy === "commit-if-safe" ? "commit" : "cancel";
    return "commit";
  }
  if (reason === "escape" || reason === "document-switch")
    return policy === "discard-allowed" ? "cancel" : "ask";
  return policy === "ask" ? "ask" : "commit";
}

/** What the prompt's answer makes of an `ask`. Null: the user stays. */
export function resolutionOfAnswer(
  answer: ContextExitAnswer,
): "commit" | "cancel" | null {
  if (answer === "commit") return "commit";
  if (answer === "discard") return "cancel";
  return null;
}

// ── the resolve prompt ──────────────────────────────────────────────
//
// An `ask` is a small question, Commit / Discard / Cancel, rendered by
// `<ContextExitPrompt>` (chrome/ContextExitPrompt.tsx, mounted by the
// edit-context controller) from this per-editor queue. With no prompt
// mounted (a host that renders no shell, the unit tests) the answer is
// Commit: the work is kept, never discarded unasked.

/** What is being asked. */
export interface ContextExitRequest {
  /** The context's name as the user reads it. */
  label: string;
  reason: ContextExitReason;
}

/** A question waiting for its answer, as the prompt renders it. */
export interface PendingContextExit extends ContextExitRequest {
  readonly id: number;
  /** Settle the question; the first answer wins. */
  answer(answer: ContextExitAnswer): void;
}

/** The question queue a prompt renders. */
export interface ContextExitPrompts {
  subscribe(listener: () => void): () => void;
  current(): PendingContextExit | null;
}

interface PromptState {
  seq: number;
  surfaces: number;
  readonly queue: PendingContextExit[];
  readonly listeners: Set<() => void>;
  readonly prompts: ContextExitPrompts;
}

const PROMPTS = scoped("contextExitPrompts", (): PromptState => {
  const queue: PendingContextExit[] = [];
  const listeners = new Set<() => void>();
  return {
    seq: 0,
    surfaces: 0,
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

const notifyPrompts = (s: PromptState): void => {
  for (const l of [...s.listeners]) l();
};

/** The question queue `scope`'s prompt renders, oldest first. */
export function contextExitPrompts(scope: EditorScope): ContextExitPrompts {
  return scope.get(PROMPTS).prompts;
}

/** A prompt that renders `contextExitPrompts` mounts itself here; while one
 *  is mounted the question is asked through it. Returns the detach; the
 *  last surface going away answers open questions Cancel (the context
 *  stays, nothing is lost). */
export function attachContextExitPromptSurface(scope: EditorScope): () => void {
  const s = scope.get(PROMPTS);
  s.surfaces += 1;
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    s.surfaces -= 1;
    if (s.surfaces === 0) for (const p of [...s.queue]) p.answer("cancel");
  };
}

/** Ask how to leave a dirty context. Resolves Commit at once when no
 *  prompt is mounted. */
export function askContextExit(
  scope: EditorScope,
  request: ContextExitRequest,
): Promise<ContextExitAnswer> {
  const s = scope.get(PROMPTS);
  if (s.surfaces === 0) return Promise.resolve("commit");
  return new Promise<ContextExitAnswer>((resolve) => {
    const id = ++s.seq;
    s.queue.push({
      id,
      label: request.label,
      reason: request.reason,
      answer(answer) {
        const idx = s.queue.findIndex((p) => p.id === id);
        if (idx === -1) return; // already settled
        s.queue.splice(idx, 1);
        resolve(answer);
        notifyPrompts(s);
      },
    });
    notifyPrompts(s);
  });
}

/** Is a resolve question open in `scope` (the arbiter's modal tier)? */
export function contextExitAsking(scope: EditorScope): boolean {
  return scope.get(PROMPTS).queue.length > 0;
}
