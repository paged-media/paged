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

// PLUGIN SURFACE — paged.slide.
//
// The sibling of `web.spec.ts` and `sheet.spec.ts`, asking the same
// question of the PowerPoint plugin: does every id the resolved manifest
// promises exist in the host, and can a user REACH any of it?
//
//   `tests/journey/plugins/slide.journey.spec.ts` proves the workflow
//   (open a deck → a page per slide → export it back byte-identical; the
//   sorter's thumbnails, go-to, New slide, and the notes). It does not ask
//   whether the four property panels are registered and reachable, what
//   the exporter does without a deck, whether the typed commands answer,
//   or how a designer would find any of it.
//
// WHAT paged.slide REGISTERS, AND WHEN. Most of it is conditional; this
// file states each condition and the editor's answer to it:
//
//   · the importer — only when the host answers `contribute.importer@1`;
//   · the exporter — only when the host answers `contribute.exporter@1`
//     AND `storage.parts@1` (it reads the source deck back from a part);
//   · the Slides and Notes panels (React) — only when the host answers
//     `contribute.panel@1`, `render.snapshot@1` and `viewport.pages@1`.
//     They are RE-REGISTERED whenever the open document starts or stops
//     being a deck, because the panel rail reads `rail` at registration:
//     `rail: true` only while a deck is open;
//   · the object model (four kinds, four typed commands) — only when the
//     host answers `contribute.objectModel@1`;
//   · the four property panels (schema panels of property rows) — only
//     with the object model AND `contribute.schemaPanel@1`. The schema
//     panel for speaker notes is SKIPPED where the React Notes panel is
//     contributed: both use the id `media.paged.slide.panel.notes`, and
//     the React one wins.
//
//   · the palette commands (open and export a deck; new, duplicate, delete
//     and move the active slide) with a menu entry each — only when the
//     host answers `contribute.command@1`; the slide verbs also need the
//     page doors (`viewport.pages@1`) and Export needs `storage.parts@1`.
//
// The editor answers every one of those doors, so all of it is live here.
// paged.slide declares NO tool; its edit contexts are the deck's document
// context and a chart frame's data (with the chart object type, slide ADR
// 715). The audit test at the bottom pins that, and how its verbs are
// reached.

import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { Designer } from "../journey/driver/designer";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The manifest THE APP RESOLVES (apps/canvas/node_modules), not the
 *  module's source tree. */
const MANIFEST = JSON.parse(
  readFileSync(
    pathResolve(HERE, "../../node_modules/@paged-media/slide/manifest.json"),
    "utf8",
  ),
) as {
  id: string;
  name: string;
  contributes: {
    panels: string[];
    importers: string[];
    exporters: string[];
    partTypes: Array<{ type: string; role: string; format: string }>;
    objectModel: {
      kinds: Array<{ kind: string; title: string }>;
      commands: Array<{ id: string; title: string }>;
    };
    commands?: string[];
    tools?: unknown[];
    editContexts?: unknown[];
    objectTypes?: unknown[];
  };
};

/** The fixture deck the journey opens: ten 16:9 slides, nine layouts. */
const PPTX_FIXTURE = pathResolve(HERE, "../e2e/harness/slide-deck.pptx");
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const SLIDES_PANEL = "media.paged.slide.panel.slides";
const NOTES_PANEL = "media.paged.slide.panel.notes";
const SLIDE_PANEL = "media.paged.slide.panel.slide";
const TRANSITION_PANEL = "media.paged.slide.panel.transition";
const PLACEHOLDER_PANEL = "media.paged.slide.panel.placeholder";
const DECK_PANEL = "media.paged.slide.panel.deck";
const COMMENTS_PANEL = "media.paged.slide.panel.comments";
const IMPORTER = "media.paged.slide.importer.pptx";
const EXPORTER = "media.paged.slide.exporter.pptx";
const NEW_SLIDE = "media.paged.slide.newSlide";
const IMPORT_PPTX = "media.paged.slide.importPptx";
const DUPLICATE_SLIDE = "media.paged.slide.duplicateSlide";
const EXPORT_PPTX = "media.paged.slide.exportPptx";
const ADD_COMMENT = "media.paged.slide.command.addComment";
const REPLY_COMMENT = "media.paged.slide.command.replyComment";
const RESOLVE_COMMENT = "media.paged.slide.command.resolveComment";
const DELETE_COMMENT = "media.paged.slide.command.deleteComment";
const PREVIOUS_SLIDE = "media.paged.slide.command.previousSlide";
const NEXT_SLIDE = "media.paged.slide.command.nextSlide";

/** The palette commands and the menu entry onto each (the bundle's
 *  `src/menu.ts`, restated). */
const PALETTE = {
  "media.paged.slide.command.newSlide": "Slide/New slide",
  "media.paged.slide.command.duplicateSlide": "Slide/Duplicate slide",
  "media.paged.slide.command.deleteSlide": "Slide/Delete slide",
  "media.paged.slide.command.moveSlideUp": "Slide/Move slide up",
  "media.paged.slide.command.moveSlideDown": "Slide/Move slide down",
  "media.paged.slide.command.importPptx": "File/Open PowerPoint deck…",
  "media.paged.slide.command.exportPptx": "File/Export PowerPoint deck…",
  "media.paged.slide.command.previousSlide": "Slide/Previous slide",
  "media.paged.slide.command.nextSlide": "Slide/Next slide",
  "media.paged.slide.command.addComment": "Slide/New comment",
} as const;

/** The slide show's commands (slide ADR 716, `src/show/contribute.ts`):
 *  their titles and their menu entries. Offered only in a deck. */
const SHOW = {
  "media.paged.slide.command.slideShowFromBeginning": [
    "Slide show from the beginning",
    "Slide Show/From Beginning",
  ],
  "media.paged.slide.command.slideShowFromCurrent": [
    "Slide show from the current slide",
    "Slide Show/From Current Slide",
  ],
  "media.paged.slide.command.presenterView": [
    "Presenter view",
    "Slide Show/Presenter View",
  ],
  "media.paged.slide.command.rehearseTimings": [
    "Rehearse timings",
    "Slide Show/Rehearse Timings",
  ],
  "media.paged.slide.command.slideSorter": [
    "Slide sorter",
    "View/Slide Sorter",
  ],
} as const;

const KIND = (k: string) => `plugin:media.paged.slide/${k}`;

/** THE IDS, SPELLED OUT. Comparing the manifest to the registries proves
 *  they AGREE; it cannot prove either is complete, because a bundle that
 *  drops a panel from both sides still agrees with itself. This pinned
 *  list is the third party that notices, and it is what lets the
 *  surface-coverage gate (which matches literal id strings) see them. */
const DECLARED = {
  panels: [
    SLIDES_PANEL,
    NOTES_PANEL,
    SLIDE_PANEL,
    TRANSITION_PANEL,
    PLACEHOLDER_PANEL,
    DECK_PANEL,
    COMMENTS_PANEL,
  ],
  importers: [IMPORTER],
  exporters: [EXPORTER],
  partTypes: ["pptx", "slideImport", "chartWorkbook"],
  objectKinds: ["deck", "slide", "layout", "placeholder"],
  typedCommands: [
    NEW_SLIDE,
    IMPORT_PPTX,
    DUPLICATE_SLIDE,
    EXPORT_PPTX,
    ADD_COMMENT,
    REPLY_COMMENT,
    RESOLVE_COMMENT,
    DELETE_COMMENT,
    PREVIOUS_SLIDE,
    NEXT_SLIDE,
    // The slide show's typed twins carry their palette ids.
    ...Object.keys(SHOW),
  ],
  /** The deck's document context (editor ADR 307): no frame is entered;
   *  and a chart frame's data (slide ADR 715), entered by double-click. */
  editContexts: [
    { type: "slideDeck", entry: "doubleClick" },
    { type: "slideChart", entry: "doubleClick" },
  ],
  /** A chart frame claims its members' double-click (slide ADR 715). */
  objectTypes: [{ type: "slideChart", bakedFallback: "group" }],
  commands: [...Object.keys(PALETTE), ...Object.keys(SHOW)],
} as const;

/** Each panel's title, and what it is: the sorter, the notes and the
 *  comments are React panels; the other four are schema panels of property
 *  rows. */
const PANEL_TITLES: Record<string, string> = {
  [SLIDES_PANEL]: "Slides",
  [NOTES_PANEL]: "Notes",
  [SLIDE_PANEL]: "Slide",
  [TRANSITION_PANEL]: "Transition",
  [PLACEHOLDER_PANEL]: "Placeholder",
  [DECK_PANEL]: "Deck",
  [COMMENTS_PANEL]: "Comments",
};
const SCHEMA_PANELS = [
  SLIDE_PANEL,
  TRANSITION_PANEL,
  PLACEHOLDER_PANEL,
  DECK_PANEL,
] as const;

/** The property rows each schema panel shows, in order (the bundle's
 *  `SLIDE_PANEL_FIELDS`, restated). */
const PANEL_FIELDS: Record<(typeof SCHEMA_PANELS)[number], string[]> = {
  [SLIDE_PANEL]: ["index", "layout", "hidden"],
  [TRANSITION_PANEL]: [
    "transitionKind",
    "transitionDirection",
    "transitionSpeed",
    "transitionDuration",
    "advanceOnClick",
    "advanceAfter",
  ],
  [PLACEHOLDER_PANEL]: ["type", "index", "content"],
  [DECK_PANEL]: ["name", "slideWidth", "slideHeight", "slideCount", "fonts"],
};

interface Importer {
  id: string;
  title: string;
  extensions: string[];
  mimeTypes?: string[];
  import(f: {
    name: string;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<void>;
}

interface Exporter {
  id: string;
  title: string;
  extension: string;
  mimeType?: string;
  export(): Promise<{ bytes: Uint8Array; fileName: string } | null>;
}

interface CanvasGlobal {
  __canvas: {
    ready: boolean;
    handle: {
      pageCount: number;
      pageIds: string[];
      pageSizesPt: [number, number][];
    } | null;
    openPanel(id: string): void;
    registries: {
      commands: {
        list(): Array<{ id: string; title: string; category?: string }>;
        get(id: string): { id: string; title: string } | undefined;
        invoke(id: string, payload?: unknown): Promise<unknown>;
      };
      panels: {
        list(): Array<{
          id: string;
          title: string;
          rail?: boolean;
          source?: string;
          defaultDock?: string;
          iconSvg?: string;
        }>;
      };
      tools: { list(): Array<{ id: string }> };
      menus: {
        list(): Array<{ path: string; command: string; disabled?: boolean }>;
      };
      keybindings: {
        list(): Array<{
          key: string;
          command: string;
          scope?: { editContext: string };
        }>;
      };
      importers: {
        list(): Importer[];
        resolve(name: string, mime?: string): Importer | null;
        acceptExtensions(): string[];
      };
      exporters: { list(): Exporter[] };
      editContexts: { list(): Array<{ type: string; metadataKey?: string }> };
      objectTypes: { list(): Array<{ type: string; metadataKey?: string }> };
    };
    objects: {
      kinds(): Promise<Array<{ owner: string; kind: string; title: string }>>;
      commands(): Promise<Array<{ id: string; title: string; owner: string }>>;
      invoke(command: string, args: unknown): Promise<unknown>;
      query(selector: string): Promise<string[]>;
      get(
        address: string,
        path: string,
      ): Promise<{ kind: string; value?: unknown }>;
    } | null;
    client: {
      undo(): Promise<unknown>;
      executeScript(
        s: string,
      ): Promise<{ output: string[]; error: string | null }>;
    };
  };
}

const canvas = (page: Page) =>
  page.evaluate(() =>
    Boolean((globalThis as unknown as CanvasGlobal).__canvas),
  );

/** Boot and start a blank one-page document (File ▸ New): NOT a deck. */
async function bootBlank(page: Page): Promise<Designer> {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  expect(await canvas(page)).toBe(true);
  return designer;
}

/** Open the fixture deck through the host's importer registry (the path
 *  File ▸ Open and a drop take) and wait for its ten pages. */
async function openDeck(page: Page, designer: Designer): Promise<void> {
  const bytes = [...readFileSync(PPTX_FIXTURE)];
  const id = await page.evaluate(
    async ({ bytes, name }) => {
      const r = (globalThis as unknown as CanvasGlobal).__canvas.registries;
      const imp = r.importers.resolve(name);
      if (!imp) return "no importer resolved for .pptx";
      await imp.import({ name, bytes: new Uint8Array(bytes), mimeType: "" });
      return imp.id;
    },
    { bytes, name: "slide-deck.pptx" },
  );
  expect(id).toBe(IMPORTER);
  await expect
    .poll(async () => (await designer.handle()).pageCount, { timeout: 30_000 })
    .toBe(10);
}

const pageCount = async (designer: Designer) =>
  (await designer.handle()).pageCount;

const slidePanels = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.registries.panels
      .list()
      .filter((p) => p.id.startsWith("media.paged.slide."))
      .map((p) => ({
        id: p.id,
        title: p.title,
        rail: p.rail ?? false,
        source: p.source ?? null,
        defaultDock: p.defaultDock ?? null,
        iconSvg: Boolean(p.iconSvg),
      })),
  );

const railFlags = async (page: Page) =>
  Object.fromEntries(
    (await slidePanels(page))
      .filter((p) => p.id === SLIDES_PANEL || p.id === NOTES_PANEL)
      .map((p) => [p.id, p.rail]),
  );

async function openPanel(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (pid) => (globalThis as unknown as CanvasGlobal).__canvas.openPanel(pid),
    id,
  );
}

/** The property rows a schema panel renders right now. */
const fieldsOf = (page: Page, id: string) =>
  page
    .locator(`[data-schema-panel="${id}"] [data-property-field]`)
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-property-field")),
    );

/** The first text frame that carries paged.slide's placeholder metadata:
 *  the title placeholder of slide 1 in the fixture. */
async function firstPlaceholderFrame(
  page: Page,
): Promise<{ kind: string; id: string }> {
  const ref = await page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const r = await c.client.executeScript("paged.tree()");
    const tree = JSON.parse(r.output[0] ?? "[]") as unknown[];
    type Node = {
      id?: { kind: string; id: string } | null;
      children?: Node[];
      pluginMetadata?: Array<{ key: string; value: string }>;
    };
    let found: { kind: string; id: string } | null = null;
    const visit = (n: Node) => {
      if (found) return;
      if (
        n.id?.kind === "textFrame" &&
        n.pluginMetadata?.some((m) => m.key === "x-paged:media.paged.slide")
      ) {
        found = n.id;
      }
      for (const ch of n.children ?? []) visit(ch);
    };
    for (const root of tree as Node[]) visit(root);
    return found;
  });
  expect(ref, "the deck has a placeholder frame").not.toBeNull();
  return ref!;
}

test.describe("plugin surface · paged.slide", () => {
  // ── 1. THE MANIFEST IS A PROMISE ─────────────────────────────────

  test("every id the resolved manifest declares is registered in the host @feat:editor-shell.plugin-bundles @feat:plugin-slide.import-native @level:happy", async ({
    page,
  }) => {
    await bootBlank(page);

    const live = await page.evaluate(async () => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const r = c.registries;
      return {
        panels: r.panels.list().map((p) => p.id),
        importers: r.importers.list().map((i) => i.id),
        exporters: r.exporters.list().map((e) => e.id),
        commands: r.commands.list().map((x) => x.id),
        tools: r.tools.list().map((t) => t.id),
        editContexts: r.editContexts.list().map((e) => e.metadataKey ?? null),
        editContextTypes: r.editContexts.list().map((e) => e.type),
        objectTypes: r.objectTypes.list().map((o) => o.metadataKey ?? null),
        registryNames: Object.keys(r),
        kinds: c.objects
          ? (await c.objects.kinds())
              .filter((k) => k.owner === "media.paged.slide")
              .map((k) => ({ kind: k.kind, title: k.title }))
          : null,
        typed: c.objects
          ? (await c.objects.commands())
              .filter((k) => k.owner === "media.paged.slide")
              .map((k) => ({ id: k.id, title: k.title }))
          : null,
      };
    });

    const c = MANIFEST.contributes;
    expect(MANIFEST.id).toBe("media.paged.slide");
    // The manifest matches the pinned list — a contribution silently
    // added to or dropped from the bundle lands here first.
    expect([...c.panels].sort()).toEqual([...DECLARED.panels].sort());
    expect([...c.importers]).toEqual([...DECLARED.importers]);
    expect([...c.exporters]).toEqual([...DECLARED.exporters]);
    expect(c.objectModel.kinds.map((k) => k.kind)).toEqual([
      ...DECLARED.objectKinds,
    ]);
    expect(c.objectModel.commands.map((k) => k.id)).toEqual([
      ...DECLARED.typedCommands,
    ]);
    expect([...(c.commands ?? [])].sort()).toEqual(
      [...DECLARED.commands].sort(),
    );
    // …and declares nothing in the categories it does not use.
    expect(c.tools, "no tools are declared").toBeUndefined();
    expect(c.editContexts, "the deck's and the chart's contexts").toEqual([
      ...DECLARED.editContexts,
    ]);
    expect(c.objectTypes, "the chart frame").toEqual([...DECLARED.objectTypes]);

    for (const id of c.panels) expect(live.panels, `panel ${id}`).toContain(id);
    for (const id of c.importers)
      expect(live.importers, `importer ${id}`).toContain(id);
    for (const id of c.exporters)
      expect(live.exporters, `exporter ${id}`).toContain(id);
    // The registries hold every command it declared, and nothing else.
    expect(
      live.commands.filter((id) => id.startsWith("media.paged.slide.")).sort(),
    ).toEqual([...DECLARED.commands].sort());
    expect(
      live.tools.filter((id) => id.startsWith("media.paged.slide.")),
    ).toEqual([]);
    // The deck context is registered (it is entered by no double-click: a
    // deck holds it as its document context).
    expect(live.editContextTypes).toContain("slideDeck");
    expect(live.editContextTypes).toContain("slideChart");
    expect(live.objectTypes).toContain("x-paged:media.paged.slide");

    // The object model is live in the ONE shared object registry
    // (`host.objects`), with the manifest's titles.
    expect(
      live.kinds,
      "the editor wires a shared object registry",
    ).not.toBeNull();
    expect(live.kinds).toEqual(
      c.objectModel.kinds.map((k) => ({ kind: KIND(k.kind), title: k.title })),
    );
    expect(live.typed).toEqual(
      c.objectModel.commands.map((k) => ({ id: k.id, title: k.title })),
    );

    // Same void the doc, sheet and web manifests declare into: `partTypes`
    // has no registry on the host side. The bundle writes its parts through
    // `host.parts` all the same; the DECLARATION reaches nothing.
    expect(c.partTypes.map((p) => p.type)).toEqual([...DECLARED.partTypes]);
    expect(live.registryNames).not.toContain("partTypes");
    test.info().annotations.push({
      type: "surface-finding",
      description:
        "paged.slide declares partTypes 'pptx', 'slideImport' and 'chartWorkbook' but the host ships no partType " +
        "registry; the declaration is inert metadata the host never reads.",
    });
  });

  // ── 2. PANELS ────────────────────────────────────────────────────

  test("all seven panels mount, each behind its own Plugins ▸ Slide item @feat:plugin-platform.panel-registration @feat:editor-shell.plugin-bundles @level:happy", async ({
    page,
  }) => {
    await bootBlank(page);

    const panels = await slidePanels(page);
    expect(panels.map((p) => p.id).sort()).toEqual([...DECLARED.panels].sort());
    for (const p of panels) {
      expect(p.title, `${p.id} title`).toBe(PANEL_TITLES[p.id]);
      // Provenance is host-stamped from the manifest's display name.
      expect(p.source, `${p.id} provenance`).toBe(MANIFEST.name);
    }
    const byId = Object.fromEntries(panels.map((p) => [p.id, p]));
    expect(byId[SLIDES_PANEL].defaultDock).toBe("left");
    expect(byId[NOTES_PANEL].defaultDock).toBe("bottom");
    expect(byId[COMMENTS_PANEL].defaultDock).toBe("right");
    // The three React panels carry their own glyph for the panel rail.
    expect(byId[SLIDES_PANEL].iconSvg).toBe(true);
    expect(byId[NOTES_PANEL].iconSvg).toBe(true);
    expect(byId[COMMENTS_PANEL].iconSvg).toBe(true);
    for (const id of SCHEMA_PANELS)
      expect(byId[id].defaultDock, id).toBe("right");

    // Each panel has a show command and a Plugins ▸ Slide entry onto it.
    const menu = await page.evaluate(() => {
      const r = (globalThis as unknown as CanvasGlobal).__canvas.registries;
      return r.menus
        .list()
        .filter((m) =>
          m.command.startsWith("paged.panel.show.media.paged.slide."),
        )
        .map((m) => ({
          path: m.path,
          command: m.command,
          registered: Boolean(r.commands.get(m.command)),
        }));
    });
    expect(menu.map((m) => m.path).sort()).toEqual(
      DECLARED.panels.map((id) => `Plugins/Slide/${PANEL_TITLES[id]}`).sort(),
    );
    for (const m of menu)
      expect(m.registered, `${m.path} → ${m.command}`).toBe(true);

    // Every panel mounts its real body, even on a document that is not a
    // deck: the sorter and the notes work on any document's pages.
    await openPanel(page, SLIDES_PANEL);
    await expect(page.locator('[data-slides-panel="ready"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("[data-slides-panel] [data-slide]")).toHaveCount(
      1,
    );
    // The only slide cannot be deleted (the button says so by being
    // disabled, rather than deleting the document's last page).
    await expect(
      page
        .locator("[data-slides-panel] [data-slide]")
        .first()
        .getByTitle("Delete slide"),
    ).toBeDisabled();
    // No layouts outside a deck, so no New slide row.
    await expect(page.locator("[data-new-slide]")).toHaveCount(0);

    await openPanel(page, NOTES_PANEL);
    await expect(page.locator('[data-notes-panel="ready"]')).toContainText(
      "Slide 1",
      {
        timeout: 15_000,
      },
    );
    for (const id of SCHEMA_PANELS) {
      await openPanel(page, id);
      await expect(
        page.locator(`[data-schema-panel="${id}"]`),
        `${id} mounts`,
      ).toBeVisible({
        timeout: 15_000,
      });
    }
    // The Comments panel: outside a deck there is no slide to comment on.
    await openPanel(page, COMMENTS_PANEL);
    await expect(page.locator("[data-comments-panel]")).toBeVisible({
      timeout: 15_000,
    });

    // The real menu bar: Plugins ▸ Slide lists all seven, none greyed
    // (paged.slide has no edit context, so no context withholds them),
    // and picking one opens it.
    await page.keyboard.press("Escape");
    await page
      .locator('nav[aria-label="Main menu"]')
      .getByRole("menuitem", { name: "Plugins", exact: true })
      .click();
    await page.locator('[data-menu-submenu="Slide"]').hover();
    const sub = page.getByRole("menu").last();
    for (const id of DECLARED.panels) {
      const item = sub.getByRole("menuitem", {
        name: PANEL_TITLES[id],
        exact: true,
      });
      await expect(item, `Plugins ▸ Slide ▸ ${PANEL_TITLES[id]}`).toHaveCount(
        1,
      );
      await expect(item).not.toHaveAttribute("aria-disabled", "true");
    }
    await sub.getByRole("menuitem", { name: "Slides", exact: true }).click();
    await expect(page.locator('[data-slides-panel="ready"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Slides and Notes join the panel rail only while a deck is open, and leave it with the deck @feat:plugin-platform.panel-rail-door @feat:plugin-slide.slide-sorter @level:edge", async ({
    page,
  }) => {
    // The rail reads `rail` when a panel REGISTERS, so the bundle
    // re-registers both panels whenever the open document starts or stops
    // being a deck. This is the one lazily re-registered contribution in
    // paged.slide; the test drives the trigger both ways.
    const designer = await bootBlank(page);
    const railSlides = page.locator(`[data-panel-rail-item="${SLIDES_PANEL}"]`);
    const railNotes = page.locator(`[data-panel-rail-item="${NOTES_PANEL}"]`);

    expect(await railFlags(page)).toEqual({
      [SLIDES_PANEL]: false,
      [NOTES_PANEL]: false,
    });
    await expect(railSlides).toHaveCount(0);
    await expect(railNotes).toHaveCount(0);

    await openDeck(page, designer);
    await expect
      .poll(() => railFlags(page), { timeout: 15_000 })
      .toEqual({
        [SLIDES_PANEL]: true,
        [NOTES_PANEL]: true,
      });
    await expect(railSlides).toBeVisible({ timeout: 10_000 });
    await expect(railNotes).toBeVisible();
    // Re-registration keeps one registration per id (no duplicate panel).
    const ids = (await slidePanels(page)).map((p) => p.id);
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids.sort()).toEqual([...DECLARED.panels].sort());

    // A blank document is not a deck: both leave the rail again.
    await designer.newDocument();
    await expect
      .poll(() => railFlags(page), { timeout: 15_000 })
      .toEqual({
        [SLIDES_PANEL]: false,
        [NOTES_PANEL]: false,
      });
    await expect(railSlides).toHaveCount(0, { timeout: 10_000 });
    await expect(railNotes).toHaveCount(0);
  });

  test("the four property panels: an empty body outside a deck, the deck's fields once one is open @feat:scripting.property-readwrite @feat:plugin-slide.layouts @level:happy", async ({
    page,
  }) => {
    const designer = await bootBlank(page);

    // CHARACTERIZATION. Outside a deck every property panel renders an
    // EMPTY body: no rows, and no sentence saying why. The Slides and
    // Notes panels name their empty state ("No slides…", "No slide
    // selected."); these four show a blank tab. Change this assertion
    // when they grow an empty state.
    for (const id of SCHEMA_PANELS) {
      await openPanel(page, id);
      const panel = page.locator(`[data-schema-panel="${id}"]`);
      await expect(panel).toBeVisible({ timeout: 15_000 });
      expect(
        await fieldsOf(page, id),
        `${id} has no rows outside a deck`,
      ).toEqual([]);
      expect(
        ((await panel.textContent()) ?? "").trim(),
        `${id} says nothing`,
      ).toBe("");
    }
    test.info().annotations.push({
      type: "surface-finding",
      description:
        "paged.slide's Slide, Transition, Placeholder and Deck panels render an empty body with " +
        "no explanation outside a deck (and Slide / Transition / Placeholder also with nothing " +
        "selected in one); the Slides and Notes panels state their empty state.",
    });

    await openDeck(page, designer);

    // The deck panel addresses the deck itself, so it fills without a
    // selection, and its values are the deck's.
    await openPanel(page, DECK_PANEL);
    await expect
      .poll(() => fieldsOf(page, DECK_PANEL), { timeout: 15_000 })
      .toEqual(PANEL_FIELDS[DECK_PANEL]);
    const deck = await page.evaluate(async (deckKind) => {
      const o = (globalThis as unknown as CanvasGlobal).__canvas.objects!;
      const [address] = await o.query(deckKind);
      return {
        address,
        name: (await o.get(address, "name")).value,
        slideCount: (await o.get(address, "slideCount")).value,
      };
    }, KIND("deck"));
    expect(deck.address).toBe(`${KIND("deck")}/deck`);
    expect(deck.name).toBe("slide-deck");
    expect(deck.slideCount).toBe(10);

    // The slide, transition and placeholder panels address the SELECTION
    // (the slide the selected item sits on; the selected frame as a
    // placeholder): empty until something is selected…
    for (const id of [SLIDE_PANEL, TRANSITION_PANEL, PLACEHOLDER_PANEL]) {
      await openPanel(page, id);
      await expect(page.locator(`[data-schema-panel="${id}"]`)).toBeVisible({
        timeout: 15_000,
      });
      expect(
        await fieldsOf(page, id),
        `${id} is empty with nothing selected`,
      ).toEqual([]);
    }

    // …and fill once the title placeholder of slide 1 is selected.
    const frame = await firstPlaceholderFrame(page);
    await designer.selectElement(frame.kind, frame.id);
    for (const id of [
      SLIDE_PANEL,
      TRANSITION_PANEL,
      PLACEHOLDER_PANEL,
    ] as const) {
      await openPanel(page, id);
      await expect
        .poll(() => fieldsOf(page, id), {
          timeout: 15_000,
          message: `${id} rows`,
        })
        .toEqual(PANEL_FIELDS[id]);
    }

    // The schema panel for speaker notes is NOT contributed here: the
    // React Notes panel owns the id, so the bundle skips the fallback.
    await openPanel(page, NOTES_PANEL);
    await expect(page.locator('[data-notes-panel="ready"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator(`[data-schema-panel="${NOTES_PANEL}"]`),
    ).toHaveCount(0);
  });

  // ── 3. IMPORTER ──────────────────────────────────────────────────

  test("the .pptx importer is wired into the host open door and opens a deck as a page per slide @feat:plugin-platform.importer-exporter @feat:plugin-slide.import-native @level:happy", async ({
    page,
  }) => {
    const designer = await bootBlank(page);

    const wiring = await page.evaluate((mime) => {
      const r = (globalThis as unknown as CanvasGlobal).__canvas.registries;
      const entry = r.importers
        .list()
        .find((i) => i.id === "media.paged.slide.importer.pptx");
      const id = (name: string, m?: string) =>
        r.importers.resolve(name, m)?.id ?? null;
      return {
        entry: entry
          ? {
              title: entry.title,
              ext: entry.extensions,
              mime: entry.mimeTypes ?? [],
            }
          : null,
        pptx: id("deck.pptx"),
        upper: id("DECK.PPTX"),
        ppsx: id("show.ppsx"),
        potx: id("template.potx"),
        byMime: id("unknown", mime),
        // The legacy binary format is not claimed: it falls through to the
        // default loader rather than reaching an importer that cannot read it.
        ppt: id("old.ppt"),
        accept: r.importers.acceptExtensions(),
      };
    }, PPTX_MIME);
    expect(wiring.entry).toEqual({
      title: "PowerPoint presentation (.pptx)",
      ext: [".pptx", ".ppsx", ".potx"],
      mime: [PPTX_MIME],
    });
    expect(wiring.pptx).toBe(IMPORTER);
    expect(wiring.upper).toBe(IMPORTER);
    expect(wiring.ppsx).toBe(IMPORTER);
    expect(wiring.potx).toBe(IMPORTER);
    expect(wiring.byMime).toBe(IMPORTER);
    expect(wiring.ppt).toBeNull();
    for (const ext of [".pptx", ".ppsx", ".potx"])
      expect(wiring.accept).toContain(ext);

    // Drive it with real bytes. Unlike paged.web's importer this one
    // REPLACES the document: the deck becomes the open document, a page
    // per slide at the slide size.
    expect(await pageCount(designer)).toBe(1);
    await openDeck(page, designer);
    for (const [w, h] of (await designer.handle()).pageSizesPt) {
      expect(Math.round(w)).toBe(960);
      expect(Math.round(h)).toBe(540);
    }
    // The slides are addressable as objects, one per page.
    const slides = await page.evaluate(
      (k) => (globalThis as unknown as CanvasGlobal).__canvas.objects!.query(k),
      KIND("slide"),
    );
    expect(slides).toHaveLength(10);
  });

  // ── 4. EXPORTER ──────────────────────────────────────────────────

  test("the .pptx exporter refuses honestly without a deck and writes one after an open @feat:plugin-slide.pptx-export @feat:plugin-platform.importer-exporter @level:edge", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const designer = await bootBlank(page);

    const exportNow = () =>
      page.evaluate(async () => {
        const r = (globalThis as unknown as CanvasGlobal).__canvas.registries;
        const ex = r.exporters
          .list()
          .find((e) => e.id === "media.paged.slide.exporter.pptx");
        if (!ex) return "no exporter";
        const out = await ex.export();
        return out
          ? {
              fileName: out.fileName,
              length: out.bytes.length,
              head: Array.from(out.bytes.slice(0, 4)),
            }
          : null;
      });

    const entry = await page.evaluate(() => {
      const e = (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.exporters
        .list()
        .find((x) => x.id === "media.paged.slide.exporter.pptx");
      return e
        ? {
            title: e.title,
            extension: e.extension,
            mimeType: e.mimeType ?? null,
          }
        : null;
    });
    expect(entry).toEqual({
      title: "PowerPoint presentation (.pptx)",
      extension: ".pptx",
      mimeType: PPTX_MIME,
    });

    // A document that was not opened from a deck has no source deck to
    // write back from: the exporter answers null (nothing to export) and
    // says why on the diagnostics channel, rather than throwing or
    // inventing a deck.
    expect(await exportNow()).toBeNull();
    await expect
      .poll(
        () => errors.some((e) => /not opened from a PowerPoint deck/.test(e)),
        {
          timeout: 10_000,
        },
      )
      .toBe(true);

    // After an open it writes a deck (a zip). The bytes are the journey's
    // business (it proves an untouched deck exports byte-identical).
    await openDeck(page, designer);
    const out = await exportNow();
    expect(out).not.toBeNull();
    expect(out).not.toBe("no exporter");
    const ok = out as { fileName: string; length: number; head: number[] };
    expect(ok.head, "a zip local-file header").toEqual([
      0x50, 0x4b, 0x03, 0x04,
    ]);
    expect(ok.length).toBeGreaterThan(1000);

    // The file is named after the deck. In the editor the importer opens
    // the deck through `host.nativeDocument.open(idml)`, which takes no
    // name, so the document has none; the exporter then falls back to the
    // deck's own name (the document label's `deck.name`).
    const names = await page.evaluate(async (deckKind) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const o = c.objects!;
      const [address] = await o.query(deckKind);
      const meta =
        (await (
          c.client as unknown as {
            documentMeta(): Promise<{ documentName?: string }>;
          }
        ).documentMeta()) ?? {};
      return {
        deck: (await o.get(address, "name")).value,
        documentName: (meta.documentName ?? "").trim(),
      };
    }, KIND("deck"));
    expect(names.deck, "the deck knows its own name").toBe("slide-deck");
    expect(names.documentName, "the opened deck document has no name").toBe("");
    expect(ok.fileName, "so it exports under the deck's name").toBe(
      "slide-deck.pptx",
    );
  });

  // ── 5. THE SORTER'S VERBS ────────────────────────────────────────

  test("the sorter's Duplicate, Hide and Delete each land as one undo step @feat:plugin-slide.slide-sorter @level:happy", async ({
    page,
  }) => {
    const designer = await bootBlank(page);
    await openDeck(page, designer);
    await openPanel(page, SLIDES_PANEL);
    const panel = page.locator('[data-slides-panel="ready"]');
    await expect(panel.locator("[data-slide]")).toHaveCount(10, {
      timeout: 15_000,
    });
    const undo = () =>
      page.evaluate(() =>
        (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
      );

    // Duplicate slide 2: eleven slides, then undo → ten.
    await panel
      .locator("[data-slide]")
      .nth(1)
      .getByTitle("Duplicate slide")
      .click();
    await expect.poll(() => pageCount(designer), { timeout: 15_000 }).toBe(11);
    await expect(panel.locator("[data-slide]")).toHaveCount(11);
    await undo();
    await expect.poll(() => pageCount(designer), { timeout: 15_000 }).toBe(10);
    await expect(panel.locator("[data-slide]")).toHaveCount(10);

    // Hide slide 3 from the slideshow: the button presses, and the slide
    // object's `hidden` reads true; undo shows it again.
    const third = panel.locator("[data-slide]").nth(2);
    const pageId = await third.getAttribute("data-slide");
    expect(pageId).toBeTruthy();
    const hidden = () =>
      page.evaluate(
        async (address) =>
          (
            await (globalThis as unknown as CanvasGlobal).__canvas.objects!.get(
              address,
              "hidden",
            )
          ).value,
        `${KIND("slide")}/${pageId}`,
      );
    expect(await hidden()).toBe(false);
    await third.getByTitle("Hide from slideshow").click();
    await expect(third.getByTitle("Show in slideshow")).toHaveAttribute(
      "aria-pressed",
      "true",
      {
        timeout: 10_000,
      },
    );
    await expect.poll(hidden, { timeout: 10_000 }).toBe(true);
    await undo();
    await expect.poll(hidden, { timeout: 10_000 }).toBe(false);

    // Delete slide 10: nine slides, then undo → ten.
    await panel
      .locator("[data-slide]")
      .nth(9)
      .getByTitle("Delete slide")
      .click();
    await expect.poll(() => pageCount(designer), { timeout: 15_000 }).toBe(9);
    await undo();
    await expect.poll(() => pageCount(designer), { timeout: 15_000 }).toBe(10);
  });

  // ── 6. TYPED COMMANDS ────────────────────────────────────────────

  test("the typed commands answer through host.objects: New slide refuses outside a deck and appends inside one; Open a PowerPoint deck opens one @feat:plugin-slide.layouts @feat:plugin-slide.import-native @level:edge", async ({
    page,
  }) => {
    const designer = await bootBlank(page);
    const invoke = (command: string, args: unknown) =>
      page.evaluate(
        async ({ command, args }) => {
          try {
            const v = await (
              globalThis as unknown as CanvasGlobal
            ).__canvas.objects!.invoke(command, args);
            return { ok: true as const, value: v };
          } catch (err) {
            return { ok: false as const, error: String(err) };
          }
        },
        { command, args },
      );

    // Outside a deck New slide refuses, loudly, and adds nothing.
    const refused = await invoke(NEW_SLIDE, {});
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toMatch(/not a slide deck/);
    expect(await pageCount(designer)).toBe(1);

    // Open a PowerPoint deck — the typed form of the importer — opens it
    // and answers the slides it made.
    const bytes = [...readFileSync(PPTX_FIXTURE)];
    const opened = await page.evaluate(
      async ({ command, bytes }) => {
        const r = (await (
          globalThis as unknown as CanvasGlobal
        ).__canvas.objects!.invoke(command, {
          name: "slide-deck.pptx",
          bytes: new Uint8Array(bytes),
        })) as { slides: string[] };
        return r.slides;
      },
      { command: IMPORT_PPTX, bytes },
    );
    expect(opened).toHaveLength(10);
    for (const a of opened)
      expect(a).toMatch(/^plugin:media\.paged\.slide\/slide\//);
    await expect.poll(() => pageCount(designer), { timeout: 30_000 }).toBe(10);

    // A slide that does not exist is a typed refusal.
    const unknown = await invoke(NEW_SLIDE, {
      after: `${KIND("slide")}/no-such-page`,
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.error).toMatch(/unknownAddress/);
    expect(await pageCount(designer)).toBe(10);

    // Inside the deck New slide appends one slide and answers its address;
    // one undo takes it away.
    const made = await invoke(NEW_SLIDE, {});
    expect(made.ok, made.ok ? "" : made.error).toBe(true);
    expect((made.ok ? made.value : null) as { slide: string }).toEqual({
      slide: expect.stringMatching(/^plugin:media\.paged\.slide\/slide\//),
    });
    await expect.poll(() => pageCount(designer), { timeout: 15_000 }).toBe(11);
    await page.evaluate(() =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
    );
    await expect.poll(() => pageCount(designer), { timeout: 15_000 }).toBe(10);
  });

  // ── 7. AUDIT — is any of this REACHABLE? ─────────────────────────

  test("AUDIT — paged.slide's verbs are in the palette and the menu bar, offered where they apply; a key each, no tool @feat:editor-shell.plugin-bundles @level:edge", async ({
    page,
  }) => {
    const designer = await bootBlank(page);

    const reach = () =>
      page.evaluate(() => {
        const c = (globalThis as unknown as CanvasGlobal).__canvas;
        const r = c.registries;
        const mine = (s: string) => s.startsWith("media.paged.slide.");
        const panelShow = (s: string) =>
          s.startsWith("paged.panel.show.media.paged.slide.");
        // paged.slide's predicates read its own store, not the state.
        const applies = (id: string) => {
          const w = (r.commands.get(id) as { when?: unknown } | undefined)
            ?.when;
          return typeof w === "function"
            ? Boolean((w as (s: unknown) => boolean)(null))
            : true;
        };
        return {
          commands: r.commands
            .list()
            .filter((x) => mine(x.id))
            .map((x) => ({
              id: x.id,
              title: x.title,
              category: x.category ?? null,
              applies: applies(x.id),
            })),
          tools: r.tools
            .list()
            .map((t) => t.id)
            .filter(mine),
          keybindings: r.keybindings
            .list()
            .filter(
              (k) => (mine(k.command) || panelShow(k.command)) && !k.scope,
            )
            .map((k) => k.key),
          // The Normal-view keys, scoped to the deck (editor ADR 307).
          scopedKeys: r.keybindings
            .list()
            .filter((k) => mine(k.command) && k.scope)
            .map((k) => `${k.key}@${k.scope!.editContext}→${k.command}`),
          // Every other binding (the shell's, the app's, other bundles')
          // on a chord paged.slide binds unscoped (a scoped key outranks
          // the host's only inside a deck, so sharing a chord is the point).
          collisions: (() => {
            const all = r.keybindings.list();
            const slideKeys = new Set(
              all.filter((k) => mine(k.command) && !k.scope).map((k) => k.key),
            );
            return all
              .filter((k) => slideKeys.has(k.key) && !mine(k.command))
              .map((k) => `${k.key}→${k.command}`);
          })(),
          // Menu entries onto paged.slide that are NOT its panels' show items.
          verbItems: r.menus
            .list()
            .filter((m) => mine(m.command))
            .map((m) => ({ path: m.path, command: m.command })),
          pluginToolsTotal: r.tools
            .list()
            .filter((t) => t.id.startsWith("media.paged.")).length,
        };
      });

    const blank = await reach();
    // Ten palette commands, titled for a user, in their own drawer.
    expect(
      Object.fromEntries(blank.commands.map((x) => [x.id, x.title])),
    ).toEqual({
      "media.paged.slide.command.previousSlide": "Previous slide",
      "media.paged.slide.command.nextSlide": "Next slide",
      "media.paged.slide.command.addComment": "New comment",
      "media.paged.slide.command.newSlide": "New slide",
      "media.paged.slide.command.duplicateSlide": "Duplicate slide",
      "media.paged.slide.command.deleteSlide": "Delete slide",
      "media.paged.slide.command.moveSlideUp": "Move slide up",
      "media.paged.slide.command.moveSlideDown": "Move slide down",
      "media.paged.slide.command.importPptx": "Open PowerPoint deck…",
      "media.paged.slide.command.exportPptx": "Export PowerPoint deck…",
      ...Object.fromEntries(
        Object.entries(SHOW).map(([id, [title]]) => [id, title]),
      ),
    });
    for (const x of blank.commands)
      expect(x.category, `${x.id} category`).toBe("Slide");
    // A menu entry onto each.
    expect(
      Object.fromEntries(blank.verbItems.map((m) => [m.command, m.path])),
    ).toEqual({
      ...PALETTE,
      ...Object.fromEntries(
        Object.entries(SHOW).map(([id, [, path]]) => [id, path]),
      ),
    });
    // Outside a deck only Open is offered.
    expect(
      blank.commands.filter((x) => x.applies).map((x) => x.id),
      "a blank document offers only Open PowerPoint deck…",
    ).toEqual(["media.paged.slide.command.importPptx"]);

    expect(blank.tools, "paged.slide contributes no tool").toEqual([]);
    expect(
      blank.pluginToolsTotal,
      "the tool door works — other bundles use it",
    ).toBeGreaterThan(10);
    // A key for each slide verb (its Cmd chord and Ctrl twin), on chords
    // nothing else in the editor binds.
    await expect
      .poll(async () => (await reach()).keybindings.sort(), {
        timeout: 15_000,
      })
      .toEqual(
        [
          "alt+cmd+n",
          "alt+ctrl+n",
          "alt+shift+cmd+n",
          "alt+shift+ctrl+n",
          "alt+cmd+backspace",
          "alt+ctrl+backspace",
          "cmd+arrowup",
          "ctrl+arrowup",
          "cmd+arrowdown",
          "ctrl+arrowdown",
          // PowerPoint's slide show keys (slide ADR 716).
          "f5",
          "shift+f5",
          "alt+f5",
        ].sort(),
      );
    expect(
      (await reach()).collisions,
      "no other binding on a slide chord",
    ).toEqual([]);
    // PowerPoint's Normal-view keys, scoped to the deck's context.
    expect((await reach()).scopedKeys.sort()).toEqual(
      [
        "cmd+m@slideDeck→media.paged.slide.command.newSlide",
        "ctrl+m@slideDeck→media.paged.slide.command.newSlide",
        "cmd+d@slideDeck→media.paged.slide.command.duplicateSlide",
        "ctrl+d@slideDeck→media.paged.slide.command.duplicateSlide",
        "pageup@slideDeck→media.paged.slide.command.previousSlide",
        "pagedown@slideDeck→media.paged.slide.command.nextSlide",
      ].sort(),
    );
    await expect(page.locator('[data-tool-rail="ready"]')).toBeVisible();
    await expect(
      page.locator(
        '[data-tool-rail="ready"] [data-tool^="media.paged.slide."]',
      ),
    ).toHaveCount(0);

    // Through the real palette: "slide" finds Open in the Slide drawer and
    // not New slide, which needs a deck.
    const row = (id: string) => `[cmdk-item][data-value="${id}"]`;
    const search = async (text: string) => {
      await page.evaluate(() =>
        (
          globalThis as unknown as CanvasGlobal
        ).__canvas.registries.commands.invoke("paged.palette.toggle"),
      );
      const input = page.getByPlaceholder("Ask or search anything…");
      await expect(input).toBeVisible({ timeout: 10_000 });
      await input.fill(text);
    };
    await search("powerpoint");
    await expect(
      page.locator(row("media.paged.slide.command.importPptx")),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator(row("media.paged.slide.command.exportPptx")),
      "no deck to export",
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    // In a deck, on its first slide, the slide verbs are offered, except
    // Move slide up and Previous slide (no slide above the first).
    await openDeck(page, designer);
    await expect
      .poll(
        async () =>
          (await reach()).commands
            .filter((x) => x.applies)
            .map((x) => x.id)
            .sort(),
        { timeout: 15_000 },
      )
      .toEqual(
        [...Object.keys(PALETTE), ...Object.keys(SHOW)]
          .filter(
            (id) =>
              id !== "media.paged.slide.command.moveSlideUp" &&
              id !== "media.paged.slide.command.previousSlide",
          )
          .sort(),
      );
    await search("slide");
    await expect(
      page.locator(row("media.paged.slide.command.newSlide")),
    ).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");

    // The TYPED commands stay out of Edit ▸ Run command…, which lists core
    // commands only; their palette twins above are how a user runs them.
    await page.evaluate(() =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke("paged.core.runCommand"),
    );
    const picker = page.locator("[data-core-command-picker]");
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => picker.locator("option").count(), { timeout: 10_000 })
      .toBeGreaterThan(5);
    const offered = await picker.locator("option").allTextContents();
    expect(offered, "Run command… does not offer New slide").not.toContain(
      "New slide",
    );
    await page.keyboard.press("Escape");

    test.info().annotations.push({
      type: "surface-finding",
      description:
        "paged.slide's verbs are palette commands (category Slide) with a menu entry each: " +
        "File ▸ Open PowerPoint deck… and File ▸ Export PowerPoint deck…, and New, Duplicate, " +
        "Delete, Move up and Move down under Plugins ▸ Slide. Each is offered only where it " +
        "applies (a deck open, a slide active, a neighbour to pass). The typed commands stay " +
        "out of Edit ▸ Run command…, which lists core commands only. No tool, no keybinding.",
    });
  });
});
