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

// The editor's root element (plan task E1): the one element of the page an
// editor owns. Everything the editor puts on the page goes inside it — its
// chrome, its theme and tokens (step 5), its popovers and dialogs (through
// the portal container below) — and its keyboard is the keys typed inside
// it, so a host's own shortcuts and inputs around the editor stay the
// host's, and two editors on a page each answer only their own keys.
// Nothing of the editor's is written on the page's <html> or <body>.
//
// KEYS. The editor's keyboard listeners stay on `window`, where they always
// were (their order against each other and against the widgets' own
// handlers is what the shortcut rules are written against), but each one
// is filtered (`listenForEditorKeys`): it hears an event whose target is
// inside the root, never one inside another editor's root, and, for a
// target outside every editor: an editor that owns the page (the app
// entry's, `ownsPage`) hears it, as it always did; an embedded editor hears
// it only with nothing focused (the target the page's `<body>`) and only
// when it is the page's ACTIVE editor, the one last pointed at or focused.
// So a host's own inputs and shortcuts stay the host's. The root takes
// focus (`tabIndex=-1`), so a host can hand the keyboard to it with
// `root.focus()`.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export { queryEditor } from "./editor-dom";

import {
  scoped,
  useEditorScope,
  useScoped,
  type EditorScope,
} from "./editor-scope";
import { useOptionalTheme } from "./theme-context";

const ROOT = scoped("editorRoot", () => ({
  element: null as HTMLElement | null,
}));

/** `scope`'s root element; null before it mounts (and for a shell rendered
 *  without one: a standalone panel, a unit test). */
export function editorRootOf(scope: EditorScope): HTMLElement | null {
  return scope.get(ROOT).element;
}

// The page's keyboard: the editors' roots on it (and whether each owns the
// page), and which one gets the keys typed with nothing focused. One per
// page, by nature (instance-guard-allow.json).
const roots = new Map<HTMLElement, { ownsPage: boolean }>();
let active: HTMLElement | null = null;

/** Whether `event` is for the editor whose root is `root`. Null root: the
 *  editor has no root (a test, a standalone shell), so it is the page's. */
export function ownsEvent(root: HTMLElement | null, event: Event): boolean {
  if (!root) return true;
  const target = event.target;
  const doc = root.ownerDocument;
  const node =
    target && typeof (target as Node).nodeType === "number"
      ? (target as Node)
      : null;
  if (node && root.contains(node)) return true;
  for (const other of roots.keys()) {
    if (other !== root && node && other.contains(node)) return false;
  }
  if (roots.get(root)?.ownsPage) return true;
  const nothingFocused =
    !node || node === doc.body || node === doc.documentElement || node === doc;
  return nothingFocused && active === root;
}

/** Listen on the window for `type` events meant for `scope`'s editor;
 *  returns the unlisten. */
export function listenForEditorKeys<K extends keyof WindowEventMap>(
  scope: EditorScope,
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
  /** Where the listener sits: the window (default) or the document, as the
   *  listener always did, so its order against the others is kept. */
  on: Window | Document = window,
): () => void {
  const filtered = (event: Event) => {
    if (ownsEvent(editorRootOf(scope), event))
      listener(event as WindowEventMap[K]);
  };
  on.addEventListener(type, filtered, options);
  return () => on.removeEventListener(type, filtered, options);
}

/** The listener door of one editor (stable for its lifetime). */
export interface EditorKeys {
  listen<K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
    on?: Window | Document,
  ): () => void;
}

const KEYS = scoped("editorKeys", (scope): EditorKeys => ({
  listen: (type, listener, options, on) =>
    listenForEditorKeys(scope, type, listener, options, on),
}));

/** `listenForEditorKeys` for this component's editor. */
export function useEditorKeys(): EditorKeys {
  return useScoped(KEYS);
}

/** Make `element` `scope`'s root: it takes the page's keys when pointed at
 *  or focused (and from the start when the editor owns the page). Returns
 *  the release. */
function attachRoot(
  scope: EditorScope,
  element: HTMLElement,
  ownsPage: boolean,
): () => void {
  const store = scope.get(ROOT);
  store.element = element;
  roots.set(element, { ownsPage });
  const claim = () => {
    active = element;
  };
  if (ownsPage) claim();
  element.addEventListener("pointerdown", claim, true);
  element.addEventListener("focusin", claim);
  return () => {
    element.removeEventListener("pointerdown", claim, true);
    element.removeEventListener("focusin", claim);
    if (active === element) active = null;
    roots.delete(element);
    if (store.element === element) store.element = null;
  };
}

const RootContext = createContext<HTMLElement | null>(null);
const PortalContext = createContext<HTMLElement | null>(null);

/** The editor's root element (null outside one). */
export function useEditorRoot(): HTMLElement | null {
  return useContext(RootContext);
}

/** Where the editor's popovers, menus, dialogs and tooltips portal to: a
 *  container inside its root, so they carry its theme and tokens and stay
 *  the editor's. Undefined outside an editor (the page's body, Radix's
 *  default). */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContext) ?? undefined;
}

const rootStyle: CSSProperties = {
  height: "100%",
  width: "100%",
  // Focus is taken (tabIndex) but never drawn: the editor shows where its
  // keys go through its own controls.
  outline: "none",
};

/**
 * The editor's root element. Renders its children once the root and its
 * portal container exist, so every effect below sees them.
 */
export function EditorRoot({
  ownsPage = false,
  children,
}: {
  /** The editor is the page (the app entry): keys typed with nothing
   *  focused are its from the start. */
  ownsPage?: boolean;
  children: ReactNode;
}) {
  const scope = useEditorScope();
  // The theme is the editor's: the `.dark` class on its root, not the
  // page's <html> (styles/theme.css).
  const dark = useOptionalTheme()?.theme === "dark";
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [portals, setPortals] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!root) return;
    return attachRoot(scope, root, ownsPage);
  }, [root, scope, ownsPage]);
  return (
    <div
      ref={setRoot}
      data-paged-editor=""
      className={dark ? "dark" : undefined}
      tabIndex={-1}
      style={rootStyle}
    >
      {root && portals && (
        <RootContext.Provider value={root}>
          <PortalContext.Provider value={portals}>
            {children}
          </PortalContext.Provider>
        </RootContext.Provider>
      )}
      <div ref={setPortals} data-paged-portals="" />
    </div>
  );
}
