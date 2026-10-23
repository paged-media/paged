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

// The iframe bridge's messages (plan E6): the embedding API over
// postMessage. The host sends `paged:init` with the editor's config, then
// calls the handle's methods (`paged:call`, answered by `paged:reply`); the
// editor sends `paged:ready`, events (`paged:event`) and the host actions it
// needs the host for (`paged:action`, answered by `paged:action-reply`).
// Bytes travel as transferred ArrayBuffers.

import type { EditorConfig, EditorEvent, EditorHandle } from "./create-editor";

/** The handle's methods a host reaches through the frame: the ones whose
 *  arguments and answers are data. */
export const BRIDGED_METHODS = [
  "load",
  "newDocument",
  "save",
  "exportPdf",
  "fields",
  "getFieldValues",
  "setFieldValues",
  "setRole",
  "setTheme",
] as const satisfies readonly (keyof EditorHandle)[];

export type BridgedMethod = (typeof BRIDGED_METHODS)[number];

/**
 * Runs `paged.*` script source in the framed editor and answers its console
 * output and error. Dev and demo builds only (the docs' scripting
 * playground): a production frame refuses it. It replaces the older
 * `paged:run` protocol of `playground/IframeScriptBridge.tsx`, which stays
 * for the docs site until its playground calls this.
 */
export const SCRIPT_METHOD = "runScript";

/** What the frame's editor is made with: the config without functions, and
 *  the names of the host actions the host answers. */
export type FrameConfig = Omit<EditorConfig, "actions"> & {
  actions?: readonly ("save" | "submit" | "close" | "back")[];
};

export type HostToFrame =
  | { type: "paged:init"; config: FrameConfig }
  | {
      type: "paged:call";
      id: number;
      method: BridgedMethod | typeof SCRIPT_METHOD;
      args: unknown[];
    }
  | {
      type: "paged:action-reply";
      id: number;
      ok: boolean;
      error?: string;
    };

export type FrameToHost =
  | { type: "paged:loaded" }
  | { type: "paged:ready" }
  | { type: "paged:failed"; error: string }
  | {
      type: "paged:reply";
      id: number;
      ok: boolean;
      value?: unknown;
      error?: string;
    }
  | { type: "paged:event"; event: EditorEvent }
  | {
      type: "paged:action";
      id: number;
      action: "save" | "submit" | "close" | "back";
      bytes?: Uint8Array;
      name?: string;
    };

/** The ArrayBuffers in `value`, to transfer rather than copy. */
export function transferables(value: unknown): Transferable[] {
  const out: Transferable[] = [];
  const walk = (v: unknown) => {
    if (v instanceof Uint8Array) {
      if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength)
        out.push(v.buffer as ArrayBuffer);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...new Set(out)];
}

/** Origins allowed to drive an embedded editor: the deploy's list
 *  (`VITE_EMBED_ORIGINS`, comma-separated) and the editor's own origin. */
export function embedOrigins(
  configured: string | undefined,
  self: string,
): string[] {
  const list = (configured ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return [...new Set([self, ...list])];
}
