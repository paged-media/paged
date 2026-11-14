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

// The objects a change WILL touch, outlined on the canvas before it is made
// (editor ADRs 1233 and 1234): an action's preview and an assistant's
// proposal publish their targets here, and one overlay draws them. One
// owner at a time per editor: the newest preview replaces the last, and an
// owner clears only its own. Nothing here changes the document or the
// selection.

import { createValueStore, scoped, type EditorScope } from "./editor-scope";

export interface PreviewTargets {
  /** Who published them (`actions`, `assistant`). */
  owner: string;
  /** ADR 131 addresses of the objects the change touches. */
  addresses: readonly string[];
  /** The address the user points at in the list, drawn stronger. */
  focus?: string | null;
}

const STORE = scoped("previewTargets", () =>
  createValueStore<PreviewTargets | null>(null),
);

/** `scope`'s preview targets store. */
export function previewTargetsStore(scope: EditorScope) {
  return scope.get(STORE);
}

/** Outline `addresses` for `owner` (replacing any other preview). */
export function showPreviewTargets(
  scope: EditorScope,
  owner: string,
  addresses: readonly string[],
  focus: string | null = null,
): void {
  previewTargetsStore(scope).set({ owner, addresses: [...addresses], focus });
}

/** Stop outlining `owner`'s targets (another owner's stay). */
export function clearPreviewTargets(scope: EditorScope, owner: string): void {
  const store = previewTargetsStore(scope);
  if (store.get()?.owner === owner) store.set(null);
}
