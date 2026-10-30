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

// Doc ADR 614 (content controls) — a Word document's inline content
// controls, edited from the caret: when the caret stands in a control the
// Content control panel shows it, and its buttons are the engine's one-step
// mutations (engine ADR 1052): toggle a checkbox, choose an item, set a
// date or a text. The host has no anchored popover door, so the "popover"
// is a small docked panel the caret opens, as the References dialogs are.

import type { BundleHost } from "@paged-media/plugin-api";

/** A content control as the story read gives it. */
export interface ControlInfo {
  id: string;
  kind: string;
  tag?: string | null;
  alias?: string | null;
  lock?: string | null;
  showingPlaceholder?: boolean;
  checked?: boolean | null;
  items?: Array<{ display: string; value: string }>;
  value?: string | null;
  dateFormat?: string | null;
}

/** The control at the caret, with its story and its shown text. */
export interface ControlAtCaret {
  storyId: string;
  text: string;
  control: ControlInfo;
}

interface ReadRun {
  text: string;
  control?: ControlInfo | null;
}

const utf8 = new TextEncoder();

/** The control whose runs hold content offset `at` (UTF-8 bytes, a
 *  paragraph mark one byte), or `null`. A caret at either edge of the
 *  control's text counts as inside it. */
export function controlAt(
  paragraphs: ReadonlyArray<{ runs: ReadonlyArray<ReadRun> }>,
  at: number,
): { control: ControlInfo; text: string } | null {
  let offset = 0;
  for (const p of paragraphs) {
    let i = 0;
    while (i < p.runs.length) {
      const run = p.runs[i];
      const len = utf8.encode(run.text).length;
      if (!run.control) {
        offset += len;
        i += 1;
        continue;
      }
      // A control's runs, contiguous.
      const id = run.control.id;
      let text = "";
      const start = offset;
      while (i < p.runs.length && p.runs[i].control?.id === id) {
        text += p.runs[i].text;
        offset += utf8.encode(p.runs[i].text).length;
        i += 1;
      }
      if (at >= start && at <= offset) return { control: run.control, text };
    }
    offset += 1;
  }
  return null;
}

/** The control at the user's caret, read from the host. */
export async function controlAtCaret(
  host: BundleHost,
): Promise<ControlAtCaret | null> {
  const sel = host.text?.selection() ?? null;
  if (!sel || !host.supports("document.readStory@1")) return null;
  const content = (await host.document.storyContent(sel.storyId)) as {
    paragraphs: Array<{ runs: ReadRun[] }>;
  } | null;
  if (!content) return null;
  const hit = controlAt(content.paragraphs, sel.start);
  return hit ? { storyId: sel.storyId, ...hit } : null;
}

/** The engine mutation (engine ADR 1052) a control action is. */
export type ControlAction =
  | { kind: "toggle" }
  | { kind: "choose"; index: number }
  | { kind: "set"; value: string };

export function controlMutation(
  at: ControlAtCaret,
  action: ControlAction,
): { op: string; args: Record<string, unknown> } {
  const base = { storyId: at.storyId, controlId: at.control.id };
  switch (action.kind) {
    case "toggle":
      return { op: "toggleContentControl", args: base };
    case "choose":
      return {
        op: "chooseContentControlItem",
        args: { ...base, index: action.index },
      };
    case "set":
      return {
        op: "setContentControlValue",
        args: { ...base, value: action.value },
      };
  }
}

/** Apply one action: one undo step. `false` when the engine refused it (a
 *  locked control, a value its kind does not take). */
export async function applyControlAction(
  host: BundleHost,
  at: ControlAtCaret,
  action: ControlAction,
): Promise<boolean> {
  const out = await host.document.mutate(
    controlMutation(at, action) as never,
  );
  return out.applied;
}

/** A tiny store of the control at the caret, for the panel. */
export interface ControlStore {
  get(): ControlAtCaret | null;
  set(next: ControlAtCaret | null): void;
  subscribe(listener: () => void): () => void;
}

export function createControlStore(): ControlStore {
  let current: ControlAtCaret | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next) {
      current = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
