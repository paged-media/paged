/*
 * This file is part of paged (https://paged.media).
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

// THE IMAGE TRACE WORKER — the module `host.workers` spawns for
// `TRACE_WORKER_MODULE`, and the reason a trace no longer freezes the
// thread that asked for it (`trace-engine.ts`, "the worker lane", is the
// other half and carries the protocol).
//
// It is its OWN entry of the build (`tsup.config.ts`) and its own export
// of the package (`./trace-worker`), because the host cannot spawn a
// module out of the middle of `index.js`: the editor resolves a bundle's
// declared worker module to a URL its bundler built as a worker chunk
// (`…/trace-worker?worker&url`) — the paged.image decode-worker shape.
//
// NO AMBIENT AUTHORITY. The worker is handed no engine, no document, no
// DOM and no network: it boots a second, worker-local instance of the
// trace wasm and answers what it is asked over `postMessage`. Everything
// it imports is `trace-engine.ts`, which imports nothing of the bundle.
//
// THIS MODULE MUST STAY AT `src/` DEPTH 1, for `trace-engine.ts`'s
// reason: the wasm is reached as `../wasm/…`, and tsup's `dist/` is flat.

import {
  answerTraceRequest,
  bootTraceEngine,
  type TraceWorkerReply,
  type TraceWorkerRequest,
} from "./trace-engine";

/** The two things of a dedicated worker's global scope this module uses
 *  — a structural type, so the file needs no `webworker` lib and a test
 *  can stand in for the scope. */
export interface TraceWorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

/**
 * Answer trace requests arriving on `scope`, one at a time and in arrival
 * order. The wasm boots on the first request and is kept for the life of
 * the worker; a boot failure is ANSWERED (every request gets a reply — the
 * other side has no other way to learn the worker is broken).
 */
export function serveTraceRequests(scope: TraceWorkerScope): void {
  let queue: Promise<void> = Promise.resolve();
  scope.onmessage = (event) => {
    const request = event.data as TraceWorkerRequest;
    queue = queue.then(async () => {
      let reply: TraceWorkerReply;
      try {
        reply = answerTraceRequest(await bootTraceEngine(), request);
      } catch (err) {
        reply = {
          id: request.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      scope.postMessage(reply);
    });
  };
}

// Serve only when this module IS a dedicated worker's entry. Imported
// anywhere else — the main thread, a test — it wires nothing.
const realm = globalThis as unknown as {
  DedicatedWorkerGlobalScope?: new () => unknown;
};
if (
  typeof realm.DedicatedWorkerGlobalScope === "function" &&
  globalThis instanceof realm.DedicatedWorkerGlobalScope
) {
  serveTraceRequests(globalThis as unknown as TraceWorkerScope);
}
