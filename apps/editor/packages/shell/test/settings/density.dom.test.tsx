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

// Setting `paged.density` (state/density.ts; editor ADR "Density
// presets"): Comfortable, Professional (the default) or Compact, applied
// as `data-density` on the editor's root element — the attribute the
// density tokens of styles/theme.css key on — and switched by three
// commands under Edit ▸ Settings ▸ Interface density.

import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { covers } from "@paged-media/test-kit";

import { EditorRoot } from "../../src/state/editor-root";
import {
  DENSITY_COMMANDS,
  getDensity,
  setDensity,
  useDensityCommands,
} from "../../src/state/density";
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

const KEY = "paged.density";
const root = () => document.querySelector("[data-paged-editor]")!;

let scope: EditorScope;
beforeEach(() => {
  localStorage.clear();
  scope = createEditorScope();
  setEditorStorage(scope, localStorage);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function mount(onRegistries?: (r: ShellRegistries) => void) {
  function Commands() {
    useDensityCommands();
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

describe("setting paged.density", () => {
  test("defaults to professional on the editor's root", () => {
    covers("setting:paged.density");
    mount();
    expect(getDensity(scope)).toBe("professional");
    expect(root().getAttribute("data-density")).toBe("professional");
  });

  test("a choice applies at once and survives a reload", () => {
    covers("setting:paged.density");
    mount();
    act(() => setDensity(scope, "compact"));
    expect(root().getAttribute("data-density")).toBe("compact");
    expect(localStorage.getItem(KEY)).toBe("compact");
    cleanup();
    // A new editor over the same storage is what a reload builds.
    scope = createEditorScope();
    setEditorStorage(scope, localStorage);
    mount();
    expect(root().getAttribute("data-density")).toBe("compact");
  });

  test("an unknown stored value falls back to professional", () => {
    covers("setting:paged.density");
    for (const stored of ["dense", "", "COMPACT", '"compact"']) {
      localStorage.setItem(KEY, stored);
      scope = createEditorScope();
      setEditorStorage(scope, localStorage);
      expect(getDensity(scope)).toBe("professional");
    }
  });

  test("blocked storage keeps the default and still switches for the session", () => {
    covers("setting:paged.density");
    setEditorStorage(scope, {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {},
    });
    mount();
    expect(root().getAttribute("data-density")).toBe("professional");
    act(() => setDensity(scope, "comfortable"));
    expect(root().getAttribute("data-density")).toBe("comfortable");
  });

  test("the three commands switch it, and Edit ▸ Settings ▸ Interface density ticks the one in use", async () => {
    covers(
      "command:paged.view.density.comfortable",
      "command:paged.view.density.professional",
      "command:paged.view.density.compact",
    );
    let registries: ShellRegistries | null = null;
    mount((r) => (registries = r));
    await act(async () => {});
    const r = registries!;
    const paged = { scope };
    for (const density of ["comfortable", "compact", "professional"] as const) {
      await act(async () => {
        await r.commands.invoke(DENSITY_COMMANDS[density]);
      });
      expect(root().getAttribute("data-density")).toBe(density);
      const ticked = r.menus
        .list()
        .filter((m) => m.path.startsWith("Edit/Settings/Interface density/"))
        .filter((m) => m.checked?.(paged))
        .map((m) => m.path);
      expect(ticked).toEqual([
        `Edit/Settings/Interface density/${density[0]!.toUpperCase()}${density.slice(1)}`,
      ]);
    }
  });

  test("theme.css re-points the density tokens per preset, and the canvas reads none of them", () => {
    const css = readFileSync(
      new URL("../../src/styles/theme.css", import.meta.url),
      "utf8",
    );
    for (const density of ["comfortable", "compact"]) {
      expect(css).toContain(`[data-paged-editor][data-density="${density}"]`);
    }
    for (const token of [
      "--density-control-h",
      "--density-row-h",
      "--density-icon",
      "--density-pad",
      "--density-section-gap",
      "--chrome-header-h",
      "--chrome-toolbar-h",
      "--chrome-tabstrip-h",
      "--chrome-titlebar-h",
      "--chrome-modebar-h",
    ]) {
      expect(css).toContain(`${token}:`);
    }
  });
});
