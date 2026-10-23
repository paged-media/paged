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

// Setting `paged.theme` (theme-context.tsx): the editor theme, dark by
// default, persisted under `localStorage["paged.theme"]`, applied as the
// `dark` class on the editor's root element, where its portals render.

import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { EditorRoot } from "../../src/state/editor-root";
import { ThemeProvider, useTheme } from "../../src/state/theme-context";

const KEY = "paged.theme";
// The theme is the editor's: the class sits on its root element, and the
// page's <html> never carries it (plan task E1).
const html = () => document.documentElement;
const root = () => document.querySelector("[data-paged-editor]")!;
const isDark = () => {
  expect(html().classList.contains("dark")).toBe(false);
  return root().classList.contains("dark");
};
const mount = () =>
  renderHook(() => useTheme(), {
    wrapper: ({ children }: PropsWithChildren) => (
      <ThemeProvider>
        <EditorRoot>{children}</EditorRoot>
      </ThemeProvider>
    ),
  });

beforeEach(() => {
  localStorage.clear();
  html().classList.remove("dark");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("setting paged.theme", () => {
  test("defaults to dark, applies it, and persists the default", () => {
    covers("setting:paged.theme");
    const { result } = mount();
    expect(result.current.theme).toBe("dark");
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("dark");
  });

  test("a stored choice survives a reload", () => {
    covers("setting:paged.theme");
    const first = mount();
    act(() => first.result.current.setTheme("light"));
    expect(localStorage.getItem(KEY)).toBe("light");
    first.unmount();
    // A new provider is what a reload builds.
    const second = mount();
    expect(second.result.current.theme).toBe("light");
    expect(isDark()).toBe(false);
  });

  test("changing it flips the editor root's class both ways", () => {
    covers("setting:paged.theme");
    const { result } = mount();
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(isDark()).toBe(false);
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("dark");
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("dark");
  });

  test("an unknown stored value falls back to dark and is overwritten", () => {
    covers("setting:paged.theme");
    for (const stored of ["blue", "", "LIGHT", '"light"', "null"]) {
      localStorage.setItem(KEY, stored);
      const { result, unmount } = mount();
      expect({ stored, theme: result.current.theme }).toEqual({
        stored,
        theme: "dark",
      });
      expect(localStorage.getItem(KEY)).toBe("dark");
      unmount();
    }
  });

  test("blocked storage degrades to the default without throwing", () => {
    covers("setting:paged.theme");
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const getItem = proto.getItem;
    const setItem = proto.setItem;
    proto.getItem = () => {
      throw new Error("SecurityError");
    };
    proto.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      const { result } = mount();
      expect(result.current.theme).toBe("dark");
      act(() => result.current.setTheme("light"));
      // The choice still applies for the session.
      expect(isDark()).toBe(false);
    } finally {
      proto.getItem = getItem;
      proto.setItem = setItem;
    }
  });

  test("useTheme outside its provider says so", () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useTheme())).toThrow(
        /useTheme called outside ThemeProvider/,
      );
    } finally {
      console.error = original;
    }
  });
});
