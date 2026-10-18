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

// `importActual`: vitest's `vi.importActual` / a mock factory's
// `importOriginal`, which bun:test lacks.
//
// bun:test's `mock.module` replaces a module's exports in place, so every
// namespace object of it (even one imported earlier) shows the mock
// afterwards. Take the real exports as a plain copy BEFORE mocking:
//
//   const actual = await importActual(() => import("../src/engine"));
//   mock.module("../src/engine", () => ({ ...actual, bootEngine: fake }));
//
// The loader is a thunk so the specifier resolves against the caller's
// file, not this one.

export async function importActual<T extends object>(
  load: () => Promise<T>,
): Promise<T> {
  return { ...(await load()) };
}
