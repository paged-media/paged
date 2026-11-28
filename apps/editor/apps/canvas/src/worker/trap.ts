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

// A WebAssembly trap in the engine. A Rust panic (the engine is built to
// abort on one), an out-of-bounds access or an exhausted stack surfaces in
// JavaScript as a `WebAssembly.RuntimeError`, thrown out of whichever wasm
// export was running. The instance is then in an unknown state: the call
// was abandoned half way, its locks and borrows were never released and
// its memory may be half written. Every later call would run on that
// state, so the worker stops calling the engine and says so
// (`ENGINE_TRAPPED`), and the client treats it as fatal: the editor shows
// the engine-failure notice and the recovery copy holds the work.
//
// An ordinary `Error` thrown by the glue (a refused argument, "recursive
// use of an object") is not a trap: the engine never ran, or unwound
// cleanly, and only that request fails.
//
// No imports: the worker loads this without the shell or React.

/** The `warning` kind the worker reports a trap with (the client's
 *  `settleFromWarning` reads it). */
export const ENGINE_TRAPPED = "engineTrapped";

/** Did `err` come out of a trapped wasm instance? */
export function isEngineTrap(err: unknown): boolean {
  const RuntimeError = (
    globalThis as { WebAssembly?: { RuntimeError?: unknown } }
  ).WebAssembly?.RuntimeError;
  if (typeof RuntimeError === "function" && err instanceof RuntimeError)
    return true;
  // A trap that crossed a realm or was re-thrown as a plain object keeps
  // its name.
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "RuntimeError"
  );
}
