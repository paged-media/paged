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

// The canvas's pointer modifiers (editor ADR 1226): Meta and Control are
// handed on as two flags, so the snapping bypass is the platform's primary
// modifier for every lane — the path-edit session's anchor drag included,
// which used to receive Ctrl fused into Cmd and snapped with Ctrl held on
// Windows and Linux.

import { describe, expect, test } from "bun:test";

import { snapBypassHeld } from "@paged-media/shell";

import { pointerModifiersOf } from "../../../src/ui/pointer-modifiers";

const ON_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const held = (over: Partial<Record<string, boolean>> = {}) =>
  pointerModifiersOf({
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...over,
  });

describe("pointerModifiersOf", () => {
  test("Meta is cmd and Control is ctrl: two flags, never one fused", () => {
    expect(held({ metaKey: true })).toEqual({
      shift: false,
      alt: false,
      cmd: true,
      ctrl: false,
    });
    expect(held({ ctrlKey: true })).toEqual({
      shift: false,
      alt: false,
      cmd: false,
      ctrl: true,
    });
    expect(held({ shiftKey: true, altKey: true })).toEqual({
      shift: true,
      alt: true,
      cmd: false,
      ctrl: false,
    });
  });

  test("the platform's primary modifier holds the snapping bypass (Cmd on macOS, Ctrl elsewhere); the other key does not", () => {
    const bypass = ON_MAC ? { metaKey: true } : { ctrlKey: true };
    const other = ON_MAC ? { ctrlKey: true } : { metaKey: true };
    expect(snapBypassHeld(held())).toBe(false);
    expect(snapBypassHeld(held(bypass))).toBe(true);
    expect(snapBypassHeld(held(other))).toBe(false);
  });
});
