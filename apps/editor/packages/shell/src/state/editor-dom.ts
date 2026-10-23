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

// DOM lookups within one editor (plan task E1): a page may hold two, so
// "the viewport" is the one inside this editor's root. React-free, so the
// focus helpers can use it.

/** The first element inside `root` matching `selector` (the page's when
 *  the editor has no root): the editor's own viewport, never another
 *  editor's. */
export function queryEditor<E extends Element = Element>(
  root: ParentNode | null,
  selector: string,
): E | null {
  if (root) return root.querySelector<E>(selector);
  return typeof document === "undefined"
    ? null
    : document.querySelector<E>(selector);
}
