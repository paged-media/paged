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

// High contrast (editor ADR "High contrast and AA"; UXI-A11Y-012, T74): a
// `data-contrast="more"` attribute on the editor's root element re-points
// the theme's tokens (styles/theme.css) to a high-contrast variant of the
// theme in use, dark or light — stronger text, borders and focus ring,
// darker or lifted status colours, and the canvas overlays (selection,
// handles, guides, snap lines) drawn with a two-tone halo so they hold
// against any page. The preference is System (the operating system's
// `prefers-contrast: more`), Standard or High, remembered under
// `paged.contrast` in the editor's storage (state/storage.ts), per editor;
// never an undo step, never the document.

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

export type ContrastPreference = "system" | "standard" | "more";
export type Contrast = "standard" | "more";

export const CONTRAST_PREFERENCES: readonly ContrastPreference[] = [
  "system",
  "standard",
  "more",
];

export const DEFAULT_CONTRAST: ContrastPreference = "system";

const STORAGE_KEY = "paged.contrast";
const QUERY = "(prefers-contrast: more)";

function isPreference(value: unknown): value is ContrastPreference {
  return CONTRAST_PREFERENCES.includes(value as ContrastPreference);
}

/** The stored preference, or the default for a missing or unknown one. */
function loadPreference(scope: EditorScope): ContrastPreference {
  try {
    const raw = editorStorage(scope).getItem(STORAGE_KEY);
    if (isPreference(raw)) return raw;
  } catch {
    /* storage unavailable — the default */
  }
  return DEFAULT_CONTRAST;
}

const CONTRAST = scoped("contrast", (scope): ValueStore<ContrastPreference> =>
  createValueStore(loadPreference(scope)),
);

export function getContrastPreference(scope: EditorScope): ContrastPreference {
  return scope.get(CONTRAST).get();
}

/** Switch the preference and remember it. */
export function setContrastPreference(
  scope: EditorScope,
  preference: ContrastPreference,
): void {
  if (!isPreference(preference)) return;
  scope.get(CONTRAST).set(preference);
  try {
    editorStorage(scope).setItem(STORAGE_KEY, preference);
  } catch {
    /* persistence is a convenience only */
  }
}

/** The contrast a preference means under the system's setting. */
export function effectiveContrast(
  preference: ContrastPreference,
  systemMore: boolean,
): Contrast {
  if (preference === "system") return systemMore ? "more" : "standard";
  return preference;
}

const mediaQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;

function subscribeSystem(onChange: () => void): () => void {
  const mq = mediaQuery();
  if (!mq) return () => {};
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
}

const systemMore = (): boolean => mediaQuery()?.matches === true;

/** This component's editor's contrast preference. */
export function useContrastPreference(): ContrastPreference {
  const store = useScoped(CONTRAST);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** This component's editor's contrast now: the preference, with System
 *  following `prefers-contrast` as it changes. */
export function useContrast(): Contrast {
  const preference = useContrastPreference();
  const more = useSyncExternalStore(subscribeSystem, systemMore, () => false);
  return effectiveContrast(preference, more);
}

const M = defineMessages("shell.contrast", {
  system: "Contrast: as the system",
  standard: "Contrast: standard",
  more: "Contrast: high",
});

defineMessages("menu", {
  Contrast: "Contrast",
  "As the system": "As the system",
  Standard: "Standard",
  High: "High",
});

/** The commands that set the preference. */
export const CONTRAST_COMMANDS: Readonly<Record<ContrastPreference, string>> = {
  system: "paged.view.contrast.system",
  standard: "paged.view.contrast.standard",
  more: "paged.view.contrast.high",
};

const to = (preference: ContrastPreference) => (paged: unknown) =>
  setContrastPreference(scopeOf(paged), preference);
const is = (preference: ContrastPreference) => (paged: unknown) =>
  getContrastPreference(scopeOf(paged)) === preference;

/** Register the three commands and Edit ▸ Settings ▸ Contrast for the
 *  lifetime of the calling component (the shell). */
export function useContrastCommands(): void {
  const registries = useRegistries();
  useEffect(() => {
    const rows: Array<[ContrastPreference, string, string, number]> = [
      ["system", M.system, "As the system", 85],
      ["standard", M.standard, "Standard", 86],
      ["more", M.more, "High", 87],
    ];
    const disposables = rows.flatMap(([preference, title, label, order]) => [
      registries.commands.register({
        id: CONTRAST_COMMANDS[preference],
        title: t(title),
        category: "View",
        handler: to(preference),
      }),
      registries.menus.register({
        path: `Edit/Settings/Contrast/${label}`,
        command: CONTRAST_COMMANDS[preference],
        checked: is(preference),
        order,
        group: "settings",
      }),
    ]);
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [registries]);
}
