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

import { t } from "@paged-media/strings";
import { SCREEN_MODE } from "./messages";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

// Concept 1 (T7) — the screen-mode selector. Pure VIEW state on the
// overlay layer; it writes NOTHING to the document (`writes: []`). The
// overlay renderer (Phase 5 work) reads `screenMode` to hide
// non-printing items, mask the pasteboard, reveal bleed/slug, etc.
// `W` toggles Normal ⇄ Preview (text-suppressed like tool shortcuts).

export type ScreenMode =
  "normal" | "preview" | "bleed" | "slug" | "presentation";

export const SCREEN_MODES: ReadonlyArray<{ mode: ScreenMode; label: string }> =
  [
    // The label is read where it shows, so it follows the editor's locale.
    {
      mode: "normal",
      get label() {
        return t(SCREEN_MODE.normal);
      },
    },
    {
      mode: "preview",
      get label() {
        return t(SCREEN_MODE.preview);
      },
    },
    {
      mode: "bleed",
      get label() {
        return t(SCREEN_MODE.bleed);
      },
    },
    {
      mode: "slug",
      get label() {
        return t(SCREEN_MODE.slug);
      },
    },
    {
      mode: "presentation",
      get label() {
        return t(SCREEN_MODE.presentation);
      },
    },
  ];

interface ScreenModeValue {
  screenMode: ScreenMode;
  setScreenMode: (m: ScreenMode) => void;
  /** Toggle Normal ⇄ Preview (the `W` shortcut). */
  togglePreview: () => void;
}

const Context = createContext<ScreenModeValue | null>(null);

export function ScreenModeProvider({ children }: PropsWithChildren) {
  const [screenMode, setScreenMode] = useState<ScreenMode>("normal");
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const togglePreview = useCallback(
    () => setScreenMode((m) => (m === "preview" ? "normal" : "preview")),
    [],
  );
  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const value = useMemo<ScreenModeValue>(
    () => ({ screenMode, setScreenMode, togglePreview }),
    [screenMode, togglePreview],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useScreenMode(): ScreenModeValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error("useScreenMode called outside ScreenModeProvider");
  }
  return ctx;
}

export function useOptionalScreenMode(): ScreenModeValue | null {
  return useContext(Context);
}
