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

// A focus scope over its children, built on a React 19.3 Fragment ref
// (`focus()` / `focusLast()` find the first / last focusable element the
// fragment renders, however deep). No wrapper element, so it drops into
// any dialog markup without changing its layout (ADR 234).
//
//   autoFocus    — on mount, focus the first focusable child, unless a
//                  child already took focus (an input's own `autoFocus`).
//   restoreFocus — on unmount, give focus back to the element that had it
//                  when the scope mounted (the opener), if focus would
//                  otherwise fall to <body>.
//   trap         — Tab from the last child wraps to the first and
//                  Shift+Tab from the first to the last, through two
//                  focus guards around the children (the WAI-ARIA modal
//                  dialog pattern). Focus never leaves by keyboard.

import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FragmentInstance,
  type ReactNode,
} from "react";

export interface FocusScopeProps {
  children?: ReactNode;
  autoFocus?: boolean;
  restoreFocus?: boolean;
  trap?: boolean;
}

/** Move focus into the nearest enclosing scope, from inside it. */
export interface FocusScopeHandle {
  focusFirst(): void;
  focusLast(): void;
}

const ScopeContext = createContext<FocusScopeHandle | null>(null);

/** The nearest enclosing `FocusScope`'s first / last focus moves; inert
 *  outside any scope. */
export function useFocusScope(): FocusScopeHandle {
  return useContext(ScopeContext) ?? NO_SCOPE;
}

const NO_SCOPE: FocusScopeHandle = {
  focusFirst: () => {},
  focusLast: () => {},
};

const FOCUS_OPTIONS: FocusOptions = { preventScroll: true };

export function FocusScope({
  children,
  autoFocus = false,
  restoreFocus = false,
  trap = false,
}: FocusScopeProps) {
  const fragment = useRef<FragmentInstance | null>(null);
  // The opener: whatever held focus when the scope first rendered, before
  // any child (or this scope) moved it.
  const [opener] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );
  const [handle] = useState<FocusScopeHandle>(() => ({
    focusFirst: () => fragment.current?.focus(FOCUS_OPTIONS),
    focusLast: () => fragment.current?.focusLast(FOCUS_OPTIONS),
  }));

  useEffect(() => {
    if (autoFocus) {
      const active = document.activeElement;
      // A child that focused itself on mount already did the job.
      if (active === opener || active === null || active === document.body) {
        fragment.current?.focus(FOCUS_OPTIONS);
      }
    }
    return () => {
      if (!restoreFocus || !(opener instanceof HTMLElement)) return;
      if (!opener.isConnected) return;
      // Only when focus went down with the scope; a click elsewhere that
      // moved focus on purpose keeps it there.
      const active = document.activeElement;
      if (active === null || active === document.body) {
        opener.focus(FOCUS_OPTIONS);
      }
    };
    // The props describe the scope's whole lifetime; a dialog never flips
    // them while it is open.
  }, [autoFocus, restoreFocus, opener]);

  return (
    <ScopeContext value={handle}>
      {trap && (
        <span
          tabIndex={0}
          data-focus-guard="start"
          aria-hidden
          style={guardStyle}
          onFocus={handle.focusLast}
        />
      )}
      <Fragment ref={fragment}>{children}</Fragment>
      {trap && (
        <span
          tabIndex={0}
          data-focus-guard="end"
          aria-hidden
          style={guardStyle}
          onFocus={handle.focusFirst}
        />
      )}
    </ScopeContext>
  );
}

/** Focusable but invisible and out of layout. */
const guardStyle: CSSProperties = {
  position: "fixed",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
  outline: "none",
  opacity: 0,
  pointerEvents: "none",
};
