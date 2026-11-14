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

// The design constraints of the open document and what was last measured
// of them, per editor (editor ADR 1233): the source hook writes, the
// glyphs, the panel and the issue fixes read. And the fix preview: the
// boxes a suggested fix would move items to, drawn while the fix has the
// pointer or the focus (a preview only: nothing is sent to the engine).

import { useSyncExternalStore } from "react";

import {
  createValueStore,
  scoped,
  useScoped,
  type EditorScope,
} from "@paged-media/shell";

import type { Box, ConstraintResult } from "./evaluate";
import type { Constraint } from "./model";

export interface ConstraintSnapshot {
  constraints: readonly Constraint[];
  /** By constraint id; a constraint not measured yet has none. */
  results: ReadonlyMap<string, ConstraintResult>;
  /** A measurement is running (the results are the last one's). */
  pending: boolean;
}

const EMPTY: ConstraintSnapshot = {
  constraints: [],
  results: new Map(),
  pending: false,
};

const STATE = scoped("designConstraints", () =>
  createValueStore<ConstraintSnapshot>(EMPTY),
);

/** A previewed fix: where it would put what it moves. */
export interface FixPreview {
  /** What it previews (an issue id). */
  id: string;
  ghosts: ReadonlyArray<{ pageId: string; box: Box }>;
}

const PREVIEW = scoped("fixPreview", () =>
  createValueStore<FixPreview | null>(null),
);

export function constraintStateOf(scope: EditorScope): ConstraintSnapshot {
  return scope.get(STATE).get();
}

export function setConstraintState(
  scope: EditorScope,
  next: ConstraintSnapshot,
): void {
  scope.get(STATE).set(next);
}

/** This editor's constraints and results, re-read when they change. */
export function useConstraintState(): ConstraintSnapshot {
  const store = useScoped(STATE);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Show (or, with null, clear) a fix's preview. */
export function setFixPreview(
  scope: EditorScope,
  preview: FixPreview | null,
): void {
  scope.get(PREVIEW).set(preview);
}

export function fixPreviewOf(scope: EditorScope): FixPreview | null {
  return scope.get(PREVIEW).get();
}

export function useFixPreview(): FixPreview | null {
  const store = useScoped(PREVIEW);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
