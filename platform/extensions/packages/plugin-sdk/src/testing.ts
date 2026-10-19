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

// Small test doubles a bundle's own suite needs beside the harness, so no
// suite hand-rolls them (community bundles included). Runner-agnostic:
// nothing here imports a test runner.
//
//   loadBundle(() => fake.editor, bundle, {
//     console: silentConsole,
//     storage: mapBacking(),
//   });
//
// `createFakeEditor` (the gesture kit) is the recording editor such a call
// takes; `createHeadlessHost` is the conformance host over the real engine.

import type { StorageBacking } from "./host-impl.js";

/** A `StorageBacking` over an in-memory map: what `host.storage` persists
 *  into in a test, private to the test (a browser-like realm's
 *  `localStorage` would leak between tests). `entries` seeds it. */
export function mapBacking(
  entries?: Iterable<readonly [string, string]>,
): StorageBacking {
  const map = new Map<string, string>(entries);
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    keys: () => Array.from(map.keys()),
  };
}

/** A console (and `PluginLogger`) that says nothing: the `console` of a
 *  host under test, or the `log` of a stub host. */
export const silentConsole: Readonly<
  Pick<Console, "debug" | "info" | "warn" | "error">
> = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});
