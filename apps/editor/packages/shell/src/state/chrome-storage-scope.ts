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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Which workspace's chrome state a localStorage key belongs to.
//
// THE BUG THIS PREVENTS, which is not hypothetical. Solo mode
// (`?solo=paged.draw`) runs the cockpit under the mode id `"design"`,
// because reusing an existing id keeps the closed `WorkflowMode` union
// closed. But `paged.cockpit.v1` is ONE blob keyed BY MODE ID
// (`cockpit-persistence.ts`), so solo and the ordinary editor would
// write their right-dock tabs into the same slot:
//
//   · solo writes [draw stroke, draw appearance] under `design`
//   · the ordinary editor reads them, cannot resolve either id, and
//     `RightDock` DROPS unresolvable tabs silently → "No panel open."
//
// A user's Design workspace would quietly empty because they once
// opened a different application on the same origin, and nothing
// anywhere would report it. Playwright cannot catch this — every test
// gets a fresh context — so it is production-only nondeterminism.
//
// `paged.workflowMode` has the same shape of problem pointing the other
// way: solo must not INHERIT the mode a normal session left behind, or
// it boots into `prepress`, finds no registered mode of that name, and
// renders with no left panel at all.
//
// SET IT BEFORE THE SHELL MOUNTS. The scope is read when the stores below
// it first load; changing it afterwards would leave already-read state
// under the old key. It is deliberately not React state: the scope is
// fixed by the editor's profile for the editor's lifetime, and kept in
// the editor's scope (plan task E1), so two editors with different
// profiles on one page keep their workspaces apart.

import { scoped, type EditorScope } from "./editor-scope";

const SUFFIX = scoped("chromeStorageScope", () => ({ suffix: "" }));

/** Namespace every chrome storage key of `scope`'s editor. `""` is the
 *  ordinary editor. Solo passes `.solo.<profile>`, e.g. `.solo.paged.draw`. */
export function setChromeStorageScope(
  scope: EditorScope,
  suffix: string,
): void {
  scope.get(SUFFIX).suffix = suffix;
}

/** The scoped form of a base key. */
export function scopedChromeKey(scope: EditorScope, base: string): string {
  const { suffix } = scope.get(SUFFIX);
  return suffix ? `${base}${suffix}` : base;
}

/** The active scope — for diagnostics and for tests that assert the two
 *  workspaces really are separate. */
export function chromeStorageScope(scope: EditorScope): string {
  return scope.get(SUFFIX).suffix;
}
