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

// The basics of keyboard and assistive-technology reach, for every panel
// (not an audit): each interactive control exposes a role and an
// accessible name, and is reachable with Tab, either itself or through
// the composite widget it belongs to (a radio group, tab list, toolbar,
// list box, menu, grid or tree, which take one tab stop and move inside
// with the arrow keys). Names are computed by dom-accessibility-api, the
// same computation Testing Library's `getByRole({ name })` uses, with
// HTML-AAM's last fallback for text fields (the placeholder) added.

import { computeAccessibleName, getRole } from "dom-accessibility-api";

/** One interactive control as assistive technology sees it. */
export interface Control {
  el: HTMLElement;
  role: string;
  name: string;
  disabled: boolean;
  /** In the tab order itself, or through its composite widget. */
  reachable: boolean;
  /** A short description for failure messages. */
  describe: string;
}

const NATIVE = "button, input:not([type=hidden]), select, textarea, a[href]";
const ROLES = [
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
] as const;
const COMPOSITES =
  '[role="radiogroup"], [role="tablist"], [role="toolbar"], [role="listbox"], ' +
  '[role="menu"], [role="menubar"], [role="grid"], [role="tree"], [role="treegrid"]';

const isDisabled = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled === true ||
  el.getAttribute("aria-disabled") === "true" ||
  el.closest("fieldset[disabled]") !== null;

const inTabOrder = (el: HTMLElement): boolean => {
  if (el.hasAttribute("tabindex")) return el.tabIndex >= 0;
  return el.matches(NATIVE) || el.isContentEditable;
};

/** Every interactive control under `root`, hidden subtrees excluded. */
export function controls(root: HTMLElement): Control[] {
  const selector = [NATIVE, ...ROLES.map((r) => `[role="${r}"]`)].join(", ");
  const out: Control[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (el.closest("[hidden], [aria-hidden=true], [inert]")) continue;
    if ((el as HTMLInputElement).type === "hidden") continue;
    const role =
      getRole(el) ?? el.getAttribute("role") ?? el.tagName.toLowerCase();
    // HTML-AAM names a text field by its placeholder when nothing else
    // names it (browsers do); dom-accessibility-api stops before that.
    const name = (
      computeAccessibleName(el) ||
      (el.matches("input, textarea")
        ? (el.getAttribute("placeholder") ?? "")
        : "")
    ).trim();
    const composite = el.closest(COMPOSITES) as HTMLElement | null;
    const reachable =
      inTabOrder(el) ||
      (composite !== null &&
        Array.from(composite.querySelectorAll<HTMLElement>("*")).some(
          inTabOrder,
        )) ||
      (composite !== null && inTabOrder(composite));
    const label =
      el.getAttribute("data-testid") ??
      el.className.toString().split(" ").slice(0, 2).join(".");
    out.push({
      el,
      role,
      name,
      disabled: isDisabled(el),
      reachable,
      describe: `<${el.tagName.toLowerCase()} role=${role}${label ? ` .${label}` : ""}>`,
    });
  }
  return out;
}

/** The controls that break the basics, as readable lines. */
export function a11yProblems(root: HTMLElement): string[] {
  const problems: string[] = [];
  for (const c of controls(root)) {
    if (!c.name) problems.push(`no accessible name: ${c.describe}`);
    if (!c.disabled && !c.reachable)
      problems.push(`not reachable with Tab: ${c.describe}`);
  }
  return problems;
}
