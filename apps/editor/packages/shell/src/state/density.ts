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

// Interface density (editor ADR "Density presets"; strategy §2.5): three
// presets of the chrome's sizing — Comfortable, Professional (the default)
// and Compact. A preset is a `data-density` attribute on the editor's root
// element that re-points the density tokens of styles/theme.css: control
// and row heights, icon size, panel padding, section spacing and the
// chrome bars' heights. It is the interface's size only: the canvas's zoom,
// the document's geometry and the overlays drawn over it never read these
// tokens. An editor preference, remembered under `paged.density` (in the
// editor's storage, state/storage.ts); never an undo step.

import { useEffect, useSyncExternalStore } from "react";
import { defineMessages, t } from "@paged-media/strings";

import {
  createValueStore,
  scopeOf,
  scoped,
  useScoped,
  type EditorScope,
  type ValueStore,
} from "./editor-scope";
import { editorStorage } from "./storage";
import { useRegistries } from "./registries-context";

export type Density = "comfortable" | "professional" | "compact";

export const DENSITIES: readonly Density[] = [
  "comfortable",
  "professional",
  "compact",
];

export const DEFAULT_DENSITY: Density = "professional";

const STORAGE_KEY = "paged.density";

function isDensity(value: unknown): value is Density {
  return DENSITIES.includes(value as Density);
}

/** The stored preset, or the default for a missing or unknown one. */
function loadDensity(scope: EditorScope): Density {
  try {
    const raw = editorStorage(scope).getItem(STORAGE_KEY);
    if (isDensity(raw)) return raw;
  } catch {
    /* storage unavailable — the default */
  }
  return DEFAULT_DENSITY;
}

/** The editor's density, per editor; read from its storage on first use. */
const DENSITY = scoped("density", (scope): ValueStore<Density> =>
  createValueStore(loadDensity(scope)),
);

export function getDensity(scope: EditorScope): Density {
  return scope.get(DENSITY).get();
}

/** Switch the preset and remember it. */
export function setDensity(scope: EditorScope, density: Density): void {
  if (!isDensity(density)) return;
  scope.get(DENSITY).set(density);
  try {
    editorStorage(scope).setItem(STORAGE_KEY, density);
  } catch {
    /* persistence is a convenience only */
  }
}

/** This component's editor's density now. */
export function useDensity(): Density {
  const store = useScoped(DENSITY);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

const M = defineMessages("shell.density", {
  comfortable: "Density: comfortable",
  professional: "Density: professional",
  compact: "Density: compact",
});

defineMessages("menu", {
  "Interface density": "Interface density",
  Comfortable: "Comfortable",
  Professional: "Professional",
  Compact: "Compact",
});

/** The commands that switch the preset, one per density. */
export const DENSITY_COMMANDS: Readonly<Record<Density, string>> = {
  comfortable: "paged.view.density.comfortable",
  professional: "paged.view.density.professional",
  compact: "paged.view.density.compact",
};

const to = (density: Density) => (paged: unknown) =>
  setDensity(scopeOf(paged), density);
const is = (density: Density) => (paged: unknown) =>
  getDensity(scopeOf(paged)) === density;

/** Register the three commands and Edit ▸ Settings ▸ Interface density for
 *  the lifetime of the calling component (the shell). */
export function useDensityCommands(): void {
  const registries = useRegistries();
  useEffect(() => {
    const commands = [
      {
        id: DENSITY_COMMANDS.comfortable,
        title: t(M.comfortable),
        category: "View",
        handler: to("comfortable"),
      },
      {
        id: DENSITY_COMMANDS.professional,
        title: t(M.professional),
        category: "View",
        handler: to("professional"),
      },
      {
        id: DENSITY_COMMANDS.compact,
        title: t(M.compact),
        category: "View",
        handler: to("compact"),
      },
    ];
    const menus = [
      {
        path: "Edit/Settings/Interface density/Comfortable",
        command: DENSITY_COMMANDS.comfortable,
        checked: is("comfortable"),
        order: 80,
        group: "settings",
      },
      {
        path: "Edit/Settings/Interface density/Professional",
        command: DENSITY_COMMANDS.professional,
        checked: is("professional"),
        order: 81,
        group: "settings",
      },
      {
        path: "Edit/Settings/Interface density/Compact",
        command: DENSITY_COMMANDS.compact,
        checked: is("compact"),
        order: 82,
        group: "settings",
      },
    ];
    const disposables = [
      ...commands.map((c) => registries.commands.register(c)),
      ...menus.map((m) => registries.menus.register(m)),
    ];
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [registries]);
}
