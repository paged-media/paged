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

// The plugin MENU driver: reach a bundle's `contribute.menu` entry through
// the real menu bar, the way a user does, and record what clicking it did.
//
// WHERE AN ENTRY LIVES ON THE BAR. A bundle names a path; the bar
// (packages/shell/src/chrome/MenuBar.tsx) decides where it shows:
//
//   · a path under a CORE menu stays there (`Edit/Select same/Fill` →
//     Edit ▸ Select same ▸ Fill), except a two-segment `Insert …` verb,
//     which moves to the Insert menu, capitalised (`Object/Insert
//     spreadsheet…` → Insert ▸ Spreadsheet…);
//   · a path under a menu of the plugin's own (`Sheet/Sort range…`) is
//     folded into Plugins ▸ <name> (Plugins ▸ Sheet ▸ Sort range…), which
//     is always on the bar, AND shows as a context menu of its own after
//     the divider while the plugin's content is selected or entered.
//
// `routeOf` turns a registered path into the clicks; `openLeaf` performs
// them. The route through Plugins is the one every entry has, so the
// per-entry tests use it; each bundle's spec also drives its context
// menu once.
//
// WHAT A CLICK DID. Three recorders, installed once per page:
//
//   · the command registry's own tap (`registries.commands.observe`):
//     a `started` / `settled` pair per invocation that RAN. The registry
//     refuses a command whose own `when` is false before the handler and
//     before any observer, so "started" proves the handler was reached;
//   · the shell doors a bundle calls (`openPanel`, `pickFile`, `saveFile`,
//     `enterEditContext`), through the dev-only `__shellDoors` handle the
//     SDK adapter reads at call time. `pickFile` answers "cancelled"
//     immediately: the assertion is the request (and its accept filter),
//     and a native chooser would hold the command open;
//   · the document, as an IDML export digest (the oracle the draw surface
//     spec settled on: a pixel diff misses invisible edits, an export does
//     not).

import { expect, type Locator, type Page } from "@playwright/test";

/** The bar's fixed menus (MenuBar.tsx `CORE_MENUS`). */
const CORE_MENUS = [
  "File",
  "Edit",
  "Insert",
  "Object",
  "Type",
  "Layout",
  "View",
  "Plugins",
  "Window",
  "Help",
] as const;

/** The clicks that reach a registered path: the top-level trigger, the
 *  submenus to hover, the leaf's visible label. */
export interface MenuRoute {
  trigger: string;
  submenus: string[];
  leaf: string;
}

/** Where `path` shows through the always-present route (see the header). */
export function routeOf(path: string): MenuRoute {
  let segments = path.split("/").filter(Boolean);
  if (
    segments[0] !== "Insert" &&
    (CORE_MENUS as readonly string[]).includes(segments[0]) &&
    segments.length === 2
  ) {
    const verb = /^Insert (.+)$/.exec(segments[1]);
    if (verb)
      segments = ["Insert", verb[1].charAt(0).toUpperCase() + verb[1].slice(1)];
  }
  const [top, ...rest] = segments;
  if ((CORE_MENUS as readonly string[]).includes(top))
    return {
      trigger: top,
      submenus: rest.slice(0, -1),
      leaf: rest[rest.length - 1],
    };
  return {
    trigger: "Plugins",
    submenus: [top, ...rest.slice(0, -1)],
    leaf: rest[rest.length - 1],
  };
}

/** The same path through its plugin's CONTEXT menu (`Sheet ▸ …`). */
export function contextRouteOf(path: string): MenuRoute {
  const [top, ...rest] = path.split("/").filter(Boolean);
  return {
    trigger: top,
    submenus: rest.slice(0, -1),
    leaf: rest[rest.length - 1],
  };
}

const bar = (page: Page) => page.locator('nav[aria-label="Main menu"]');

/** Close every open menu level. */
export async function closeMenus(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if ((await page.locator('[role="menu"]').count()) === 0) return;
    await page.keyboard.press("Escape");
  }
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
}

/** Open the route's menus and return the leaf's menu item (not clicked).
 *  Each level is the LAST open `role=menu`, so a label that repeats in
 *  another menu (Image ▸ File vs the File trigger) cannot be mistaken. */
export async function openLeaf(page: Page, route: MenuRoute): Promise<Locator> {
  await closeMenus(page);
  await bar(page).locator(`[data-menu-trigger="${route.trigger}"]`).click();
  for (const name of route.submenus) {
    const level = page.locator('[role="menu"]').last();
    const sub = level.locator(`[data-menu-submenu="${name}"]`);
    await expect(sub, `submenu "${name}"`).toBeVisible();
    const count = await page.locator('[role="menu"]').count();
    await sub.hover();
    // ArrowRight as well: a hover alone is racy when the pointer path
    // crosses a sibling submenu trigger on the way.
    await sub.press("ArrowRight");
    await expect(page.locator('[role="menu"]')).toHaveCount(count + 1);
  }
  const level = page.locator('[role="menu"]').last();
  // An item's text carries its accelerator column (`Copy cells⌘C`) and a
  // label can prefix a sibling's (`Outline stroke` / `Outline stroke
  // options…`), so compare the item's OWN label: its text without the
  // accelerator / "soon" spans.
  const items = level.getByRole("menuitem");
  const labels = await items.evaluateAll((els) =>
    els.map((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      for (const span of Array.from(clone.querySelectorAll("span")))
        if (span.textContent && !span.getAttribute("aria-hidden"))
          span.remove();
      return (clone.textContent ?? "").trim();
    }),
  );
  const hits = labels.flatMap((l, i) => (l === route.leaf ? [i] : []));
  expect(
    hits.length,
    `exactly one menu item "${route.leaf}" (have: ${labels.join(" | ")})`,
  ).toBe(1);
  return items.nth(hits[0]);
}

/** Whether a menu item renders greyed (Radix: `data-disabled`). */
export async function isGreyed(item: Locator): Promise<boolean> {
  return (await item.getAttribute("aria-disabled")) === "true";
}

export interface CommandRun {
  phase: "started" | "settled";
  id: string;
  /** `"undefined"` or the JSON of the payload. */
  payload: string;
  error: string | null;
}

export interface ShellCall {
  door:
    "openPanel" | "closePanel" | "pickFile" | "saveFile" | "enterEditContext";
  arg: string;
}

interface ProbeWindow {
  __menuProbe?: { runs: CommandRun[]; shell: ShellCall[] };
  __shellDoors?: Record<string, (...a: unknown[]) => unknown>;
  __canvas: {
    registries: {
      commands: {
        observe(
          fn: (e: {
            phase: "started" | "settled";
            invocation: { id: string; payload: unknown };
            error?: unknown;
          }) => void,
        ): unknown;
        invoke(id: string, payload?: unknown): Promise<unknown>;
      };
    };
    client: { exportIdml(): Promise<Uint8Array> };
    handle: { pageCount: number; pageIds: string[] } | null;
  };
}

/** Install the recorders (idempotent per page load). */
export async function installMenuProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as ProbeWindow;
    if (w.__menuProbe) return;
    const probe = { runs: [] as CommandRun[], shell: [] as ShellCall[] };
    w.__menuProbe = probe;
    w.__canvas.registries.commands.observe((e) => {
      probe.runs.push({
        phase: e.phase,
        id: e.invocation.id,
        payload:
          e.invocation.payload === undefined
            ? "undefined"
            : JSON.stringify(e.invocation.payload),
        error:
          e.phase === "settled" && e.error
            ? e.error instanceof Error
              ? e.error.message
              : String(e.error)
            : null,
      });
    });
    const doors = w.__shellDoors;
    if (!doors) throw new Error("no __shellDoors — not a dev build");
    const arg = (a: unknown) => {
      try {
        return typeof a === "string" ? a : JSON.stringify(a ?? null);
      } catch {
        return String(a);
      }
    };
    for (const door of [
      "openPanel",
      "closePanel",
      "saveFile",
      "enterEditContext",
    ] as const) {
      const real = doors[door];
      if (typeof real !== "function") continue;
      doors[door] = (...a: unknown[]) => {
        probe.shell.push({
          door,
          arg:
            door === "saveFile"
              ? arg({
                  suggestedName: (a[0] as { suggestedName?: string })
                    ?.suggestedName,
                })
              : arg(a[0]),
        });
        return real(...a);
      };
    }
    doors.pickFile = (options: unknown) => {
      probe.shell.push({ door: "pickFile", arg: arg(options ?? null) });
      return Promise.resolve([]);
    };
  });
}

/** Everything the recorders saw since `mark`. */
export async function recordedSince(
  page: Page,
  mark: { runs: number; shell: number },
): Promise<{ runs: CommandRun[]; shell: ShellCall[] }> {
  return page.evaluate((m) => {
    const p = (globalThis as unknown as ProbeWindow).__menuProbe!;
    return { runs: p.runs.slice(m.runs), shell: p.shell.slice(m.shell) };
  }, mark);
}

export async function mark(
  page: Page,
): Promise<{ runs: number; shell: number }> {
  return page.evaluate(() => {
    const p = (globalThis as unknown as ProbeWindow).__menuProbe!;
    return { runs: p.runs.length, shell: p.shell.length };
  });
}

/** A digest of the document as IDML (FNV-1a over the export). */
export async function documentDigest(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as ProbeWindow).__canvas;
    const bytes = await c.client.exportIdml();
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 16777619);
    }
    return `${bytes.byteLength}:${(h >>> 0).toString(16)}`;
  });
}

export interface ClickOutcome {
  runs: CommandRun[];
  shell: ShellCall[];
  /** The document digest before and after the click. */
  before: string;
  after: string;
}

/**
 * Click `path`'s menu item through the real bar and wait for its command
 * to settle. Asserts what every entry owes: the item is there, ENABLED,
 * and the click runs exactly `command` once with no payload (the bar
 * invokes by id, and an entry's handler must not need one).
 */
export async function clickEntry(
  page: Page,
  path: string,
  command: string,
  options: { route?: MenuRoute } = {},
): Promise<ClickOutcome> {
  const route = options.route ?? routeOf(path);
  const before = await documentDigest(page);
  const m = await mark(page);
  const item = await openLeaf(page, route);
  expect(await isGreyed(item), `${path} is enabled`).toBe(false);
  await item.click();
  await expect
    .poll(
      async () =>
        (await recordedSince(page, m)).runs.filter(
          (r) => r.id === command && r.phase === "settled",
        ).length,
      { message: `${path} → ${command} settles`, timeout: 15_000 },
    )
    .toBe(1);
  await closeMenus(page);
  const seen = await recordedSince(page, m);
  const started = seen.runs.filter((r) => r.phase === "started");
  expect(
    started.map((r) => r.id),
    `${path} runs exactly its command`,
  ).toEqual([command]);
  expect(started[0].payload, `${path} passes no payload`).toBe("undefined");
  const settled = seen.runs.find(
    (r) => r.id === command && r.phase === "settled",
  )!;
  expect(settled.error, `${path}: the handler settles without throwing`).toBe(
    null,
  );
  return { ...seen, before, after: await documentDigest(page) };
}

/** Click a GREYED entry: assert it stays greyed and runs nothing. */
export async function expectGreyedAndInert(
  page: Page,
  path: string,
  options: { route?: MenuRoute } = {},
): Promise<void> {
  const m = await mark(page);
  const item = await openLeaf(page, options.route ?? routeOf(path));
  expect(await isGreyed(item), `${path} is greyed`).toBe(true);
  await item.click({ force: true });
  await closeMenus(page);
  const seen = await recordedSince(page, m);
  expect(seen.runs, `${path} runs nothing while greyed`).toEqual([]);
}

/** Run a host command by id (setup only: undo, a new document). */
export async function runCommand(
  page: Page,
  id: string,
  payload?: unknown,
): Promise<unknown> {
  return page.evaluate(
    ({ id, payload }) =>
      (
        globalThis as unknown as ProbeWindow
      ).__canvas.registries.commands.invoke(id, payload),
    { id, payload },
  );
}

/** One Undo (the host's own command) takes the document back to `before`:
 *  a menu click is ONE user action, so it is one undo step. */
export async function expectOneUndoRestores(
  page: Page,
  path: string,
  before: string,
): Promise<void> {
  await runCommand(page, "paged.editor.undo");
  await expect
    .poll(() => documentDigest(page), {
      message: `one Undo takes ${path}'s edit back`,
      timeout: 10_000,
    })
    .toBe(before);
}

/** How many Undos it takes to get back to `before` (at most `max`). */
export async function undosToRestore(
  page: Page,
  before: string,
  max = 8,
): Promise<number> {
  for (let n = 0; n <= max; n++) {
    if ((await documentDigest(page)) === before) return n;
    await runCommand(page, "paged.editor.undo");
  }
  return Number.POSITIVE_INFINITY;
}

/** The two editors every menu spec drives: `bare` has no document (every
 *  plugin entry is greyed there: the SDK scopes an entry to "a document is
 *  open"), `live` has one. Two pages of one context, so each entry's test
 *  can assert both states without reloading a document between them. */
export async function openMenuPages(
  browser: import("@playwright/test").Browser,
  use: {
    baseURL?: string;
    viewport?: { width: number; height: number } | null;
  },
): Promise<{ bare: Page; live: Page; close(): Promise<void> }> {
  const context = await browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport ?? { width: 1600, height: 1000 },
  });
  const { Designer } = await import("../journey/driver/designer");
  const bare = await context.newPage();
  await new Designer(bare).open();
  await installMenuProbe(bare);
  const live = await context.newPage();
  const designer = new Designer(live);
  await designer.open();
  await designer.newDocument();
  await installMenuProbe(live);
  return { bare, live, close: () => context.close() };
}
