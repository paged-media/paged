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

// Setting `paged.contrast` (state/contrast.ts; editor ADR "High contrast
// and AA"): As the system (the default, `prefers-contrast: more`),
// Standard or High, applied as `data-contrast` on the editor's root
// element — the attribute theme.css's high-contrast blocks key on — and
// switched by three commands under Edit ▸ Settings ▸ Contrast.

import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { EditorRoot } from "../../src/state/editor-root";
import {
  CONTRAST_COMMANDS,
  effectiveContrast,
  getContrastPreference,
  setContrastPreference,
  useContrastCommands,
} from "../../src/state/contrast";
import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";
import { setEditorStorage } from "../../src/state/storage";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";
import type { ShellRegistries } from "../../src/state/registries-context";

const KEY = "paged.contrast";
const root = () => document.querySelector("[data-paged-editor]")!;

/** `prefers-contrast: more` as the test sets it, with its listeners. */
let systemMore = false;
const listeners = new Set<() => void>();
const realMatchMedia = window.matchMedia;

let scope: EditorScope;
beforeEach(() => {
  localStorage.clear();
  systemMore = false;
  listeners.clear();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === "(prefers-contrast: more)" ? systemMore : false;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  })) as never;
  scope = createEditorScope();
  setEditorStorage(scope, localStorage);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.matchMedia = realMatchMedia;
});

function mount(onRegistries?: (r: ShellRegistries) => void) {
  function Commands() {
    useContrastCommands();
    const registries = useRegistries();
    useEffect(() => {
      onRegistries?.(registries);
    }, [registries]);
    return null;
  }
  return render(
    <EditorScopeProvider scope={scope}>
      <RegistriesProvider getEditor={() => ({ scope })}>
        <EditorRoot>
          <Commands />
        </EditorRoot>
      </RegistriesProvider>
    </EditorScopeProvider>,
  );
}

describe("setting paged.contrast", () => {
  test("defaults to the system's: standard, and high while the system asks for more", () => {
    covers("setting:paged.contrast");
    mount();
    expect(getContrastPreference(scope)).toBe("system");
    expect(root().getAttribute("data-contrast")).toBe("standard");
    act(() => {
      systemMore = true;
      for (const fn of listeners) fn();
    });
    expect(root().getAttribute("data-contrast")).toBe("more");
  });

  test("High and Standard override the system, apply at once and survive a reload", () => {
    covers("setting:paged.contrast");
    systemMore = true;
    mount();
    act(() => setContrastPreference(scope, "standard"));
    expect(root().getAttribute("data-contrast")).toBe("standard");
    act(() => setContrastPreference(scope, "more"));
    expect(root().getAttribute("data-contrast")).toBe("more");
    expect(localStorage.getItem(KEY)).toBe("more");
    cleanup();
    systemMore = false;
    scope = createEditorScope();
    setEditorStorage(scope, localStorage);
    mount();
    expect(root().getAttribute("data-contrast")).toBe("more");
  });

  test("an unknown stored value is the default", () => {
    covers("setting:paged.contrast");
    for (const stored of ["high", "", "MORE", '"more"']) {
      localStorage.setItem(KEY, stored);
      scope = createEditorScope();
      setEditorStorage(scope, localStorage);
      expect(getContrastPreference(scope)).toBe("system");
    }
    expect(effectiveContrast("system", false)).toBe("standard");
    expect(effectiveContrast("system", true)).toBe("more");
    expect(effectiveContrast("standard", true)).toBe("standard");
  });

  test("the three commands switch it, and Edit ▸ Settings ▸ Contrast ticks the one in use", async () => {
    covers(
      "command:paged.view.contrast.system",
      "command:paged.view.contrast.standard",
      "command:paged.view.contrast.high",
    );
    let registries: ShellRegistries | null = null;
    mount((r) => (registries = r));
    await act(async () => {});
    const r = registries!;
    const paged = { scope };
    const labels = {
      system: "As the system",
      standard: "Standard",
      more: "High",
    };
    for (const p of ["more", "standard", "system"] as const) {
      await act(async () => {
        await r.commands.invoke(CONTRAST_COMMANDS[p]);
      });
      expect(getContrastPreference(scope)).toBe(p);
      const ticked = r.menus
        .list()
        .filter((m) => m.path.startsWith("Edit/Settings/Contrast/"))
        .filter((m) => m.checked?.(paged))
        .map((m) => m.path);
      expect(ticked).toEqual([`Edit/Settings/Contrast/${labels[p]}`]);
    }
  });

  test("two editors keep their own contrast", () => {
    covers("setting:paged.contrast");
    const other = createEditorScope();
    setEditorStorage(other, {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    });
    setContrastPreference(scope, "more");
    expect(getContrastPreference(other)).toBe("system");
  });
});
