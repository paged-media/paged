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

// Presentations (extensions ADR 345, editor ADRs 304 and 305): the
// registry of the bundles' presentations and the host's presenter.
//
// The presenter is plain DOM, not React, because a surface can live in a
// window the editor's React root does not reach. For each surface it
// makes a root element (fixed over the whole window, black, a key-owning
// dialog), hands it to the contribution's `render`, and on exit calls the
// cleanup, removes the root, leaves the browser's full screen and closes
// any window it opened. The chrome override that hides the editor's
// regions while a presentation fills the editor's window is the React
// half (`PresentationChrome`, cockpit/PresentationChrome.tsx).
//
// Targets:
//   · screen    — one surface in the editor's window, then the browser's
//                 full screen (Fullscreen API) where it allows it; leaving
//                 full screen with the browser's own Esc ends the show.
//   · window    — one surface in a window of its own (`window.open`).
//   · secondary — the console in the editor's window and the audience in
//                 a window of its own, placed on another screen when the
//                 Window Management permission is already granted (it is
//                 never asked for here: asking would spend the key press
//                 the window needs). A refused window falls back to the
//                 console alone on the editor's screen.
// The surfaces of one presentation talk over a BroadcastChannel named for
// it, one end per surface.

import type * as Api from "@paged-media/plugin-api";

import type { Disposable } from "./types";

export type PresentationContribution = Api.PresentationContribution;
export type PresentationContext = Api.PresentationContext;

/** The attribute on a surface's root; its value is the role. */
export const PRESENTATION_ATTR = "data-paged-presentation";

export interface PresentationRegistry extends Api.PresentationRegistry {
  get(id: string): PresentationContribution | undefined;
  list(): PresentationContribution[];
  /** Whether a surface of the shown presentation fills the editor's own
   *  window (the chrome is hidden then). */
  inEditorWindow(): boolean;
}

export interface PresentationRegistryOptions {
  /** The editor's window; default `globalThis.window` (absent headless:
   *  nothing can be presented). */
  window?: Window;
  /** Ask the browser for full screen on a `screen` surface (default
   *  true). */
  fullscreen?: boolean;
}

interface Surface {
  role: Api.PresentationRole;
  win: Window;
  root: HTMLElement;
  channel: BroadcastChannel | null;
  cleanup: (() => void) | null;
}

interface Session {
  state: Api.PresentationState;
  surfaces: Surface[];
  popup: Window | null;
  offs: Array<() => void>;
}

let sessionSeq = 0;

export function createPresentationRegistry(
  options: PresentationRegistryOptions = {},
): PresentationRegistry {
  const byId = new Map<string, PresentationContribution>();
  const listeners = new Set<() => void>();
  let session: Session | null = null;
  let exiting: Promise<void> | null = null;
  const editorWindow = (): Window | null =>
    options.window ?? (typeof window === "undefined" ? null : window);
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };

  const exit = async (): Promise<void> => {
    if (exiting) return exiting;
    const s = session;
    if (!s) return;
    exiting = (async () => {
      session = null;
      for (const off of s.offs.splice(0)) off();
      for (const surface of s.surfaces) {
        try {
          surface.cleanup?.();
        } catch {
          // A bundle's cleanup that throws still ends the presentation.
        }
        surface.channel?.close();
        surface.root.remove();
      }
      const doc = editorWindow()?.document;
      if (doc?.fullscreenElement && doc.exitFullscreen) {
        await doc.exitFullscreen().catch(() => {});
      }
      if (s.popup && !s.popup.closed) s.popup.close();
      emit();
    })();
    try {
      await exiting;
    } finally {
      exiting = null;
    }
  };

  const mount = (
    contribution: PresentationContribution,
    state: Api.PresentationState,
    role: Api.PresentationRole,
    win: Window,
    channelName: string,
  ): Surface => {
    const doc = win.document;
    const root = doc.createElement("div");
    root.setAttribute(PRESENTATION_ATTR, role);
    // A key-owning container (focus/key-ownership.ts): the editor's
    // bindings leave its plain keys alone.
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", contribution.title ?? contribution.id);
    root.tabIndex = -1;
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483000",
      background: "#000",
      color: "#fff",
      outline: "none",
      overflow: "hidden",
    });
    doc.body.appendChild(root);
    const channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(channelName)
        : null;
    const ctx: Api.PresentationContext = {
      id: state.id,
      target: state.target,
      role,
      options: state.options,
      window: win,
      channel: {
        post(message) {
          channel?.postMessage(message);
        },
        onMessage(handler) {
          if (!channel) return { dispose() {} };
          const listener = (e: MessageEvent) => handler(e.data);
          channel.addEventListener("message", listener);
          return {
            dispose: () => channel.removeEventListener("message", listener),
          };
        },
      },
      exit: () => void exit(),
    };
    const surface: Surface = { role, win, root, channel, cleanup: null };
    const out = contribution.render(root, ctx);
    if (typeof out === "function") surface.cleanup = out;
    else if (out && typeof out.dispose === "function")
      surface.cleanup = () => out.dispose();
    root.focus();
    return surface;
  };

  /** A window of its own for a surface, on another screen when the
   *  browser already lets the editor place windows; null when refused. */
  const openWindow = async (
    title: string,
    name: string,
  ): Promise<Window | null> => {
    const win = editorWindow();
    if (!win || typeof win.open !== "function") return null;
    let features = "popup=yes,width=960,height=540";
    try {
      const nav = win.navigator as Navigator & {
        permissions?: {
          query(d: { name: string }): Promise<{ state: string }>;
        };
      };
      const placement = win as Window & {
        getScreenDetails?: () => Promise<{
          screens: Array<{
            availLeft: number;
            availTop: number;
            availWidth: number;
            availHeight: number;
          }>;
          currentScreen: unknown;
        }>;
      };
      if (placement.getScreenDetails && nav.permissions) {
        const p = await nav.permissions.query({ name: "window-management" });
        if (p.state === "granted") {
          const details = await placement.getScreenDetails();
          const other = details.screens.find(
            (s) => s !== details.currentScreen,
          );
          if (other) {
            features =
              `popup=yes,left=${other.availLeft},top=${other.availTop},` +
              `width=${other.availWidth},height=${other.availHeight}`;
          }
        }
      }
    } catch {
      // No placement: the window opens where the browser puts it.
    }
    let popup: Window | null = null;
    try {
      popup = win.open("", name, features);
    } catch {
      popup = null;
    }
    if (!popup) return null;
    const doc = popup.document;
    doc.title = title;
    Object.assign(doc.documentElement.style, { height: "100%" });
    Object.assign(doc.body.style, {
      margin: "0",
      height: "100%",
      background: "#000",
    });
    return popup;
  };

  const registry: PresentationRegistry = {
    get secondary() {
      return typeof editorWindow()?.open === "function";
    },
    register(contribution) {
      if (byId.has(contribution.id)) {
        throw new Error(
          `PresentationRegistry: "${contribution.id}" is already registered`,
        );
      }
      byId.set(contribution.id, contribution);
      emit();
      return {
        dispose() {
          if (byId.get(contribution.id) !== contribution) return;
          byId.delete(contribution.id);
          if (session?.state.id === contribution.id) void exit();
          emit();
        },
      };
    },
    async present(request) {
      const contribution = byId.get(request.id);
      if (!contribution)
        return { presented: false, reason: "unknown presentation" };
      const win = editorWindow();
      if (!win) return { presented: false, reason: "no window" };
      if (session) await exit();
      const seq = ++sessionSeq;
      const channelName = `paged-presentation:${request.id}:${seq}`;
      const title = contribution.title ?? contribution.id;
      let target = request.target;
      let reason: string | undefined;
      let popup: Window | null = null;
      if (target === "window" || target === "secondary") {
        popup = await openWindow(title, `paged-presentation-${seq}`);
        if (!popup) {
          if (target === "window")
            return { presented: false, reason: "the window did not open" };
          target = "screen";
          reason = "the audience window did not open";
        }
      }
      const state: Api.PresentationState = {
        id: request.id,
        target,
        options: request.options ?? {},
      };
      const s: Session = { state, surfaces: [], popup, offs: [] };
      session = s;
      const roles: Array<[Api.PresentationRole, Window]> =
        request.target === "secondary"
          ? popup
            ? [
                ["console", win],
                ["audience", popup],
              ]
            : [["console", win]]
          : [["show", popup ?? win]];
      // The chrome goes first, so the surface measures the whole window.
      emit();
      try {
        for (const [role, w] of roles)
          s.surfaces.push(mount(contribution, state, role, w, channelName));
      } catch (err) {
        await exit();
        return {
          presented: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (popup) {
        // Closing the audience window ends the presentation; so does
        // leaving the editor.
        const onClose = () => void exit();
        popup.addEventListener("pagehide", onClose);
        win.addEventListener("pagehide", onClose);
        s.offs.push(
          () => popup?.removeEventListener("pagehide", onClose),
          () => win.removeEventListener("pagehide", onClose),
        );
      }
      if (target === "screen" && request.target === "screen") {
        const root = s.surfaces[0]?.root;
        if (options.fullscreen !== false && root?.requestFullscreen) {
          let entered = false;
          const onChange = () => {
            if (win.document.fullscreenElement) entered = true;
            else if (entered) void exit();
          };
          win.document.addEventListener("fullscreenchange", onChange);
          s.offs.push(() =>
            win.document.removeEventListener("fullscreenchange", onChange),
          );
          root.requestFullscreen().catch(() => {
            // Refused (no user gesture, an iframe without permission):
            // the surface still fills the window.
          });
        }
      }
      return reason
        ? { presented: true, target, reason }
        : { presented: true, target };
    },
    exit,
    current: () => session?.state ?? null,
    inEditorWindow: () => session !== null && session.state.target !== "window",
    get: (id) => byId.get(id),
    list: () => Array.from(byId.values()),
    onChange(handler): Disposable {
      listeners.add(handler);
      return {
        dispose() {
          listeners.delete(handler);
        },
      };
    },
  };
  return registry;
}
