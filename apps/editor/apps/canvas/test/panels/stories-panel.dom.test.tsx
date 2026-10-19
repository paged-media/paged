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

// Stories (paged.stories, Content mode's left panel): one row per story
// with its counts and an overset badge; a click puts the caret at the
// story's head, selects its first frame and fits the camera on it, and
// opens the story inspector (counts, overset, the Smart text reflow
// controls, two seams).

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { covers } from "@paged-media/test-kit";

import { StoriesPanel } from "../../src/panels/cockpit/stories-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  rows,
  structureIdml,
  STRUCTURE,
  withViewport,
} from "./support/structure";

afterEach(unmountAll);

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(StoriesPanel, { id: "paged.stories", document });

const storyRow = (root: Element) =>
  root.querySelector<HTMLButtonElement>(
    `[data-list-row="${STRUCTURE.story}"]`,
  )!;
const field = (root: Element, id: string) =>
  root.querySelector(`[data-story-field-value="${id}"]`)?.textContent ?? null;
const grow = (root: Element) =>
  root.querySelector<HTMLButtonElement>(
    '[data-toggle-switch="story-reflow-grow"]',
  )!;
const maxPages = (root: Element) =>
  root.querySelector<HTMLInputElement>(
    'input[aria-label="story-reflow-max-pages"]',
  )!;

/** An overset story: Inter registered (so text lays out) and a long run. */
async function oversetStory(): Promise<PanelHarness<undefined>> {
  const h = await mount(structureIdml({ font: "Inter" }));
  const inter = new Uint8Array(
    readFileSync(join(import.meta.dir, "../../public/fonts/Inter.ttf")),
  );
  await h.act(() => h.client.registerFont("Inter", inter));
  await h.mutate({
    op: "insertText",
    args: { storyId: STRUCTURE.story, offset: 0, text: "word ".repeat(800) },
  } as never);
  return h;
}

describe("Stories panel: states", () => {
  test("no document: no stories yet, a count of 0", async () => {
    covers("panel:paged.stories");
    const h = await mount("none");
    expect(h.root.textContent).toContain("No stories yet");
    expect(h.root.querySelector(".pg-mono-meta")?.textContent).toBe("0");
  });

  test("a story: its row and counts; no inspector until one is picked", async () => {
    covers("panel:paged.stories");
    const h = await mount();
    const [r] = rows(h.root);
    expect(r.primary).toBe("Story 1");
    expect(r.secondary?.startsWith("14 chars · 1 ¶")).toBe(true);
    expect(r.badge).toBeNull();
    expect(h.root.querySelector("[data-story-inspector]")).toBeNull();
    expect(h.root.querySelector("[data-stories-overset-summary]")).toBeNull();
  });

  test("an overset story: the badge and the summary line", async () => {
    covers("panel:paged.stories");
    const h = await oversetStory();
    expect(rows(h.root)[0].badge).toBe("overset");
    expect(
      h.root.querySelector("[data-stories-overset-summary]")?.textContent,
    ).toBe("1 overset story");
  });

  test("a caret in the story opens its inspector", async () => {
    covers("panel:paged.stories");
    const h = await mount();
    await h.caret(STRUCTURE.story, 4);
    expect(
      h.root
        .querySelector("[data-story-inspector]")
        ?.getAttribute("data-story-inspector"),
    ).toBe(STRUCTURE.story);
    expect(rows(h.root)[0].selected).toBe(true);
  });
});

describe("Stories panel: controls", () => {
  test("a row click: caret at the head, the first frame selected, the inspector open", async () => {
    covers("panel:paged.stories");
    const h = await mount();
    const from = h.mark();
    await h.click(storyRow(h.root));
    expect(h.sent("setSelection", from).map((m) => m.payload)).toEqual([
      { selection: { storyId: STRUCTURE.story, start: 0, end: 0 } },
    ]);
    expect(h.sent("setElementSelection", from).map((m) => m.payload)).toEqual([
      { ids: [STRUCTURE.textFrame], mode: "replace" },
    ]);
    expect(h.paged.selection.elementSelection).toEqual([STRUCTURE.textFrame]);
    expect(h.paged.contentSelection.contentSelection).toMatchObject({
      storyId: STRUCTURE.story,
      start: 0,
      end: 0,
    });
    expect(field(h.root, "story-self-id")).toBe(STRUCTURE.story);
    expect(field(h.root, "story-char-count")).toBe("14");
    expect(field(h.root, "story-para-count")).toBe("1");
    expect(field(h.root, "story-overset")).toBe("no");
    expect(
      h.root.querySelector('[data-status-pill="story-overset-status"]')
        ?.textContent,
    ).toBe("Fits");
    expect(h.mutations(from)).toEqual([]);
  });

  test("a row click fits the camera on the story's frame", async () => {
    covers("panel:paged.stories");
    const h = await mount();
    await withViewport(h, [800, 600]);
    const before = h.paged.camera.camera;
    await h.click(storyRow(h.root));
    for (let i = 0; i < 100 && h.paged.camera.camera === before; i++)
      await h.act(() => new Promise((r) => setTimeout(r, 10)));
    // The frame (72..300 x 72..200 pt) fits at most at 200 %.
    expect(h.paged.camera.camera.scale).toBeGreaterThan(0);
    expect(h.paged.camera.camera.scale).toBeLessThanOrEqual(2);
    expect(h.paged.camera.camera).not.toEqual(before);
  });

  test("the overset inspector says Overset", async () => {
    covers("panel:paged.stories");
    const h = await oversetStory();
    await h.click(storyRow(h.root));
    expect(field(h.root, "story-overset")).toBe("yes");
    const pill = h.root.querySelector(
      '[data-status-pill="story-overset-status"]',
    );
    expect(pill?.textContent).toBe("Overset");
    expect(pill?.getAttribute("data-tone")).toBe("error");
  });

  test("Add pages while overset: one setFlowGrowRule, and the pill turns on", async () => {
    covers("panel:paged.stories");
    const h = await mount();
    await h.click(storyRow(h.root));
    expect(grow(h.root).hasAttribute("data-mixed")).toBe(true);
    const from = h.mark();
    await h.click(grow(h.root));
    expect(h.mutations(from)).toEqual([
      {
        op: "setFlowGrowRule",
        args: { storyId: STRUCTURE.story, grow: true, maxPages: null },
      },
    ] as never);
    const stories = (await h.client.collection("stories")) as Array<{
      growRule: { grow: boolean } | null;
    }>;
    expect(stories[0].growRule?.grow).toBe(true);
    expect(grow(h.root).getAttribute("aria-checked")).toBe("true");
    expect(grow(h.root).hasAttribute("data-mixed")).toBe(false);
  });

  test("Max added pages: committing 3 turns the rule on with that cap", async () => {
    covers("panel:paged.stories");
    const h = await mount();
    await h.click(storyRow(h.root));
    const from = h.mark();
    await h.typeInto(maxPages(h.root), "3");
    expect(h.mutations(from)).toEqual([
      {
        op: "setFlowGrowRule",
        args: { storyId: STRUCTURE.story, grow: true, maxPages: 3 },
      },
    ] as never);
    const stories = (await h.client.collection("stories")) as Array<{
      growRule: { grow: boolean; maxPages: number | null } | null;
    }>;
    expect(stories[0].growRule).toMatchObject({ grow: true, maxPages: 3 });
    expect(grow(h.root).getAttribute("aria-checked")).toBe("true");
  });

  test("the two seams say what is not available", async () => {
    covers("panel:paged.stories");
    const h = await mount();
    await h.click(storyRow(h.root));
    for (const seam of ["story-seam-words", "story-seam-preview"])
      expect(
        h.root.querySelector(`[data-story-seam="${seam}"]`)?.textContent,
      ).toContain("not available yet");
  });
});

describe("Stories panel: findings", () => {
  // UX audit F-22: "Content mode's Stories list shows u240c3b". The row's
  // secondary line ends with the story's id.
  test.failing(
    "PN-110 (UX F-22): a story row shows no internal id",
    async () => {
      covers("panel:paged.stories");
      const h = await mount();
      expect(rows(h.root)[0].secondary).not.toContain(STRUCTURE.story);
    },
  );

  // The reflow controls say the rule cannot be read back and show
  // "unknown" (a mixed pill); the engine reports it as
  // StorySummary.growRule.
  test.failing(
    "PN-111: the reflow controls show the story's grow rule as the model holds it",
    async () => {
      covers("panel:paged.stories");
      const h = await mount();
      await h.mutate({
        op: "setFlowGrowRule",
        args: { storyId: STRUCTURE.story, grow: true, maxPages: 3 },
      } as never);
      await h.click(storyRow(h.root));
      expect(grow(h.root).hasAttribute("data-mixed")).toBe(false);
      expect(grow(h.root).getAttribute("aria-checked")).toBe("true");
      expect(maxPages(h.root).value).toBe("3");
    },
  );
});
