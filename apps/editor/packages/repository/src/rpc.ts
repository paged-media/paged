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

// The library runs in its own worker, so hashing and unzipping a large
// document never blocks the editor's main thread. This is the whole
// protocol: a call names a library method, the reply carries its result.
// Byte arrays travel as transferables in both directions.

import type { Library } from "./library.ts";

interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

type Call = { id: number; method: string; args: unknown[] };
type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

/** The library's methods, every one answering asynchronously. */
export type LibraryClient = {
  [
    K in keyof Library as Library[K] extends (...a: never[]) => unknown
      ? K
      : never
  ]: Library[K] extends (...a: infer A) => infer R
    ? (...a: A) => Promise<Awaited<R>>
    : never;
};

function transfers(v: unknown): Transferable[] {
  if (v instanceof Uint8Array) return [v.buffer];
  if (Array.isArray(v)) return v.flatMap(transfers);
  return [];
}

/** Answers calls arriving on `port` with `library` (made once, on first call). */
export function serveLibrary(port: Port, make: () => Promise<Library>): void {
  let library: Promise<Library> | null = null;
  port.addEventListener("message", async (e: MessageEvent<Call>) => {
    const { id, method, args } = e.data;
    let reply: Reply;
    try {
      library ??= make();
      const lib = (await library) as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >;
      if (typeof lib[method] !== "function")
        throw new Error(`no library method ${method}`);
      reply = { id, ok: true, value: await lib[method](...args) };
    } catch (err) {
      reply = {
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    port.postMessage(reply, reply.ok ? transfers(reply.value) : []);
  });
}

/** A client for a library served on `port`. Arguments that are byte arrays
 *  are transferred: the caller must not use them after the call. */
export function connectLibrary(port: Port): LibraryClient {
  let next = 0;
  const pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();
  port.addEventListener("message", (e: MessageEvent<Reply>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.value);
    else p.reject(new Error(e.data.error));
  });
  return new Proxy({} as LibraryClient, {
    get(_, method) {
      if (typeof method !== "string") return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = next++;
          pending.set(id, { resolve, reject });
          port.postMessage(
            { id, method, args } satisfies Call,
            transfers(args),
          );
        });
    },
  });
}
