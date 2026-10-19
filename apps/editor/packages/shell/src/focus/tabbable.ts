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

// The sequential focus order of a subtree, as a browser walks it with
// Tab: elements with a positive tabindex first (ascending, DOM order on
// ties), then every other focusable element in DOM order. Disabled
// controls, `tabindex="-1"`, hidden inputs and anything under `hidden`,
// `inert` or `display: none` are skipped. Used to state the chrome's tab
// order in the DOM lane, where no browser does the walk.

const CANDIDATES = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "[tabindex]",
  '[contenteditable]:not([contenteditable="false"])',
].join(",");

function displayed(el: HTMLElement): boolean {
  if (el.closest("[hidden],[inert]")) return false;
  if (typeof getComputedStyle !== "function") return true;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const style = getComputedStyle(n);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
  }
  return true;
}

export function tabbableElements(root: ParentNode): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(CANDIDATES));
  const usable = all.filter((el) => {
    if (el.tabIndex < 0) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    return displayed(el);
  });
  const positive = usable
    .filter((el) => el.tabIndex > 0)
    .sort((a, b) => a.tabIndex - b.tabIndex);
  return [...positive, ...usable.filter((el) => el.tabIndex === 0)];
}
