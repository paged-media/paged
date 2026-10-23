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

// The editor's side of the iframe bridge (plan E6), run by embed.html. It
// waits for the host's `paged:init`, makes the editor, and answers the
// host's calls. Only a parent on an allowed origin is heard; the first
// init fixes the origin every later message must come from.

import type { EditorHandle } from "./create-editor";
import {
  BRIDGED_METHODS,
  SCRIPT_METHOD,
  transferables,
  type FrameToHost,
  type HostToFrame,
} from "./protocol";

export interface BridgeOptions {
  /** Origins whose pages may drive this editor. */
  origins: readonly string[];
  /** Where the editor is mounted. */
  element: HTMLElement;
  /** The page this frame talks to (the parent window). */
  peer: Window;
  /** The frame's own window (where messages arrive). */
  self?: Window;
}

/** Serves the embedding API to the parent; resolves to the handle once the
 *  editor is made (for tests), never rejects. */
export function serveBridge(
  options: BridgeOptions,
): Promise<EditorHandle | null> {
  const self = options.self ?? window;
  let origin: string | null = null;
  let handle: EditorHandle | null = null;
  let nextAction = 1;
  const pending = new Map<
    number,
    (r: { ok: boolean; error?: string }) => void
  >();
  const post = (msg: FrameToHost) => {
    if (origin) options.peer.postMessage(msg, origin, transferables(msg));
  };
  const ask = (
    action: "save" | "submit" | "close" | "back",
    file?: { bytes: Uint8Array; name: string },
  ) =>
    new Promise<void>((resolve, reject) => {
      const id = nextAction++;
      pending.set(id, (r) =>
        r.ok ? resolve() : reject(new Error(r.error ?? `${action} failed`)),
      );
      post({
        type: "paged:action",
        id,
        action,
        ...(file ? { bytes: file.bytes, name: file.name } : {}),
      });
    });

  return new Promise((resolveReady) => {
    self.addEventListener("message", (e: MessageEvent) => {
      if (e.source !== options.peer) return;
      if (origin ? e.origin !== origin : !options.origins.includes(e.origin))
        return;
      const msg = e.data as HostToFrame;
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string")
        return;
      if (msg.type === "paged:init") {
        if (origin) return;
        origin = e.origin;
        if (
          (self as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
          false
        ) {
          post({
            type: "paged:failed",
            error:
              'the editor\'s frame is not cross-origin isolated: the host page needs Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless, and the iframe allow="cross-origin-isolated"',
          });
          resolveReady(null);
          return;
        }
        const { actions = [], ...config } = msg.config;
        const hostActions = Object.fromEntries(
          actions.map((a) => [
            a,
            a === "save"
              ? (file: { bytes: Uint8Array; name: string }) => ask("save", file)
              : () => ask(a),
          ]),
        );
        // Loaded when a host initialises: the editor's code is not needed
        // to turn a stranger away.
        import("./create-editor")
          .then(({ createEditor }) =>
            createEditor(options.element, { ...config, actions: hostActions }),
          )
          .then(
            (h) => {
              handle = h;
              h.on((event) => post({ type: "paged:event", event }));
              post({ type: "paged:ready" });
              resolveReady(h);
            },
            (err: unknown) => {
              post({ type: "paged:failed", error: String(err) });
              resolveReady(null);
            },
          );
        return;
      }
      if (msg.type === "paged:action-reply") {
        pending.get(msg.id)?.({
          ok: msg.ok,
          ...(msg.error ? { error: msg.error } : {}),
        });
        pending.delete(msg.id);
        return;
      }
      if (msg.type === "paged:call") {
        const reply = (r: { ok: boolean; value?: unknown; error?: string }) =>
          post({ type: "paged:reply", id: msg.id, ...r });
        if (!handle)
          return reply({ ok: false, error: "the editor is not ready" });
        if (msg.method === SCRIPT_METHOD) {
          // The docs' scripting playground: dev and demo builds only.
          if (import.meta.env.PROD && import.meta.env.MODE !== "demo")
            return reply({
              ok: false,
              error: "scripts run in dev and demo builds only",
            });
          const source = String(msg.args?.[0] ?? "");
          handle.client.executeScript(source).then(
            (r) =>
              reply({ ok: true, value: { output: r.output, error: r.error } }),
            (err: unknown) => reply({ ok: false, error: String(err) }),
          );
          return;
        }
        const method = msg.method;
        if (!(BRIDGED_METHODS as readonly string[]).includes(method))
          return reply({ ok: false, error: `no method ${String(method)}` });
        const fn = handle[method] as (...a: unknown[]) => unknown;
        Promise.resolve()
          .then(() => fn.apply(handle, msg.args ?? []))
          .then(
            (value) => reply({ ok: true, value }),
            (err: unknown) => reply({ ok: false, error: String(err) }),
          );
      }
    });
    // Tells the host the frame listens: it may send init now.
    options.peer.postMessage(
      { type: "paged:loaded" } satisfies FrameToHost,
      "*",
    );
  });
}
