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

// The control bar is an ACCELERATOR, not a second inspector (the UX
// strategy's §5.6; track FI3, editor ADR 1217): it keeps a few common
// fields, and its "More…" opens Properties at the matching field. Focus
// goes to that field; when the field lets go of it (Enter commits, Escape
// restores) it goes back to "More…" through the editor's focus-return
// service (ADR 1206, D-11).

import {
  cockpitActionsOf,
  editorRootOf,
  focusReturnOf,
  queryEditor,
  type EditorScope,
} from "@paged-media/shell";

export const PROPERTIES_PANEL_ID = "paged.properties";
const SURFACE = "properties.more";

/** Where "More…" lands, by the bar's segment. */
export const INSPECTOR_TARGET = {
  /** The first transform field (X) of a selected object. */
  object: '[data-properties-section="object"] input:not([disabled])',
  /** The type size of a caret or range. */
  text: '[data-properties-section="character"] [data-control="characterFontSize"] input',
} as const;

const nextFrame = () =>
  new Promise<void>((resolve) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 16),
  );

/**
 * Open Properties and focus the field `selector` names there (it may take a
 * few frames to mount). Resolves to the field, or null when it never came.
 */
export async function focusInspectorField(
  scope: EditorScope,
  selector: string,
  opener: Element | null,
): Promise<HTMLElement | null> {
  cockpitActionsOf(scope).openPanel?.(PROPERTIES_PANEL_ID, { activate: true });
  let field: HTMLElement | null = null;
  for (let i = 0; i < 30 && !field; i++) {
    await nextFrame();
    field = queryEditor<HTMLElement>(
      editorRootOf(scope),
      `[data-properties-panel] ${selector}`,
    );
  }
  if (!field) return null;
  const focus = focusReturnOf(scope);
  focus.open(SURFACE, opener);
  field.focus();
  if (field instanceof HTMLInputElement) field.select();
  // Settled there (Enter commits, Escape restores, both let go of focus):
  // back to the opener. Focus that moves on to another control stays where
  // the user put it.
  field.addEventListener(
    "blur",
    (e) => {
      if ((e as FocusEvent).relatedTarget) return;
      setTimeout(() => {
        const now = field?.ownerDocument.activeElement;
        if (!now || now === field?.ownerDocument.body) focus.close(SURFACE);
      }, 0);
    },
    { once: true },
  );
  return field;
}
