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

// The host commands whose effect is the BROWSER — the camera, the chrome,
// a dialog, a download, a file picker, a new tab, the view extras — run
// through the live registry with their real handlers, each asserted by
// what the user would see. The document commands are asserted against
// the real engine in tests/headless/commands-*.test.ts; these are the
// rest of the integration clause.
//
// The three derived command families run here too, member by member from
// the live registry: only the browser has every panel and plugin tool.

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import {
  SHELL,
  blurAll,
  openPanels,
  openShell,
  select,
} from "./harness/shell-surface";

type Registries = {
  commands: {
    invoke(id: string, payload?: unknown): Promise<unknown>;
    list(): Array<{ id: string }>;
    observe(o: (e: { phase: string; invocation: { id: string } }) => void): {
      dispose(): void;
    };
  };
  panels: { list(): Array<{ id: string; title: string }> };
};
type G = {
  __canvas: {
    registries: Registries;
    client: {
      camera: { read(): { scale: number; tx: number; ty: number } };
      elementProperties(id: unknown): Promise<{
        entries?: Array<{ path?: string; value?: unknown }>;
      } | null>;
    };
    debugContext(): {
      tools: { base: string | null };
      panels: { open: string[] };
    } | null;
  };
};

const invoke = (page: Page, id: string, payload?: unknown) =>
  page.evaluate(
    ([i, p]) =>
      (globalThis as unknown as G).__canvas.registries.commands.invoke(i, p),
    [id, payload] as const,
  );

const scale = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as G).__canvas.client.camera.read().scale,
  );

/** The view toggles live in a module-scope store; read the app's own
 *  instance of it through the dev server (the same URL the app loaded). */
const VIEW_TOGGLES = realpathSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/shell/src/state/view-toggles.ts",
  ),
);
const viewToggle = (page: Page, which: string) =>
  page.evaluate(
    async ([path, w]) => {
      const m = (await import(/* @vite-ignore */ `/@fs${path}`)) as {
        getViewToggle(x: string): boolean;
      };
      return m.getViewToggle(w);
    },
    [VIEW_TOGGLES, which] as const,
  );

test.describe("view commands", () => {
  test("zoom in, zoom out, 100%, fit document move the camera", async ({
    page,
  }) => {
    covers(
      "command:paged.view.zoomIn",
      "command:paged.view.zoomOut",
      "command:paged.view.zoom100",
      "command:paged.view.zoomFit",
    );
    await openShell(page, { doc: true });
    await invoke(page, "paged.view.zoom100");
    await expect.poll(() => scale(page)).toBeCloseTo(1, 2);
    await invoke(page, "paged.view.zoomIn");
    await expect.poll(() => scale(page)).toBeGreaterThan(1.01);
    const zoomedIn = await scale(page);
    await invoke(page, "paged.view.zoomOut");
    await expect.poll(() => scale(page)).toBeLessThan(zoomedIn - 0.01);
    await invoke(page, "paged.view.zoom100");
    await expect.poll(() => scale(page)).toBeCloseTo(1, 2);
    await invoke(page, "paged.view.zoomFit");
    // Fit document shows both pages of the 1600 × 1000 viewport: below 1.
    await expect.poll(() => scale(page)).toBeLessThan(0.99);
  });

  test("the View extras flip the store their overlays and tools read", async ({
    page,
  }) => {
    covers(
      "command:paged.view.toggleTextThreads",
      "command:paged.view.toggleSnapToPoints",
      "command:paged.view.toggleHeadingAnchors",
    );
    await openShell(page, { doc: true });
    const flags = async () => ({
      textThreads: await viewToggle(page, "textThreads"),
      snapToPoints: await viewToggle(page, "snapToPoints"),
      headingAnchors: await viewToggle(page, "headingAnchors"),
    });
    expect(await flags()).toEqual({
      textThreads: false,
      snapToPoints: true,
      headingAnchors: false,
    });
    const threads = page.locator("[data-thread-lines]").first();
    await expect(threads).toHaveAttribute("data-thread-lines", "off");
    await invoke(page, "paged.view.toggleTextThreads");
    await invoke(page, "paged.view.toggleSnapToPoints");
    await invoke(page, "paged.view.toggleHeadingAnchors");
    expect(await flags()).toEqual({
      textThreads: true,
      snapToPoints: false,
      headingAnchors: true,
    });
    // The thread-line overlay draws (one unthreaded frame: no hops).
    await expect(threads).not.toHaveAttribute("data-thread-lines", "off");
    await invoke(page, "paged.view.toggleTextThreads");
    await invoke(page, "paged.view.toggleSnapToPoints");
    await invoke(page, "paged.view.toggleHeadingAnchors");
    expect(await flags()).toEqual({
      textThreads: false,
      snapToPoints: true,
      headingAnchors: false,
    });
  });

  test("the preview screen mode toggles Normal ⇄ Preview", async ({ page }) => {
    covers("command:paged.view.toggleScreenPreview");
    await openShell(page, { doc: true });
    const mode = page.locator("[data-screen-mode]").first();
    await expect(mode).toHaveAttribute("data-screen-mode", "normal");
    await invoke(page, "paged.view.toggleScreenPreview");
    await expect(mode).toHaveAttribute("data-screen-mode", "preview");
    await invoke(page, "paged.view.toggleScreenPreview");
    await expect(mode).toHaveAttribute("data-screen-mode", "normal");
  });
});

test.describe("chrome commands", () => {
  const rail = (page: Page) => page.locator('nav[aria-label="Tools"]');
  const leftPanel = (page: Page) => page.locator("[data-left-panel]");

  test("toggle panels and tool rail hides both, and brings both back", async ({
    page,
  }) => {
    covers("command:paged.chrome.toggleAll");
    await openShell(page, { doc: true });
    await expect(rail(page)).toBeVisible();
    await expect(leftPanel(page)).toBeVisible();
    await invoke(page, "paged.chrome.toggleAll");
    await expect(rail(page)).toBeHidden();
    // Hidden, and kept mounted for the way back (ADR 240).
    await expect(leftPanel(page)).toBeHidden();
    await invoke(page, "paged.chrome.toggleAll");
    await expect(rail(page)).toBeVisible();
    await expect(leftPanel(page)).toBeVisible();
  });

  test("toggle panels hides the panels and keeps the tool rail", async ({
    page,
  }) => {
    covers("command:paged.chrome.togglePanels");
    await openShell(page, { doc: true });
    await invoke(page, "paged.chrome.togglePanels");
    await expect(leftPanel(page)).toBeHidden();
    await expect(rail(page)).toBeVisible();
    await invoke(page, "paged.chrome.togglePanels");
    await expect(leftPanel(page)).toBeVisible();
  });

  test("the command palette opens and closes", async ({ page }) => {
    covers("command:paged.palette.toggle");
    await openShell(page, { doc: true });
    const input = page.locator("[cmdk-input]");
    await expect(input).toHaveCount(0);
    await invoke(page, "paged.palette.toggle");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await invoke(page, "paged.palette.toggle");
    await expect(input).toHaveCount(0);
  });
});

test.describe("file commands", () => {
  test("Save (.paged) downloads the document as a .paged container", async ({
    page,
  }) => {
    covers("command:paged.file.savePaged");
    await openShell(page, { doc: true });
    const download = page.waitForEvent("download");
    await invoke(page, "paged.file.savePaged");
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.paged$/);
    const bytes = await file.createReadStream().then(async (s) => {
      const chunks: Buffer[] = [];
      for await (const c of s) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    });
    // A ZIP (the container is a valid IDML package).
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  test("Save As IDML downloads an .idml package", async ({ page }) => {
    covers("command:paged.file.saveAsIdml");
    await openShell(page, { doc: true });
    const download = page.waitForEvent("download");
    await invoke(page, "paged.file.saveAsIdml");
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.idml$/);
  });

  test("Open PDF asks for a .pdf file", async ({ page }) => {
    covers("command:paged.file.openPdf");
    await openShell(page, { doc: true });
    const chooser = page.waitForEvent("filechooser");
    // The command waits on the picker; it settles once the picker does.
    const pending = invoke(page, "paged.file.openPdf");
    const fc = await chooser;
    const accept = await fc.element().getAttribute("accept");
    expect(accept ?? "").toContain(".pdf");
    expect(fc.isMultiple()).toBe(false);
    // Cancel: no file, nothing opened, the command resolves.
    await fc.setFiles([]);
    await pending;
  });

  test("Export PDF opens the export dialog", async ({ page }) => {
    covers("command:paged.file.exportPdf");
    await openShell(page, { doc: true });
    await invoke(page, "paged.file.exportPdf");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Export PDF/i);
  });
});

test.describe("help, assistant and effects commands", () => {
  test("each Help link opens its page in a new tab", async ({ page }) => {
    covers(
      "command:paged.help.docs",
      "command:paged.help.idmlReference",
      "command:paged.help.reportIssue",
    );
    await openShell(page, { doc: true });
    await page.evaluate(() => {
      const g = globalThis as unknown as { __opened: unknown[][] };
      g.__opened = [];
      window.open = ((...args: unknown[]) => {
        g.__opened.push(args);
        return null;
      }) as typeof window.open;
    });
    for (const id of [
      "paged.help.docs",
      "paged.help.idmlReference",
      "paged.help.reportIssue",
    ])
      await invoke(page, id);
    const opened = await page.evaluate(
      () => (globalThis as unknown as { __opened: unknown[][] }).__opened,
    );
    expect(opened.map((a) => a[1])).toEqual(["_blank", "_blank", "_blank"]);
    expect(opened[0][0]).toBe("https://docs.paged.media/");
    expect(opened[1][0]).toBe("https://idml.paged.media/");
    expect(String(opened[2][0])).toMatch(/\/issues\/new$/);
  });

  test("Ask Claude opens the assistant panel", async ({ page }) => {
    covers("command:paged.ai.ask");
    await openShell(page, { doc: true });
    await invoke(page, "paged.ai.ask", "Make the title larger");
    await expect.poll(() => openPanels(page)).toContain("paged.ai-assistant");
  });

  test("Global light opens its dialog", async ({ page }) => {
    covers("command:paged.effects.globalLight");
    await openShell(page, { doc: true });
    await invoke(page, "paged.effects.globalLight");
    await expect(page.locator("#global-light-title")).toBeVisible();
  });
});

test.describe("actions: record, stop, play", () => {
  test("a recorded command plays back", async ({ page }) => {
    covers(
      "command:paged.actions.record",
      "command:paged.actions.stop",
      "command:paged.actions.play",
    );
    await openShell(page, { doc: true });
    await page.evaluate(() => {
      const g = globalThis as unknown as G & { __ran: string[] };
      g.__ran = [];
      g.__canvas.registries.commands.observe((e) => {
        if (e.phase === "started") g.__ran.push(e.invocation.id);
      });
    });
    await invoke(page, "paged.view.zoom100");
    await invoke(page, "paged.actions.record");
    await invoke(page, "paged.view.zoomIn");
    await invoke(page, "paged.actions.stop");
    await invoke(page, "paged.view.zoom100");
    const before = await scale(page);
    await page.evaluate(() => {
      (globalThis as unknown as { __ran: string[] }).__ran.length = 0;
    });
    await invoke(page, "paged.actions.play");
    await expect
      .poll(() =>
        page.evaluate(
          () => (globalThis as unknown as { __ran: string[] }).__ran,
        ),
      )
      .toContain("paged.view.zoomIn");
    await expect.poll(() => scale(page)).toBeGreaterThan(before + 0.01);
  });
});

test.describe("fill and stroke commands", () => {
  /** The selected frame's fill and stroke swatch, read from the engine. */
  const colors = (page: Page) =>
    page.evaluate(async (id) => {
      const props = await (
        globalThis as unknown as G
      ).__canvas.client.elementProperties(id);
      const entries =
        (
          props as {
            entries?: Array<{ path?: string; value?: unknown }>;
          } | null
        )?.entries ?? [];
      const find = (re: RegExp) =>
        JSON.stringify(
          entries.find((e) => re.test(e.path ?? ""))?.value ?? null,
        );
      return {
        fill: find(/^frameFillColor$/),
        stroke: find(/^frameStrokeColor$/),
      };
    }, SHELL.frame as unknown);

  test("swap exchanges the selection's fill and stroke; default resets them", async ({
    page,
  }) => {
    covers("command:paged.fillStroke.swap", "command:paged.fillStroke.default");
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    await blurAll(page);
    const before = await colors(page);
    expect(before.fill).not.toBe(before.stroke);
    await invoke(page, "paged.fillStroke.swap");
    await expect
      .poll(() => colors(page))
      .toEqual({ fill: before.stroke, stroke: before.fill });
    await invoke(page, "paged.fillStroke.default");
    await expect
      .poll(() => colors(page))
      .not.toEqual({
        fill: before.stroke,
        stroke: before.fill,
      });
    const reset = await colors(page);
    // InDesign's default: no fill, a black stroke.
    expect(reset.stroke).toContain("Black");
  });

  test("toggle affects flips formatting between the container and the text", async ({
    page,
  }) => {
    covers("command:paged.fillStroke.toggleAffects");
    await openShell(page, { doc: true });
    const button = page.locator("[data-fs-affects]").first();
    const first = await button.getAttribute("data-fs-affects");
    await invoke(page, "paged.fillStroke.toggleAffects");
    await expect(button).not.toHaveAttribute("data-fs-affects", first ?? "");
    await invoke(page, "paged.fillStroke.toggleAffects");
    await expect(button).toHaveAttribute("data-fs-affects", first ?? "");
  });
});

test.describe("the derived command families, every live member", () => {
  test("paged.panel.show.* opens each panel and paged.panel.hide.* closes it", async ({
    page,
  }) => {
    covers("command:paged.panel.show.*", "command:paged.panel.hide.*");
    await openShell(page, { doc: true });
    const panels = await page.evaluate(() => {
      const r = (globalThis as unknown as G).__canvas.registries;
      const ids = new Set(r.commands.list().map((c) => c.id));
      return r.panels.list().map((p) => ({
        id: p.id,
        show: ids.has(`paged.panel.show.${p.id}`),
        hide: ids.has(`paged.panel.hide.${p.id}`),
      }));
    });
    expect(panels.length).toBeGreaterThan(60);
    // Every live panel has its pair.
    expect(panels.filter((p) => !p.show || !p.hide).map((p) => p.id)).toEqual(
      [],
    );
    const problems: string[] = [];
    for (const p of panels) {
      if (p.id === "paged.canvas") continue;
      await invoke(page, `paged.panel.show.${p.id}`);
      const opened = await expect
        .poll(() => openPanels(page), { timeout: 5_000 })
        .toContain(p.id)
        .then(
          () => true,
          () => false,
        );
      if (!opened) {
        problems.push(`show ${p.id}: not open`);
        continue;
      }
      await invoke(page, `paged.panel.hide.${p.id}`);
      const closed = await expect
        .poll(() => openPanels(page), { timeout: 5_000 })
        .not.toContain(p.id)
        .then(
          () => true,
          () => false,
        );
      if (!closed) problems.push(`hide ${p.id}: still open`);
    }
    expect(problems).toEqual([]);
  });

  test("paged.tool.activate.* arms each live tool", async ({ page }) => {
    covers("command:paged.tool.activate.*");
    await openShell(page, { doc: true });
    const ids = await page.evaluate(() =>
      (globalThis as unknown as G).__canvas.registries.commands
        .list()
        .map((c) => c.id)
        .filter((id) => id.startsWith("paged.tool.activate.")),
    );
    expect(ids.length).toBeGreaterThan(40);
    const base = () =>
      page.evaluate(
        () =>
          (globalThis as unknown as G).__canvas.debugContext()?.tools.base ??
          null,
      );
    const misses: string[] = [];
    for (const id of ids) {
      const tool = id.slice("paged.tool.activate.".length);
      await invoke(page, id);
      const ok = await expect
        .poll(base, { timeout: 5_000 })
        .toBe(tool)
        .then(
          () => true,
          () => false,
        );
      if (!ok) misses.push(`${tool}: base ${await base()}`);
    }
    expect(misses).toEqual([]);
  });
});
