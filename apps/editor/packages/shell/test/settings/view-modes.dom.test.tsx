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

// The in-memory view options held in React context:
//
//   · `view.screenMode` (screen-mode-context.tsx): Normal by default; the
//     W shortcut toggles Normal and Preview; pure view state.
//   · `view.formattingAffects` / `view.activeWell`
//     (formatting-affects-context.tsx): the fill/stroke cluster's
//     "formatting affects container / text" switch and its active well.
//
// None of them is persisted: a new provider (a reload) starts from the
// defaults, and nothing reaches localStorage.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  SCREEN_MODES,
  ScreenModeProvider,
  useOptionalScreenMode,
  useScreenMode,
} from "../../src/state/screen-mode-context";
import {
  FormattingAffectsProvider,
  useFormattingAffects,
  useOptionalFormattingAffects,
} from "../../src/state/formatting-affects-context";

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("setting view.screenMode", () => {
  const mount = () =>
    renderHook(() => useScreenMode(), { wrapper: ScreenModeProvider });

  test("defaults to normal; the five modes are declared in order", () => {
    covers("setting:view.screenMode");
    expect(mount().result.current.screenMode).toBe("normal");
    expect(SCREEN_MODES.map((m) => m.mode)).toEqual([
      "normal",
      "preview",
      "bleed",
      "slug",
      "presentation",
    ]);
  });

  test("set and the W toggle: Normal ⇄ Preview, and Preview from any other mode", () => {
    covers("setting:view.screenMode");
    const { result } = mount();
    act(() => result.current.togglePreview());
    expect(result.current.screenMode).toBe("preview");
    act(() => result.current.togglePreview());
    expect(result.current.screenMode).toBe("normal");
    act(() => result.current.setScreenMode("bleed"));
    expect(result.current.screenMode).toBe("bleed");
    act(() => result.current.togglePreview());
    expect(result.current.screenMode).toBe("preview");
  });

  test("not persisted: a new provider starts at normal, storage untouched", () => {
    covers("setting:view.screenMode");
    const first = mount();
    act(() => first.result.current.setScreenMode("slug"));
    first.unmount();
    expect(mount().result.current.screenMode).toBe("normal");
    expect(localStorage.length).toBe(0);
  });

  test("outside a provider: the optional hook is null, the strict one throws", () => {
    expect(renderHook(() => useOptionalScreenMode()).result.current).toBeNull();
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useScreenMode())).toThrow(
        /outside ScreenModeProvider/,
      );
    } finally {
      console.error = original;
    }
  });
});

describe("settings view.formattingAffects and view.activeWell", () => {
  const mount = () =>
    renderHook(() => useFormattingAffects(), {
      wrapper: FormattingAffectsProvider,
    });

  test("defaults: formatting affects the container, the fill well is active", () => {
    covers("setting:view.formattingAffects", "setting:view.activeWell");
    const { result } = mount();
    expect(result.current.affects).toBe("container");
    expect(result.current.activeWell).toBe("fill");
  });

  test("toggleAffects flips container ⇄ text; setAffects sets it", () => {
    covers("setting:view.formattingAffects");
    const { result } = mount();
    act(() => result.current.toggleAffects());
    expect(result.current.affects).toBe("text");
    act(() => result.current.toggleAffects());
    expect(result.current.affects).toBe("container");
    act(() => result.current.setAffects("text"));
    expect(result.current.affects).toBe("text");
  });

  test("the active well changes on its own, independent of affects", () => {
    covers("setting:view.activeWell");
    const { result } = mount();
    act(() => result.current.setActiveWell("stroke"));
    expect(result.current.activeWell).toBe("stroke");
    expect(result.current.affects).toBe("container");
  });

  test("not persisted: a new provider starts from the defaults", () => {
    covers("setting:view.formattingAffects", "setting:view.activeWell");
    const first = mount();
    act(() => {
      first.result.current.setAffects("text");
      first.result.current.setActiveWell("stroke");
    });
    first.unmount();
    const second = mount();
    expect(second.result.current.affects).toBe("container");
    expect(second.result.current.activeWell).toBe("fill");
    expect(localStorage.length).toBe(0);
  });

  test("outside a provider the optional hook is null", () => {
    expect(
      renderHook(() => useOptionalFormattingAffects()).result.current,
    ).toBeNull();
  });
});
