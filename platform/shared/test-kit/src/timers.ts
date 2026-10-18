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

// `advanceTimersByTimeAsync`: vitest's `vi.advanceTimersByTimeAsync`,
// which bun:test's `vi` lacks.
//
// vitest fires the due timers one at a time and lets the event loop turn
// after each, so a promise continuation of one timer runs at THAT timer's
// time and a timer it schedules counts from there. bun:test's synchronous
// `vi.advanceTimersByTime` drains microtasks between timers only in some
// call contexts (not once the test has awaited), so this helper steps: a
// sentinel timer marks the window's last millisecond but one, the clock
// moves timer by timer (settling after each) until the sentinel fires, and
// one synchronous millisecond ends the window, so the timers due at its
// very end fire too, even those scheduled during the call.
//
// bun:test runs `setTimeout(f, 0)` one millisecond later (as Node does) and
// `advanceTimersByTime(0)` advances by one, so `ms = 0` fires the
// zero-delay timers as vitest's does, one fake millisecond later.

/** The runner's fake clock (bun:test's or vitest's `vi`). */
export interface TimerClock {
  advanceTimersByTime(ms: number): unknown;
  advanceTimersToNextTimer(): unknown;
}

// Captured at import. bun:test does not fake setImmediate; vitest replaces
// the global, so this reference stays the real one under both.
const realSetImmediate: ((cb: () => void) => unknown) | undefined =
  globalThis.setImmediate;

/** One turn of the real event loop: every queued microtask has run afterwards. */
export function settle(): Promise<void> {
  if (realSetImmediate)
    return new Promise((resolve) => void realSetImmediate(resolve));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export async function advanceTimersByTimeAsync(
  clock: TimerClock,
  ms: number,
): Promise<void> {
  await settle();
  if (ms > 1) {
    let reached = false;
    // The global setTimeout is the fake one while fake timers are on.
    globalThis.setTimeout(() => {
      reached = true;
    }, ms - 1);
    while (!reached) {
      clock.advanceTimersToNextTimer();
      await settle();
    }
    clock.advanceTimersByTime(1);
  } else {
    clock.advanceTimersByTime(ms);
  }
  await settle();
}
