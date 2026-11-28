// The one frame of the image panel's dialogs. Each dialog used to open a bare
// `role="dialog"` element: focus stayed on the control that opened it, Tab
// walked out into the panel behind it, Escape did nothing, and closing left
// focus on <body>. The frame gives every one of them the modal dialog
// pattern (WAI-ARIA):
//
//   - on open, focus moves to the dialog's first control (unless a child
//     took it);
//   - Tab from the last control wraps to the first, Shift+Tab from the first
//     to the last;
//   - Escape cancels, through the dialog's own cancel handler;
//   - on close, focus returns to the control that opened the dialog, when it
//     would otherwise fall to <body>.
//
// The editor's own dialogs get the same behaviour from its shell, which a
// module does not import (docs/adr/PM-0002).

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const NO_SCROLL: FocusOptions = { preventScroll: true };

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export interface DialogFrameProps {
  /** The dialog's accessible name. */
  label: string;
  /** Escape, and the dialog's Cancel button, end here. */
  onCancel: () => void;
  /** The element: the dialogs were sections and divs, and stay so. */
  as?: "section" | "div";
  style?: CSSProperties;
  children?: ReactNode;
  /** The `data-*` hooks the dialog is found by. */
  [data: `data-${string}`]: string | boolean | undefined;
}

export function DialogFrame({
  label,
  onCancel,
  as: Element = "section",
  style,
  children,
  ...data
}: DialogFrameProps) {
  const root = useRef<HTMLElement | null>(null);
  // The opener: whatever held focus when the dialog first rendered.
  const [opener] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );

  useEffect(() => {
    const el = root.current;
    // A child that focused itself on mount already did the job.
    if (el && !el.contains(document.activeElement)) {
      (focusables(el)[0] ?? el).focus(NO_SCROLL);
    }
    return () => {
      if (!(opener instanceof HTMLElement) || !opener.isConnected) return;
      // Only when focus went down with the dialog; a click elsewhere that
      // moved focus on purpose keeps it there.
      const active = document.activeElement;
      if (
        active === null ||
        active === document.body ||
        !active.isConnected ||
        el?.contains(active)
      ) {
        opener.focus(NO_SCROLL);
      }
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      // The innermost dialog takes it; nothing behind it also cancels.
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !root.current) return;
    const items = focusables(root.current);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && items.includes(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus(NO_SCROLL);
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus(NO_SCROLL);
    }
  };

  return (
    <Element
      {...data}
      ref={(el: HTMLElement | null) => {
        root.current = el;
      }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={style}
      onKeyDown={onKeyDown}
    >
      {children}
    </Element>
  );
}
