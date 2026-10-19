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

// Shared doors for the styles and colour panels' tests (the B group of
// the panel lane): the style-manager surface (ApplyList), the typed core
// command form, and the waits the colour surfaces need.

import type { PanelHarness } from "../harness";

type AnyHarness = PanelHarness<unknown>;

/** The colour mixer resolves its preview through a 40 ms debounce
 *  (packages/ui use-color-compute); `h.settle()` waits for the engine,
 *  not for timers. Wait past the debounce, then settle. */
export async function settleTimers(h: AnyHarness, ms = 80): Promise<void> {
  await h.act(() => new Promise((r) => setTimeout(r, ms)));
  await h.settle();
}

/** The ApplyList's applied-style select. */
export function applySelect(h: AnyHarness): HTMLSelectElement {
  const el = h.root.querySelector<HTMLSelectElement>("[data-apply-select]");
  if (!el) throw new Error("no applied-style select");
  return el;
}

/** One style row of the ApplyList. */
export function applyItem(h: AnyHarness, selfId: string): HTMLButtonElement {
  const el = h.root.querySelector<HTMLButtonElement>(
    `[data-apply-item="${CSS.escape(selfId)}"]`,
  );
  if (!el) throw new Error(`no style row ${selfId}`);
  return el;
}

/** A footer action of the ApplyList: new, redefine, delete, clear-override. */
export function applyAction(h: AnyHarness, action: string): HTMLButtonElement {
  const el = h.root.querySelector<HTMLButtonElement>(
    `[data-apply-action="${action}"]`,
  );
  if (!el) throw new Error(`no ApplyList action ${action}`);
  return el;
}

/** The style the list marks as applied, or null. */
export function appliedItem(h: AnyHarness): string | null {
  return (
    h.root.querySelector("[data-applied]")?.getAttribute("data-apply-item") ??
    null
  );
}

/** Option labels of a select. */
export function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((o) => o.textContent ?? "");
}

/** `[name, selfId]` rows of a collection, by name. */
export async function rowsByName(
  h: AnyHarness,
  name: Parameters<AnyHarness["client"]["collection"]>[0],
): Promise<Map<string, string>> {
  const rows = (await h.client.collection(name)) as Array<{
    name?: string | null;
    selfId: string;
  }>;
  return new Map(rows.map((r) => [r.name ?? "", r.selfId]));
}

/** Run the typed core command form the panel opened (CoreCommandDialog
 *  mounted beside the panel): click Run and settle. */
export async function runCoreCommand(h: AnyHarness): Promise<void> {
  const run = h.root.ownerDocument.querySelector<HTMLButtonElement>(
    "[data-core-command-run]",
  );
  if (!run) throw new Error("the core command form is not open");
  await h.click(run);
}
