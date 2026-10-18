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

// The internal test kit of the built-in modules (docs/adr/PM-0002): small,
// runner-agnostic helpers for what vitest's `vi` had and bun:test's does
// not. Nothing here imports a test runner, so a suite can use the kit under
// either; nothing community-facing imports the kit (the public subset of
// test helpers belongs in the plugin-sdk harness instead).

export { waitFor, type FakeClock, type WaitForOptions } from "./wait-for.ts";
export { stubGlobal, unstubAllGlobals } from "./globals.ts";
export { importActual } from "./modules.ts";
export { advanceTimersByTimeAsync, settle, type TimerClock } from "./timers.ts";
