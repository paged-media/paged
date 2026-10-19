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

// Trailing-edge debouncing: a burst of calls yields exactly one, `ms`
// after the last. `createDebouncer` is the plain object (no React), so its
// timing is testable with fake timers without rendering, and module
// sessions that take their timers from the host can use it too;
// `useDebouncedValue` is the hook a panel shows a settling value with.

import * as React from "react";

/** The timer pair a debouncer runs on. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The global timers, read at each call (so fake timers installed after
 *  the debouncer was made still apply). */
const GLOBAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Debouncer {
  /** Replace the pending callback (if any) and restart the window. */
  schedule(fn: () => void): void;
  /** Drop the pending callback without running it. */
  cancel(): void;
  /** Run the pending callback now, if there is one. */
  flush(): void;
  /** Whether a callback is pending. */
  pending(): boolean;
}

/** A trailing-edge debouncer with a window of `ms`. */
export function createDebouncer(
  ms: number,
  timers: Timers = GLOBAL_TIMERS,
): Debouncer {
  let handle: unknown = null;
  let queued: (() => void) | null = null;
  const fire = () => {
    handle = null;
    const fn = queued;
    queued = null;
    fn?.();
  };
  const stop = () => {
    if (queued !== null) timers.clearTimeout(handle);
    handle = null;
  };
  return {
    schedule(fn) {
      stop();
      queued = fn;
      handle = timers.setTimeout(fire, ms);
    },
    cancel() {
      stop();
      queued = null;
    },
    flush() {
      if (queued === null) return;
      stop();
      fire();
    },
    pending() {
      return queued !== null;
    },
  };
}

/** `value`, `ms` after it last changed. The first render shows `value`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(() => value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
