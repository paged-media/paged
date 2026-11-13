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

// The bottom bar's Editing aids control (editor ADR "Editing aids and
// Proof view"; the redesign strategy's §4.1): one button that opens the
// aids as independent, remembered switches, and Proof view below them.
// The same toggles as View ▸ Editing aids; an aid the engine cannot do yet
// is listed, disabled, with its reason.

import { useSyncExternalStore } from "react";
import { useStrings } from "@paged-media/strings";

import { Icon } from "../icons";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  EDITING_AID_LABELS,
  isProofMode,
  UNSUPPORTED_AIDS,
  unsupportedAidReason,
} from "../state/editing-aids";
import { useEditorScope } from "../state/editor-scope";
import { useOptionalScreenMode } from "../state/screen-mode-context";
import {
  EDITING_AID_TOGGLES,
  getViewToggle,
  setViewToggle,
  subscribeViewToggles,
} from "../state/view-toggles";

export function EditingAidsControl({
  side = "top",
}: { side?: "top" | "bottom" } = {}) {
  const strings = useStrings();
  const scope = useEditorScope();
  const screen = useOptionalScreenMode();
  // The aids' states as one string: a toggle anywhere re-renders the list.
  const states = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () =>
      EDITING_AID_TOGGLES.map((a) => (getViewToggle(scope, a) ? 1 : 0)).join(
        "",
      ),
    () => "",
  );
  const proof = isProofMode(screen?.screenMode);
  const label = strings.t(EDITING_AID_LABELS.control);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-editing-aids-control
        data-proof-view={proof ? "on" : "off"}
        aria-label={label}
        title={label}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 26,
          border: "1px solid var(--pg-border)",
          borderRadius: "var(--radius-md)",
          background: proof ? "var(--pg-primary)" : "transparent",
          color: proof ? "var(--pg-primary-fg)" : "var(--chrome-menu-text)",
          cursor: "pointer",
        }}
      >
        <Icon name={proof ? "ui-eye-off" : "ui-eye"} size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} sideOffset={4}>
        {EDITING_AID_TOGGLES.map((aid, i) => {
          const unsupported = UNSUPPORTED_AIDS[aid] === true;
          const name = strings.t(EDITING_AID_LABELS[aid]);
          return (
            <DropdownMenuCheckboxItem
              key={aid}
              data-editing-aid={aid}
              checked={states[i] === "1"}
              disabled={unsupported || proof}
              title={unsupportedAidReason(aid) ?? undefined}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => setViewToggle(scope, aid, on === true)}
            >
              {unsupported
                ? strings.t(EDITING_AID_LABELS.notSupported, { aid: name })
                : name}
            </DropdownMenuCheckboxItem>
          );
        })}
        {screen && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              data-editing-aid="proofView"
              checked={proof}
              onCheckedChange={(on) =>
                screen.setScreenMode(on === true ? "preview" : "normal")
              }
            >
              {strings.t(EDITING_AID_LABELS.proofView)}
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
