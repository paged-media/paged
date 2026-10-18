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

// `waitFor`: vitest's `vi.waitFor`, which bun:test's `vi` lacks.
//
// Calls `callback` until it returns (or its promise resolves) without
// throwing, and returns that value. Gives up after `timeout` ms and rethrows
// the last error. Between attempts it sleeps `interval` ms on the real
// clock, captured when this module loads, before a test can install fake
// timers.
//
// FAKE TIMERS. vitest's `vi.waitFor` advances the fake clock by `interval`
// per attempt when fake timers are on. A runner-agnostic helper cannot see
// the runner's clock, so a suite that waits under fake timers passes it:
// `waitFor(cb, { clock: vi })`. (bun:test freezes Date, performance.now and
// hrtime and fakes setTimeout itself, so there is no real clock to sleep on
// while its fake timers are on.)

import { settle } from "./timers.ts";

/** The runner's fake clock (bun:test's or vitest's `vi`). */
export interface FakeClock {
  isFakeTimers(): boolean;
  advanceTimersByTime(ms: number): unknown;
}

export interface WaitForOptions {
  /** Give up after this many milliseconds (default 1000, as vitest). */
  timeout?: number;
  /** Milliseconds between attempts (default 50, as vitest). */
  interval?: number;
  /** Advance this clock by `interval` per attempt while its fake timers are on. */
  clock?: FakeClock;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

class WaitForTimeout extends Error {}

/** Resolves like `p`, or rejects once `ms` real milliseconds have passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    id = realSetTimeout(
      () => reject(new WaitForTimeout(`waitFor: timed out in ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timer]).finally(() => realClearTimeout(id));
}

export async function waitFor<T>(
  callback: () => T | Promise<T>,
  options: number | WaitForOptions = {},
): Promise<T> {
  const {
    timeout = 1000,
    interval = 50,
    clock,
  } = typeof options === "number" ? { timeout: options } : options;
  const start = Date.now();
  let waited = 0;
  let lastError: unknown = new Error(`waitFor: timed out in ${timeout}ms`);
  for (;;) {
    const fake = clock?.isFakeTimers() === true;
    try {
      const result = callback();
      if (
        result instanceof Promise ||
        (result && typeof (result as { then?: unknown }).then === "function")
      ) {
        const remaining = Math.max(1, timeout - (Date.now() - start));
        return await (fake
          ? (result as Promise<T>)
          : within(Promise.resolve(result), remaining));
      }
      return result as T;
    } catch (e) {
      if (e instanceof WaitForTimeout)
        throw lastError instanceof Error ? lastError : e;
      lastError = e;
    }
    const elapsed = fake ? waited : Date.now() - start;
    if (elapsed >= timeout) throw lastError;
    if (fake && clock) {
      clock.advanceTimersByTime(interval);
      waited += interval;
      await settle();
    } else {
      await sleep(interval);
    }
  }
}
