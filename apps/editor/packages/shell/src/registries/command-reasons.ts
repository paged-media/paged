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

// COMMANDS SAY WHY THEY DO NOT APPLY (editor ADR 1218, amending ADR 249;
// the interaction spec's UXI-CMD-001, CMD-002 and PNL-004; D-16).
//
// A command's `when` answers yes or no. The menus greyed a no and the
// palette hid it, and neither could say what the user should do about it.
// A command now answers `applicability(state)`: one of the vocabulary's
// states (`chrome/applicability.ts`) and, when it is not `here`, a reason
// in words. The common reasons are needs a command declares
// (`commandNeeds`): an open document, a selection, being outside an edit
// context, no text caret, no point editing. The first unmet need is the
// reason, in that order, so "Select an object first" is never said while
// the real obstacle is the edit context the user is standing in.

import { t } from "@paged-media/strings";

import type { CommandApplicability } from "../chrome/applicability";
import { APPLICABILITY } from "../chrome/messages";

export type CommandNeed =
  "document" | "outsideContext" | "noText" | "noPathEdit" | "selection";

/** The editor handle's slices the needs read, structurally (a partial
 *  handle — a standalone mount, a test — is fine). */
interface NeedState {
  document?: { handle?: { pageCount?: number } | null } | null;
  editContext?: { type?: string } | null;
  contentSelection?: { contentSelection?: unknown } | null;
  selection?: {
    elementSelection?: readonly unknown[];
    pathEditMode?: boolean;
  } | null;
}

/** "webFrame" → "web frame": the context a reason names. */
function contextName(type: string | undefined): string {
  return (type ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

/** The first need `state` does not meet, with its state and reason; null
 *  when every need is met. Outside the edit context is `elsewhere` (it
 *  applies, just not where the user stands); the rest are `disabled`. */
export function unmetNeed(
  state: unknown,
  needs: readonly CommandNeed[],
): CommandApplicability | null {
  const s = (state ?? {}) as NeedState;
  for (const need of needs) {
    switch (need) {
      case "document": {
        const handle = s.document?.handle;
        if (!handle || (handle.pageCount ?? 1) === 0)
          return { state: "disabled", reason: t(APPLICABILITY.openDocument) };
        break;
      }
      case "outsideContext":
        if (s.editContext) {
          const name = contextName(s.editContext.type);
          return {
            state: "elsewhere",
            reason: name
              ? t(APPLICABILITY.leaveNamedContext, { context: name })
              : t(APPLICABILITY.leaveContext),
          };
        }
        break;
      case "noText":
        if (s.contentSelection?.contentSelection != null)
          return { state: "disabled", reason: t(APPLICABILITY.leaveText) };
        break;
      case "noPathEdit":
        if (s.selection?.pathEditMode)
          return { state: "disabled", reason: t(APPLICABILITY.leavePathEdit) };
        break;
      case "selection":
        if ((s.selection?.elementSelection?.length ?? 0) === 0)
          return { state: "disabled", reason: t(APPLICABILITY.selectObject) };
        break;
    }
  }
  return null;
}

/** A command's `applicability` from its needs: `here` when all are met,
 *  else the first unmet one. Pair it with the command's `when` (which
 *  stays the yes/no adapter). */
export function commandNeeds(
  ...needs: CommandNeed[]
): (state: unknown) => CommandApplicability {
  return (state) => unmetNeed(state, needs) ?? { state: "here" };
}

/** A `when` that holds exactly when `needs` are met. */
export function whenNeeds(
  ...needs: CommandNeed[]
): (state: unknown) => boolean {
  return (state) => unmetNeed(state, needs) === null;
}
