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

// What one editor shows the test and demo tooling of the page it runs in
// (plan task E1): the `__canvas` automation handle, the demo runner, the
// overlay-signal writer, the last pointer event and the last crash. The
// editor fills them, in dev and demo builds only; it publishes nothing on
// the page itself. The page entry (apps/canvas/src/entry.tsx) puts them on
// `globalThis` for the editor it mounted, so an embedding host's page
// never gets them.

import { scoped, type EditorScope } from "./editor-scope";

export interface DebugHandles {
  /** `window.__canvas`: the shell's automation handle. */
  canvas?: unknown;
  /** `window.__demo`: run a demo script against this editor. */
  demo?: unknown;
  /** `window.__overlaySignals`: the overlay-signal writer. */
  overlaySignals?: unknown;
  /** `window.__canvasPointer`: the last canvas pointer event built. */
  pointer?: unknown;
  /** `window.__pagedCrash`: the last crash the shell's boundary caught. */
  crash?: string;
}

const HANDLES = scoped("debugHandles", (): DebugHandles => ({}));

/** `scope`'s handles (read by the page entry, and the journal's crash
 *  section). */
export function debugHandlesOf(scope: EditorScope): Readonly<DebugHandles> {
  return scope.get(HANDLES);
}

/** Fill (or clear, with `undefined`) one of `scope`'s handles. */
export function setDebugHandle<K extends keyof DebugHandles>(
  scope: EditorScope,
  name: K,
  value: DebugHandles[K],
): void {
  const handles = scope.get(HANDLES);
  if (value === undefined) delete handles[name];
  else handles[name] = value;
}

/** Dev and demo builds keep the handles; a production build fills none.
 *  Typed loosely: the shell's tsconfig has no Vite ambient types. */
export function debugHandlesEnabled(): boolean {
  const env = (
    import.meta as unknown as { env?: { PROD?: boolean; MODE?: string } }
  ).env;
  return env?.PROD !== true || env?.MODE === "demo";
}
