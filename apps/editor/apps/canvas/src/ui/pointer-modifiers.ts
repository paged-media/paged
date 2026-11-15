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

// The modifiers of a canvas pointer sample, as the canvas hands them to a
// tool, the path-edit session and an edit context: Meta is `cmd` and
// Control is `ctrl`, two flags, never one fused "Cmd or Ctrl". The rules
// that read them decide per platform which key is meant: the snapping
// bypass is the platform's primary modifier, Cmd on macOS and Ctrl
// elsewhere (`snapBypassHeld`, editor ADR 1226). A fused flag handed Ctrl
// on as Cmd, which is the bypass only on macOS, so a dragged anchor still
// snapped with Ctrl held on Windows and Linux (and Ctrl bypassed on macOS).

/** A pointer sample's modifier flags. */
export interface PointerModifierFlags {
  shift: boolean;
  alt: boolean;
  /** The Meta key (Cmd on macOS). */
  cmd: boolean;
  /** The Control key. */
  ctrl: boolean;
}

/** The modifier flags of a DOM pointer (or mouse) event. */
export function pointerModifiersOf(
  e: Pick<MouseEvent, "shiftKey" | "altKey" | "metaKey" | "ctrlKey">,
): PointerModifierFlags {
  return {
    shift: e.shiftKey,
    alt: e.altKey,
    cmd: e.metaKey,
    ctrl: e.ctrlKey,
  };
}
