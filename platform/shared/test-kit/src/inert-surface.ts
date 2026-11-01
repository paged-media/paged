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

// A door that exists and does nothing (plugin-sdk ADR 305: a bundle host has
// no optional members). Test fakes of a `BundleHost` spell out the members the
// test inspects and make every other member of a surface inert with this.

/** `own` with every member it does not have answering a no-op that returns a
 *  disposable-shaped value, so `host.contribute.anything(...)`,
 *  `host.bindings.delete(...)` and `host.document.onDidChange(...)` all work. */
export function inertSurface<T extends object>(own: T = {} as T): T {
  const noop = () => ({ dispose() {} });
  return new Proxy(own, {
    get: (target, key) =>
      key in target ? (target as Record<PropertyKey, unknown>)[key] : noop,
  });
}
