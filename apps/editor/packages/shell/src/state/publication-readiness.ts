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

// The publication's readiness against its contract, per editor (editor ADR
// 1236; the UX strategy's Concept I): the canvas app assesses the document
// against the contract it carries and publishes the outcome here; the
// header's badge beside the save status shows it, and a click opens the
// contract. No contract: nothing shows.

import { useSyncExternalStore } from "react";

import {
  createValueStore,
  scoped,
  useScoped,
  type EditorScope,
} from "./editor-scope";

export type ReadinessLevel = "blocked" | "attention" | "ready" | "approved";

export interface PublicationReadiness {
  level: ReadinessLevel;
  /** How many requirements are not met. */
  open: number;
  /** One line per unmet requirement, for the badge's tooltip. */
  details: readonly string[];
}

interface ReadinessSlot {
  readiness: PublicationReadiness | null;
  /** Opens the contract (set by the app). */
  open: (() => void) | null;
}

const READINESS = scoped("publicationReadiness", () =>
  createValueStore<ReadinessSlot>({ readiness: null, open: null }),
);

/** The app publishes the assessment (null: the document has no contract). */
export function setPublicationReadiness(
  scope: EditorScope,
  readiness: PublicationReadiness | null,
): void {
  const store = scope.get(READINESS);
  store.set({ ...store.get(), readiness });
}

/** How the badge opens the contract. */
export function setReadinessOpener(
  scope: EditorScope,
  open: (() => void) | null,
): void {
  const store = scope.get(READINESS);
  store.set({ ...store.get(), open });
}

export function publicationReadinessOf(
  scope: EditorScope,
): PublicationReadiness | null {
  return scope.get(READINESS).get().readiness;
}

/** This editor's readiness and its opener, re-read when they change. */
export function usePublicationReadiness(): ReadinessSlot {
  const store = useScoped(READINESS);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
