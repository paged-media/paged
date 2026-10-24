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

// The host's side of the iframe bridge (plan E6): `connectEditor(iframe,
// config)` resolves to the same handle `createEditor` gives, every method
// answering a promise. The editor's engine needs a cross-origin isolated
// page, and a frame is isolated only when its top page is: the host page
// sends `Cross-Origin-Opener-Policy: same-origin` and
// `Cross-Origin-Embedder-Policy: credentialless` (which, unlike
// `require-corp`, asks nothing of the host's other resources), and the frame
// is allowed `cross-origin-isolated`, which connectEditor sets.

import type { EditorEvent, EditorHandle } from "./create-editor";
import type { HostActions } from "../app/instance";
import { editorError } from "./errors";
import {
  BRIDGED_METHODS,
  SCRIPT_METHOD,
  transferables,
  type BridgedMethod,
  type FrameConfig,
  type FrameToHost,
  type HostToFrame,
} from "./protocol";

type Async<F> = F extends (...a: infer A) => infer R
  ? (...a: A) => Promise<Awaited<R>>
  : never;

/** The handle over the frame: the data methods of `EditorHandle`, async. */
export type RemoteEditorHandle = {
  [M in BridgedMethod]: Async<EditorHandle[M]>;
} & {
  /** Runs `paged.*` script source in the frame (dev and demo builds of the
   *  editor only; a production frame refuses it). */
  runScript(
    source: string,
  ): Promise<{ output: string[]; error: string | null }>;
  on(listener: (event: EditorEvent) => void): () => void;
  dispose(): void;
};

export interface ConnectConfig extends Omit<FrameConfig, "actions"> {
  actions?: HostActions;
  /** The frame's origin; else the iframe's `src` origin. */
  origin?: string;
  /** How long to wait for the frame, in ms (default 60 s). */
  timeout?: number;
}

export function connectEditor(
  iframe: HTMLIFrameElement,
  config: ConnectConfig = {},
): Promise<RemoteEditorHandle> {
  const { actions = {}, origin: given, timeout = 60_000, ...rest } = config;
  const origin = given ?? new URL(iframe.src, location.href).origin;
  const allow = new Set(
    (iframe.getAttribute("allow") ?? "")
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean),
  );
  if (![...allow].some((p) => p.startsWith("cross-origin-isolated"))) {
    allow.add("cross-origin-isolated");
    // Set before the frame loads; a frame already loaded keeps its policy.
    iframe.setAttribute("allow", [...allow].join("; "));
  }
  const frame = () => iframe.contentWindow;
  const send = (msg: HostToFrame) =>
    frame()?.postMessage(msg, origin, transferables(msg));
  let nextCall = 1;
  const calls = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();
  const listeners = new Set<(event: EditorEvent) => void>();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(
        new Error(
          `connectEditor: the frame did not become ready in ${timeout} ms`,
        ),
      );
    }, timeout);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame() || e.origin !== origin) return;
      const msg = e.data as FrameToHost;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "paged:loaded":
          send({
            type: "paged:init",
            config: {
              ...rest,
              actions: (Object.keys(actions) as (keyof HostActions)[]).filter(
                (k) => typeof actions[k] === "function",
              ),
            } as FrameConfig,
          });
          return;
        case "paged:ready":
          clearTimeout(timer);
          resolve(handle);
          return;
        case "paged:failed":
          clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          // A refusal the editor names keeps its code (EditorError).
          reject(
            msg.code
              ? editorError(msg.code, `connectEditor: ${msg.error}`)
              : new Error(`connectEditor: ${msg.error}`),
          );
          return;
        case "paged:reply": {
          const call = calls.get(msg.id);
          calls.delete(msg.id);
          if (msg.ok) call?.resolve(msg.value);
          else call?.reject(new Error(msg.error ?? "the call failed"));
          return;
        }
        case "paged:event":
          for (const l of [...listeners]) l(msg.event);
          return;
        case "paged:action": {
          const fn = actions[msg.action] as
            | ((file?: { bytes: Uint8Array; name: string }) => unknown)
            | undefined;
          const file = msg.bytes
            ? { bytes: msg.bytes, name: msg.name ?? "document.paged" }
            : undefined;
          Promise.resolve()
            .then(() => fn?.(file))
            .then(
              () => send({ type: "paged:action-reply", id: msg.id, ok: true }),
              (err: unknown) =>
                send({
                  type: "paged:action-reply",
                  id: msg.id,
                  ok: false,
                  error: String(err),
                }),
            );
          return;
        }
      }
    };
    window.addEventListener("message", onMessage);

    const call =
      (method: BridgedMethod | typeof SCRIPT_METHOD) =>
      (...args: unknown[]) =>
        new Promise((res, rej) => {
          const id = nextCall++;
          calls.set(id, { resolve: res, reject: rej });
          send({ type: "paged:call", id, method, args });
        });
    const handle = {
      ...Object.fromEntries(BRIDGED_METHODS.map((m) => [m, call(m)])),
      runScript: call(SCRIPT_METHOD),
      on(listener: (event: EditorEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        window.removeEventListener("message", onMessage);
        listeners.clear();
        for (const c of calls.values()) c.reject(new Error("disposed"));
        calls.clear();
      },
    } as unknown as RemoteEditorHandle;
  });
}
