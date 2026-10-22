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

// Who owns a key press: the focused control, or the canvas (ADR 234).
//
// The editor listens for keys on `window` in several places — the
// keybinding registry, the text editor, path editing, the gesture spine,
// the spring-loaded tools, the edit-context controller. Each used to ask
// one question of the event's target ("is it an INPUT, a TEXTAREA or
// contentEditable?"), never "is focus in a dialog or an open menu?". So
// Tab inside the Export PDF dialog toggled the chrome, an open menu's
// arrows moved the text caret behind it, and Enter that chose a menu
// item also put the selected frame into path editing.
//
// This module is the one answer. The canvas has two keyboard SURFACES,
// marked `data-canvas-surface`: the viewport (focusable, so Tab can reach
// the document) and the text editor's input (where IME and dead-key text
// arrives). A key that targets a surface, or nothing (`<body>`), is the
// canvas's. A key that targets anything else belongs to that control
// first, by the rules below.

/** The attribute that marks a canvas keyboard surface. Its value names
 *  the surface: `viewport` or `text`. */
export const CANVAS_SURFACE_ATTR = "data-canvas-surface";

/** The keys a focused WIDGET consumes itself, whatever modifiers ride
 *  along (see `targetOwnsKey` in registries/keybinding.ts for the
 *  history of this set). */
export const WIDGET_KEYS: ReadonlySet<string> = new Set([
  "backspace",
  "delete",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "home",
  "end",
]);

/** The keys that open the focused thing's menu: Shift+F10 and the
 *  context-menu key. A control with a menu of its own (a rail tool's
 *  flyout) claims them by preventing the default, and the canvas context
 *  menu bound to the same keys must then stay shut. */
export const MENU_KEYS: ReadonlySet<string> = new Set(["f10", "contextmenu"]);

/** Containers that own EVERY key pressed inside them except a Cmd/Ctrl
 *  chord: a dialog (modal or not, the rest of the editor is not where
 *  the user is) and an open menu (its arrows, Home/End, typeahead,
 *  Enter, Space and Escape are the menu's). */
export const KEY_OWNING_CONTAINERS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
].join(",");

/** ARIA composites that own the widget keys (arrows, Home/End,
 *  Backspace/Delete) while focus is inside them, and Enter/Space on
 *  their items. */
export const WIDGET_KEY_OWNERS = [
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="tablist"]',
  '[role="toolbar"]',
  '[role="radiogroup"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
].join(",");

/** What a key handler reads of a key event. Every field but `key` is
 *  optional so a plain object works in a test. */
export interface KeyOwnershipEvent {
  key: string;
  target?: EventTarget | null;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

function asElement(target: EventTarget | null | undefined): Element | null {
  const el = target as Element | null | undefined;
  return el && typeof el.tagName === "string" ? el : null;
}

/** A keydown that belongs to an input method composition: `isComposing`,
 *  the IME's `Process` key (Windows), or keyCode 229, which Chrome and
 *  Safari report for the key that STARTS a composition (before
 *  `isComposing` turns true). Such a key is the input method's. */
export function isComposingKey(event: KeyOwnershipEvent): boolean {
  return (
    event.isComposing === true ||
    event.keyCode === 229 ||
    event.key === "Process"
  );
}

/** The canvas surface `target` is, if any (`viewport` or `text`). */
export function canvasSurfaceOf(
  target: EventTarget | null | undefined,
): string | null {
  const el = asElement(target);
  return el?.getAttribute?.(CANVAS_SURFACE_ATTR) ?? null;
}

/** Is `target` one of the canvas's keyboard surfaces? */
export function isCanvasSurface(
  target: EventTarget | null | undefined,
): boolean {
  return canvasSurfaceOf(target) !== null;
}

/** A form field that takes typed text: an INPUT, TEXTAREA, SELECT or
 *  contentEditable element — but never the canvas text editor's own
 *  input, which is the canvas. */
export function isFormField(target: EventTarget | null | undefined): boolean {
  const el = asElement(target);
  if (!el || isCanvasSurface(el)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
}

const ACTIVATABLE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "switch",
  "radio",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
]);

/** A control that Enter or Space activates: a button, a link, a
 *  checkbox, an element with one of those roles. */
export function isActivatable(target: EventTarget | null | undefined): boolean {
  const el = asElement(target);
  if (!el || isCanvasSurface(el)) return false;
  const tag = el.tagName;
  if (tag === "BUTTON" || tag === "SUMMARY") return true;
  if (tag === "A" && el.hasAttribute?.("href")) return true;
  const role = el.getAttribute?.("role");
  return role !== null && role !== undefined && ACTIVATABLE_ROLES.has(role);
}

/** The attribute the canvas puts on a mounted frame surface's root. */
export const FRAME_SURFACE_ATTR = "data-paged-frame-surface";
const FRAME_SURFACE_SELECTOR = `[${FRAME_SURFACE_ATTR}]`;

/** Is `target` inside a mounted frame surface (extensions ADR 334)? */
export function insideFrameSurface(
  target: EventTarget | null | undefined,
): boolean {
  const el = asElement(target);
  return el !== null && closest(el, FRAME_SURFACE_SELECTOR);
}

function closest(el: Element, selector: string): boolean {
  return typeof el.closest === "function" && el.closest(selector) !== null;
}

/** Is the focused element (the event's target) inside a dialog or an
 *  open menu, which own every key but a Cmd/Ctrl chord? */
export function insideKeyOwningContainer(
  target: EventTarget | null | undefined,
): boolean {
  const el = asElement(target);
  return el !== null && closest(el, KEY_OWNING_CONTAINERS);
}

/**
 * Must a CANVAS key handler (text editing, path editing, the gesture
 * spine, the spring-loaded tools, an edit context's content keys, the
 * page-navigation keys) leave this key alone? True when:
 *
 *  - an input method is composing (the key is the IME's);
 *  - something upstream already took it (`defaultPrevented`) — a bubble
 *    listener runs after React's handlers, so a menu item that chose
 *    itself on Enter has said so by now;
 *  - focus is in a form field (not the canvas's own text input);
 *  - focus is inside a dialog or an open menu (every key);
 *  - focus is inside a plugin's frame surface (extensions ADR 334): the
 *    surface handles its own keys, as a dialog does;
 *  - focus is inside a composite widget (a menubar, toolbar, tablist,
 *    listbox, tree…) and the key is one it moves with or activates by;
 *  - Enter or Space on a focused button, link or checkbox (the control
 *    activates);
 *  - Tab on any focused control: focus moves.
 *
 * A key on a canvas surface or on `<body>` (nothing focused) is the
 * canvas's.
 */
export function canvasKeyYields(event: KeyOwnershipEvent): boolean {
  if (isComposingKey(event)) return true;
  if (event.defaultPrevented) return true;
  const el = asElement(event.target);
  if (!el || isCanvasSurface(el)) return false;
  if (el.tagName === "BODY" || el.tagName === "HTML") return false;
  if (isFormField(el)) return true;
  if (closest(el, KEY_OWNING_CONTAINERS)) return true;
  if (closest(el, FRAME_SURFACE_SELECTOR)) return true;
  const key = event.key.toLowerCase();
  const activates = key === "enter" || key === " ";
  if ((WIDGET_KEYS.has(key) || activates) && closest(el, WIDGET_KEY_OWNERS)) {
    return true;
  }
  if (activates && isActivatable(el)) return true;
  if (key === "tab") return true;
  return false;
}
