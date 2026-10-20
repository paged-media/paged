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

// The shell surface in the browser, registry-driven: the live menu and
// keybinding registries read back from the running editor, the menu bar
// read back from the DOM, the edit contexts the matrix walks (no
// document, a document, each selection kind, a caret, inside a plugin
// frame, each workflow mode), and a command recorder that stands in for
// handlers so a menu click or a key press is asserted by the command it
// dispatched, without the handler's side effects (a file picker, a
// download, a new tab).
//
// Fixtures are built in code (the test kit's IDML builder): the editor's
// Playwright lane in CI cannot check out the private corpus.

import { expect, type Page } from "@playwright/test";

import {
  browserGestures,
  buildFixtureIdml,
  group,
  oval,
  polygon,
  rect,
  textFrame,
  type BrowserPage,
} from "@paged-media/test-kit";

import { fitFirstPage, openCanvas } from "../../fidelity/canvas-driver";

const IDML_MIME = "application/vnd.adobe.indesign-idml-package";

/** The matrix document: one of each selection kind on page 1, a second
 *  page, a story. Page-local points. */
export const SHELL = {
  pageId: "sp1",
  frame: { kind: "rectangle", id: "sframe" },
  group: { kind: "group", id: "sgroup" },
  poly: { kind: "polygon", id: "spoly" },
  /** Inside the closed polygon (a double-click enters vectorGraphic). */
  polyAt: [380, 560] as const,
  text: { kind: "textFrame", id: "stext" },
  storyId: "sstory",
} as const;

export function shellFixture(): Uint8Array {
  return buildFixtureIdml({
    name: "shell-matrix",
    stories: [
      { id: SHELL.storyId, paragraphs: ["Shell matrix", "Second line"] },
    ],
    pages: [
      {
        id: SHELL.pageId,
        items: [
          rect("sframe", [100, 72, 172, 216]),
          group("sgroup", [
            rect("sgA", [100, 300, 160, 380]),
            oval("sgB", [110, 400, 170, 480]),
          ]),
          polygon(
            "spoly",
            [
              [300, 500],
              [460, 500],
              [460, 620],
              [300, 620],
            ],
            false,
            { fill: "Color/Gray" },
          ),
          textFrame("stext", [240, 72, 320, 288], SHELL.storyId),
        ],
      },
      { id: "sp2", items: [rect("sp2frame", [100, 72, 172, 216])] },
    ],
  });
}

/** Boot the editor; with `doc`, load the matrix fixture and fit page 1. */
export async function openShell(
  page: Page,
  options: { doc: boolean; answerReplacePrompts?: boolean } = { doc: true },
): Promise<void> {
  await openCanvas(page, {
    answerReplacePrompts: options.answerReplacePrompts,
  });
  if (!options.doc) return;
  await loadShellFixture(page);
}

export async function loadShellFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = (globalThis as unknown as { __canvas?: { ready?: boolean } })
      .__canvas;
    if (c) c.ready = false;
  });
  await page.setInputFiles('input[type="file"]', {
    name: "shell-matrix.idml",
    mimeType: IDML_MIME,
    buffer: Buffer.from(shellFixture()),
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean(
            (globalThis as unknown as { __canvas?: { ready?: boolean } })
              .__canvas?.ready,
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await fitFirstPage(page);
  await blurAll(page);
}

/** Leave the focus where a user who just clicked the page has it. */
export async function blurAll(page: Page): Promise<void> {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
}

/** Focus the canvas viewport as a click in it does (ADR 234): Tab is then
 *  the chrome toggle. The pointerdown lands on the viewport element itself,
 *  not on the document under it, so no selection changes. */
export async function engageCanvas(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(
      '[data-canvas-surface="viewport"]',
    );
    if (!viewport) throw new Error("no canvas viewport surface");
    viewport.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
  });
}

interface CanvasHandle {
  client: {
    setElementSelection(ids: unknown[], mode: string): Promise<unknown[]>;
    elementGeometry(ids: unknown[]): Promise<unknown[]>;
  };
  setElementSelection(ids: unknown[]): void;
  setElementGeometry(items: unknown[]): void;
  setContentSelection(
    sel: { storyId: string; start: number; end: number } | null,
  ): void;
  setMode(mode: string): void;
  mode: string;
  debugContext(): {
    editContext: { type: string } | null;
    panels: { open: string[] };
  } | null;
  registries: {
    modes: { list(): Array<{ id: string }> };
  };
}

/** Select elements the way a click leaves them (worker + mirror +
 *  geometry); `[]` clears, and also clears any caret. */
export async function select(
  page: Page,
  ids: ReadonlyArray<{ kind: string; id: string }>,
): Promise<void> {
  await page.evaluate(
    async (list) => {
      const c = (globalThis as unknown as { __canvas: CanvasHandle }).__canvas;
      const applied = await c.client.setElementSelection(list, "replace");
      c.setElementSelection(applied);
      c.setElementGeometry(
        applied.length ? await c.client.elementGeometry(applied) : [],
      );
      if (list.length === 0) c.setContentSelection(null);
    },
    ids as Array<{ kind: string; id: string }>,
  );
}

export async function setCaret(page: Page, offset = 3): Promise<void> {
  await page.evaluate(
    ({ storyId, offset: o }) =>
      (
        globalThis as unknown as { __canvas: CanvasHandle }
      ).__canvas.setContentSelection({ storyId, start: o, end: o }),
    { storyId: SHELL.storyId as string, offset },
  );
}

export async function setMode(page: Page, mode: string): Promise<void> {
  await page.evaluate(
    (m) =>
      (globalThis as unknown as { __canvas: CanvasHandle }).__canvas.setMode(m),
    mode,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as { __canvas: CanvasHandle }).__canvas.mode,
      ),
    )
    .toBe(mode);
}

export async function modes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { __canvas: CanvasHandle }
    ).__canvas.registries.modes
      .list()
      .map((m) => m.id),
  );
}

export async function activeEditContext(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as { __canvas: CanvasHandle }
      ).__canvas.debugContext()?.editContext?.type ?? null,
  );
}

export async function openPanels(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as { __canvas: CanvasHandle }
      ).__canvas.debugContext()?.panels.open ?? [],
  );
}

/** Enter the draw bundle's vectorGraphic context: double-click inside
 *  the closed polygon with the Selection tool. */
export async function enterVectorGraphic(page: Page): Promise<void> {
  await select(page, []);
  const g = browserGestures(page as unknown as BrowserPage);
  await g
    .tool("select")
    .dblclick({ page: 0, at: [...SHELL.polyAt] as [number, number] })
    .settle();
  await expect.poll(() => activeEditContext(page)).toBe("vectorGraphic");
}

// ── the live registries ──────────────────────────────────────────────

export interface MenuRow {
  path: string;
  command: string;
  /** What the registry says: not a seam, not a label, `when` holds. */
  enabled: boolean;
  /** The label the bar shows (labelFor, else the last segment). */
  label: string;
  kind: "item" | "label";
  seam: boolean;
}

/** Plugin surface by namespace: a plugin's own command. (A HOST item may
 *  open a plugin panel: the Data menu's rows are the editor's own.) */
export const isPluginCommand = (command: string): boolean =>
  command.startsWith("media.");

/** The two derived menu families (gate ids `menu:Window/*`,
 *  `menu:Plugins/*`): the panel-show entries the shell derives from the
 *  panel registry. */
export const menuFamily = (row: {
  path: string;
  command: string;
}): "Window/*" | "Plugins/*" | null => {
  if (!row.command.startsWith("paged.panel.show.")) return null;
  if (row.path.startsWith("Window/")) return "Window/*";
  if (row.path.startsWith("Plugins/")) return "Plugins/*";
  return null;
};

/** Every registered menu item, evaluated against the live editor (the
 *  state the bar evaluates `when` with: the `PagedEditor` the command
 *  registry hands handlers, fetched through a probe command), by the bar's
 *  rule: the item's `when` and its command's (ADR 249). */
export async function liveMenu(page: Page): Promise<MenuRow[]> {
  return page.evaluate(async () => {
    type Item = {
      path: string;
      command: string;
      when?: unknown;
      disabled?: boolean;
      kind?: string;
      labelFor?: (s: unknown) => string | null;
    };
    const r = (
      globalThis as unknown as {
        __canvas: {
          registries: {
            menus: { list(): Item[] };
            commands: {
              register(c: unknown): { dispose(): void };
              invoke(id: string): Promise<unknown>;
              get(id: string): { when?: unknown } | undefined;
            };
          };
        };
      }
    ).__canvas.registries;
    const probe = r.commands.register({
      id: "test.shell.probeEditor",
      title: "probe",
      handler: (paged: unknown) => paged,
    });
    const editor = await r.commands.invoke("test.shell.probeEditor");
    probe.dispose();
    const applies = (when: unknown) => {
      if (when === undefined) return true;
      if (typeof when !== "function") return false;
      try {
        return Boolean((when as (s: unknown) => unknown)(editor));
      } catch {
        return false;
      }
    };
    return r.menus.list().map((m) => {
      const last = m.path.split("/").filter(Boolean).pop() ?? m.path;
      let label = last;
      if (m.labelFor) {
        try {
          label = m.labelFor(editor) ?? last;
        } catch {
          /* the bar falls back to the static label too */
        }
      }
      const kind = m.kind === "label" ? "label" : "item";
      return {
        path: m.path,
        command: m.command,
        // ADR 249: the item's own `when`, its command registered, and the
        // command's `when` (`entryApplies`).
        enabled:
          !m.disabled &&
          kind === "item" &&
          applies(m.when) &&
          r.commands.get(m.command) !== undefined &&
          applies(r.commands.get(m.command)?.when),
        label,
        kind,
        seam: Boolean(m.disabled),
      } as const;
    });
  });
}

/** Where the bar renders a registered path: an `Insert X` verb filed
 *  directly under a core menu moves to Insert ▸ X (MenuBar's rule). */
export function renderedPath(path: string): string {
  const CORE = [
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
  ];
  const segs = path.split("/").filter(Boolean);
  // A menu outside the core set is a context menu, on the bar only where
  // its content is; its always-present copy is Plugins ▸ <name>.
  if (!CORE.includes(segs[0])) return ["Plugins", ...segs].join("/");
  if (segs.length === 2 && segs[0] !== "Insert" && CORE.includes(segs[0])) {
    const verb = segs[1].match(/^Insert (.+)$/);
    if (verb)
      return `Insert/${verb[1].charAt(0).toUpperCase()}${verb[1].slice(1)}`;
  }
  return segs.join("/");
}

export interface DomRow {
  /** Menu ▸ submenu ▸ label, joined with "/". */
  path: string;
  disabled: boolean;
  kind: "item" | "label";
}

/** Read the rendered menu bar: open every top-level menu named in
 *  `tops`, walk every submenu, record each row. */
/** Open a top-level menu (a fresh press; retried once when a closing
 *  menu swallowed it) and return its content. */
async function openTop(
  page: Page,
  top: string,
): Promise<{
  trigger: ReturnType<Page["locator"]>;
  content: ReturnType<Page["locator"]>;
}> {
  const trigger = page.locator(`[data-menu-trigger="${top}"]`).first();
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await trigger.click();
  try {
    await expect(trigger).toHaveAttribute("aria-expanded", "true", {
      timeout: 2_000,
    });
  } catch {
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }
  const content = page.locator(
    `[id="${await trigger.getAttribute("aria-controls")}"]`,
  );
  await expect(content).toBeVisible();
  return { trigger, content };
}

export async function readMenuBar(
  page: Page,
  tops: readonly string[],
): Promise<Map<string, DomRow>> {
  const out = new Map<string, DomRow>();
  for (const top of tops) {
    if ((await page.locator(`[data-menu-trigger="${top}"]`).count()) === 0)
      continue;
    const { trigger, content } = await openTop(page, top);
    await walk(page, content, top, out);
    await dismissMenus(page, trigger, content);
  }
  return out;
}

/** Open a submenu: by keyboard (a pointer crossing the rows above opens
 *  and closes their submenus on the way, and detaches the target), else
 *  by a click — while a text caret is active the arrows never reach the
 *  menu (finding SH-11). */
async function openSubmenu(sub: ReturnType<Page["locator"]>): Promise<void> {
  await sub.focus();
  await sub.page().keyboard.press("ArrowRight");
  try {
    await expect(sub).toHaveAttribute("data-state", "open", {
      timeout: 1_500,
    });
  } catch {
    await sub.click();
    await expect(sub).toHaveAttribute("data-state", "open");
  }
}

/** Close the open menu WITHOUT a key: Escape would also leave an active
 *  edit context. A modal menu makes the page inert (pointer-events off),
 *  so a raw press on the trigger's spot lands on the document root, which
 *  is "outside" the menu: Radix dismisses it there. */
async function dismissMenus(
  page: Page,
  trigger: ReturnType<Page["locator"]>,
  content: ReturnType<Page["locator"]>,
): Promise<void> {
  const box = await trigger.boundingBox();
  if (!box) throw new Error("menu trigger has no box");
  await page.mouse.click(box.x + 2, box.y + 2);
  await expect(content).toBeHidden();
}

async function walk(
  page: Page,
  content: ReturnType<Page["locator"]>,
  prefix: string,
  out: Map<string, DomRow>,
): Promise<void> {
  const rows = await content.evaluate((el) =>
    Array.from(el.children).map((child) => {
      const c = child as HTMLElement;
      const clone = c.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll("[data-menu-accelerator]")
        .forEach((n) => n.remove());
      clone.querySelectorAll("span").forEach((n) => {
        if (n.textContent?.trim() === "soon") n.remove();
      });
      return {
        role: c.getAttribute("role"),
        submenu: c.getAttribute("data-menu-submenu"),
        isLabel: c.hasAttribute("data-menu-label"),
        disabled: c.hasAttribute("data-disabled"),
        text: (clone.textContent ?? "").trim(),
      };
    }),
  );
  for (const row of rows) {
    if (row.submenu) {
      const trigger = content
        .locator(`[data-menu-submenu="${row.submenu}"]`)
        .first();
      await openSubmenu(trigger);
      const sub = page.locator(
        `[id="${await trigger.getAttribute("aria-controls")}"]`,
      );
      await expect(sub).toBeVisible();
      await walk(page, sub, `${prefix}/${row.submenu}`, out);
      continue;
    }
    if (row.isLabel) {
      out.set(`${prefix}/${row.text}`, {
        path: `${prefix}/${row.text}`,
        disabled: true,
        kind: "label",
      });
    } else if (row.role === "menuitem" || row.role === "menuitemcheckbox") {
      // A toggle (View ▸ Snap to points) is a menuitemcheckbox (SH-4).
      out.set(`${prefix}/${row.text}`, {
        path: `${prefix}/${row.text}`,
        disabled: row.disabled,
        kind: "item",
      });
    }
  }
}

/** The bar's row for a registry row (its rendered path, its label). */
export function domPathOf(row: MenuRow): string {
  const segs = renderedPath(row.path).split("/");
  const registered = row.path.split("/").filter(Boolean).pop();
  // A computed label (labelFor) replaces the leaf; a relocated Insert
  // verb keeps its relocated name.
  if (row.label !== registered) segs[segs.length - 1] = row.label;
  return segs.join("/");
}

/** Walk to the rendered row at `domPath` ("Object/Path/Close path"):
 *  open the top-level menu and each submenu on the way, then report the
 *  row (null when absent) and, with `click`, choose it when enabled. The
 *  menu is closed afterwards either way. */
export async function menuRow(
  page: Page,
  domPath: string,
  options: { click?: boolean } = {},
): Promise<{ disabled: boolean } | null> {
  const [top, ...rest] = domPath.split("/");
  const opened = await openTop(page, top);
  let content = opened.content;
  const close = () => dismissMenus(page, opened.trigger, opened.content);
  for (const name of rest.slice(0, -1)) {
    const sub = content.locator(
      `:scope > [data-menu-submenu="${name.replace(/"/g, '\\"')}"]`,
    );
    if ((await sub.count()) === 0) {
      await close();
      return null;
    }
    await openSubmenu(sub);
    content = page.locator(`[id="${await sub.getAttribute("aria-controls")}"]`);
    await expect(content).toBeVisible();
  }
  const label = rest[rest.length - 1];
  const index = await content.evaluate((el, want) => {
    const rows = Array.from(el.children);
    return rows.findIndex((c) => {
      const role = c.getAttribute("role");
      if (role !== "menuitem" && role !== "menuitemcheckbox") return false;
      if (c.hasAttribute("data-menu-submenu")) return false;
      const clone = c.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll("[data-menu-accelerator]")
        .forEach((x) => x.remove());
      clone.querySelectorAll("span").forEach((x) => {
        if (x.textContent?.trim() === "soon") x.remove();
      });
      return (clone.textContent ?? "").trim() === want;
    });
  }, label);
  if (index < 0) {
    await close();
    return null;
  }
  const row = content.locator(":scope > *").nth(index);
  const disabled = (await row.getAttribute("data-disabled")) !== null;
  if (options.click && !disabled) {
    // The keyboard again: a long submenu can run past the viewport.
    // The pointer, not Enter: Enter on a menu item also reaches the
    // canvas (finding SH-12). A row of a long submenu can sit past the
    // viewport; then the click event goes to it directly.
    try {
      await row.click({ timeout: 3_000 });
    } catch {
      await row.dispatchEvent("click");
    }
    // Choosing an item closes the whole menu.
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
  } else {
    await close();
  }
  return { disabled };
}

/** Click the rendered row at `domPath`; throws when it is absent. */
export async function clickMenuRow(page: Page, domPath: string): Promise<void> {
  const row = await menuRow(page, domPath, { click: true });
  if (!row) throw new Error(`no menu row "${domPath}"`);
  if (row.disabled) throw new Error(`menu row "${domPath}" is disabled`);
}

// ── the command recorder ─────────────────────────────────────────────

/** Replace the handlers of `ids` with a recorder (their `when` and
 *  `args` stay, so the registry's gate still applies); returns the ids
 *  invoked, in order, and puts the real handlers back on `restore`. */
export async function recordCommands(
  page: Page,
  ids: readonly string[],
): Promise<{ take(): Promise<string[]>; restore(): Promise<void> }> {
  await page.evaluate((list) => {
    type Cmd = { id: string; handler: (...a: unknown[]) => unknown };
    const g = globalThis as unknown as {
      __canvas: {
        registries: {
          commands: {
            get(id: string): Cmd | undefined;
            unregister(id: string): void;
            register(c: Cmd): unknown;
          };
        };
      };
      __shellRecorder?: { calls: string[]; saved: Cmd[] };
    };
    const commands = g.__canvas.registries.commands;
    const rec = { calls: [] as string[], saved: [] as Cmd[] };
    for (const id of list) {
      const real = commands.get(id);
      if (!real) continue;
      rec.saved.push(real);
      commands.unregister(id);
      commands.register({
        ...real,
        handler: () => void rec.calls.push(id),
      });
    }
    g.__shellRecorder = rec;
  }, ids as string[]);
  return {
    take: () =>
      page.evaluate(() => {
        const g = globalThis as unknown as {
          __shellRecorder: { calls: string[] };
        };
        const calls = [...g.__shellRecorder.calls];
        g.__shellRecorder.calls.length = 0;
        return calls;
      }),
    restore: () =>
      page.evaluate(() => {
        type Cmd = { id: string };
        const g = globalThis as unknown as {
          __canvas: {
            registries: {
              commands: {
                unregister(id: string): void;
                register(c: Cmd): unknown;
              };
            };
          };
          __shellRecorder?: { saved: Cmd[] };
        };
        const commands = g.__canvas.registries.commands;
        for (const real of g.__shellRecorder?.saved ?? []) {
          commands.unregister(real.id);
          commands.register(real);
        }
        delete g.__shellRecorder;
      }),
  };
}

// ── keybindings ──────────────────────────────────────────────────────

export interface KeyRow {
  key: string;
  command: string;
  guarded: boolean;
}

export async function liveKeybindings(page: Page): Promise<KeyRow[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as {
        __canvas: {
          registries: {
            keybindings: {
              list(): Array<{ key: string; command: string; when?: unknown }>;
            };
          };
        };
      }
    ).__canvas.registries.keybindings
      .list()
      .map((k) => ({
        key: k.key,
        command: k.command,
        guarded: k.when !== undefined,
      })),
  );
}

/** A registered combo as Playwright's `keyboard.press` spells it. */
export function playwrightKey(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const mods = parts.map(
    (m) =>
      ({
        cmd: "Meta",
        meta: "Meta",
        ctrl: "Control",
        control: "Control",
        alt: "Alt",
        option: "Alt",
        shift: "Shift",
      })[m] ?? m,
  );
  const named: Record<string, string> = {
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    backspace: "Backspace",
    delete: "Delete",
    tab: "Tab",
    escape: "Escape",
    enter: "Enter",
  };
  const k = named[key] ?? (key.length === 1 ? key : key);
  return [...mods, k].join("+");
}
