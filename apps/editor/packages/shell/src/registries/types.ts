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

// Cross-registry shared types. Kept in their own module so each
// registry file can be read top-down without forward references.
//
// ONE DEFINITION (ADR 226). Every contribution type a plugin can author
// is defined once, in `@paged-media/plugin-api`. The shell's registry
// types import it and either USE it as is (an alias) or EXTEND it with
// shell-internal fields (`interface X extends Api.X { … }`). The shell
// never keeps a copy of a contract shape, so the two cannot drift.

import type * as Api from "@paged-media/plugin-api";

/**
 * Returned by every `register` call so callers can clean up at
 * unmount time. The contract's `Disposable`.
 */
export type Disposable = Api.Disposable;

/**
 * Initial dock edge for a panel. Users may rearrange after mount;
 * this is initial-placement-only. The contract's `DockEdge`.
 */
export type DockEdge = Api.DockEdge;

/**
 * Predicate evaluated against application state to decide whether
 * a contribution is visible / enabled. The contract's
 * `VisibilityPredicate`.
 *
 * The string form (e.g. `"selection.hasType('TextFrame')"`) is the
 * future bundle-friendly DSL; today only the function form is
 * implemented. The string variant resolves to the always-false
 * predicate so contributions that use the DSL are inert until the
 * evaluator lands.
 */
export type VisibilityPredicate = Api.VisibilityPredicate;

/**
 * Holds when a contribution authored against the contract (`Contract`)
 * registers in the shell's registry (`Shell`) unchanged; a reference
 * whose `Contract` does not satisfy `Shell` fails the typecheck.
 *
 * `interface Shell extends Contract` proves only the other direction: a
 * shell contribution is a contract contribution. A plugin's contribution
 * reaches the shell registry typed as the CONTRACT type, so the shell's
 * additions must stay optional and its narrowings must still accept what
 * the contract allows. Each extended contribution type states that
 * beside its definition:
 *
 *     export type _XRegistrable = Registrable<X, Api.X>;
 *
 * (The registries' `register` methods cannot catch it on their own:
 * TypeScript compares method parameters bivariantly.)
 */
export type Registrable<Shell, Contract extends Shell> = Contract;

/**
 * Evaluate a {@link VisibilityPredicate} against application state.
 *
 * THE ONE EVALUATOR. It lived inside `keybinding.ts` and was therefore
 * the reason `when` was honoured by exactly one of the five registries
 * that declare it — the other four had no way to ask without copying
 * it. Sharing it is what lets `when` mean the same thing everywhere,
 * which is the only way a contribution author can trust it.
 *
 * Absent ⇒ enabled: a contribution that says nothing is available.
 * A THROWING predicate ⇒ DISABLED, deliberately. A predicate that
 * cannot decide has not established that the command is safe to offer,
 * and offering it anyway is how a broken guard becomes a live command.
 *
 * The string DSL form is inert (always false) until an evaluator lands
 * — the same posture the type documents.
 */
export function isEnabled(
  when: VisibilityPredicate | undefined,
  getState: (() => unknown) | undefined,
): boolean {
  if (when === undefined) return true;
  if (typeof when === "function") {
    try {
      return Boolean(when(getState?.()));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * ADR 024 — may a panel be OFFERED where the user currently is?
 *
 * `false` only when ANOTHER edit context claims this panel and that
 * context is not the active one. Deliberately narrow:
 *
 *   · a panel no context claims stays offered, because host panels and
 *     the selection-driven plugin panels (paged.image's adjustments on
 *     a selected frame) are legitimately usable without entering
 *     anything;
 *   · the ACTIVE context's own panels stay offered, obviously;
 *   · only a panel that is somebody ELSE'S content surface is hidden —
 *     "Vector stroke" while editing a Word document is a control for
 *     content that is not on screen and cannot be reached from here.
 *
 * Pure and exported so it can be tested without a shell: `state` is the
 * `PagedEditor` handle, read structurally rather than by type, because
 * this lives below the module that defines it.
 */
export function panelBelongsHere(state: unknown, panelId: string): boolean {
  const s = state as {
    editContext?: { type?: string } | null;
    registries?: { editContexts?: { list?: () => unknown[] } };
  } | null;
  const list = s?.registries?.editContexts?.list?.();
  if (!list) return true; // No registry to ask — offer it.
  const activeType = s?.editContext?.type ?? null;
  for (const raw of list) {
    const c = raw as { type?: string; panelIds?: readonly string[] };
    if (!c.panelIds?.includes(panelId)) continue;
    // Claimed by the active context → offered.
    if (c.type === activeType) return true;
    // Standing in no context → offered. A plugin's frame panel is where
    // a user STARTS with that plugin (the sheet's Workbook opens or makes
    // a workbook); greying it until the user is already inside the
    // feature hid the feature behind itself.
    if (activeType === null) return true;
    // Inside ANOTHER content type → not offered (a control for content
    // that is not on screen).
    return false;
  }
  return true;
}
