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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { useEditorStorage, type StorageAdapter } from "./storage";

// Design system — the editor theme. DARK is the primary surface
// ("long design sessions"); light ships as the toggle for colour /
// proof judgement. Both themes are ONE token set (styles/theme.css
// `:root, [data-paged-editor]` + `.dark`) — switching is just the
// `dark` class on the editor's root element (state/editor-root.tsx,
// plan task E1), never on the host's <html>; the editor's popovers
// portal inside that root, so the tokens cascade into them.

export type EditorTheme = "dark" | "light";

const STORAGE_KEY = "paged.theme";

function loadInitialTheme(storage: StorageAdapter): EditorTheme {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    /* storage unavailable (iframe sandbox) — fall through */
  }
  return "dark";
}

interface ThemeValue {
  theme: EditorTheme;
  setTheme: (t: EditorTheme) => void;
  toggleTheme: () => void;
}

const Context = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  // The editor's settings store (state/storage.ts): the page's
  // localStorage for the app, the host's choice when embedded.
  const storage = useEditorStorage();
  const [theme, setTheme] = useState<EditorTheme>(() =>
    loadInitialTheme(storage),
  );

  // The root element applies it (`EditorRoot`); persist the choice.
  useEffect(() => {
    try {
      storage.setItem(STORAGE_KEY, theme);
    } catch {
      /* persistence is a convenience only */
    }
  }, [storage, theme]);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const toggleTheme = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );
  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const value = useMemo<ThemeValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, toggleTheme],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error("useTheme called outside ThemeProvider");
  }
  return ctx;
}

export function useOptionalTheme(): ThemeValue | null {
  return useContext(Context);
}
