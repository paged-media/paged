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

// Document X-Ray and the Typography Debugger (editor ADRs 1233, 1234; the
// UX strategy's Concepts A and E; tasks PX1, PX2). The panels show the
// engine's facts — the same answer `client.explain` and
// `client.lineEvidence` give — for the X-Ray fixture; looking changes
// neither the model nor the history; a typography preview never mutates,
// and Apply is one undo step.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import {
  expectHistoryUnchanged,
  expectUndoSteps,
  undoDepth,
} from "./harness/history";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { clickMenuRow, select } from "./harness/shell-surface";
import { openXrayFixture, XRAY } from "./harness/xray-fixtures";

type Win = {
  __canvas: {
    client: {
      explain(
        item: unknown,
        o?: { aspect?: string; selection?: unknown },
      ): Promise<Record<string, unknown>>;
      lineEvidence(q: unknown): Promise<{
        lines: Array<Record<string, unknown>>;
        overset?: { characters: number } | null;
      }>;
    };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
    setContentSelection(sel: {
      storyId: string;
      start: number;
      end: number;
    }): void;
  };
};

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Win).__canvas.registries.commands.invoke(cmd),
    id,
  );

const caret = (page: Page, storyId: string, at: number) =>
  page.evaluate(
    ({ storyId: s, at: o }) =>
      (globalThis as unknown as Win).__canvas.setContentSelection({
        storyId: s,
        start: o,
        end: o,
      }),
    { storyId, at },
  );

/** The engine's answer for the caret at content offset `at`. */
const engineText = (page: Page, storyId: string, at: number) =>
  page.evaluate(
    async ({ storyId: s, at: o }) => {
      const x = await (globalThis as unknown as Win).__canvas.client.explain(
        { kind: "storyRange", id: { story_id: s, start: 0, end: 0 } },
        { selection: { storyId: s, start: o, end: o, affinity: false } },
      );
      return (
        x.text as {
          properties: Array<{
            property: string;
            source: { kind: string; style?: { name: string } };
          }>;
        }
      ).properties.map((p) => ({
        property: p.property,
        source:
          p.source.kind === "style"
            ? `style:${p.source.style!.name}`
            : p.source.kind,
      }));
    },
    { storyId, at },
  );

test.describe("Document X-Ray (editor ADR 1233)", () => {
  test("the Why? inspector shows the engine's cascade for the text at the caret; looking changes nothing @feat:editor-shell.panels.inspector @feat:styles.based-on-chain @feat:styles.cascade @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.xray");
    await openXrayFixture(page);
    await invoke(page, "paged.panel.show.paged.xray");
    const panel = page.locator("[data-xray-panel]");
    await expect(panel.locator("[data-xray-empty]")).toBeVisible();
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      // "Plain |" — Body sets the red, over Base's black.
      await caret(page, XRAY.text.story, 3);
      const fill = panel.locator('[data-xray-property="fillColor"]');
      await expect(fill).toHaveAttribute("data-xray-source", "style:Body");
      await expect(fill).toHaveAttribute("data-xray-value", "Red");
      await expect(
        panel.locator('[data-xray-chain-names="Body>Base"]'),
      ).toBeVisible();
      // Every row is the engine's.
      const facts = await engineText(page, XRAY.text.story, 3);
      for (const f of facts)
        await expect(
          panel.locator(`[data-xray-property="${f.property}"]`),
        ).toHaveAttribute("data-xray-source", f.source);
      // " b|ig" — a local 14 pt over Base's 10.
      await caret(page, XRAY.text.story, 12);
      const size = panel.locator('[data-xray-property="pointSize"]');
      await expect(size).toHaveAttribute("data-xray-source", "character");
      await expect(size).toHaveAttribute("data-xray-override", "true");
      await expect(size).toHaveAttribute("data-xray-value", "14 pt");
      // Editing Body changes its paragraph and Head's, on page 1.
      const deps = panel.locator('[data-xray-dependents="Body"]');
      await expect(deps).toHaveAttribute("data-xray-uses", "2");
      await expect(deps).toHaveAttribute("data-xray-pages", "1");
    });
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("a lock, a picture and a thread say why, and lead to where they change @feat:editor-shell.panels.inspector @feat:editor-shell.panels.links @feat:stories-text.overset @feat:layers.model @level:happy", async ({
    page,
  }) => {
    await openXrayFixture(page);
    await invoke(page, "paged.panel.show.paged.xray");
    const panel = page.locator("[data-xray-panel]");
    // The locked rectangle: its own lock; its fill from Box, down the chain.
    await select(page, [{ kind: "rectangle", id: XRAY.locked }]);
    await expect(panel.locator('[data-xray-lock="item"]')).toBeVisible();
    await expect(
      panel.locator('[data-xray-property="fillColor"]'),
    ).toHaveAttribute("data-xray-source", "style:Box");
    // Unlock is one undo step, and the answer follows.
    await expectUndoSteps(page, 1, () =>
      panel.locator("[data-xray-unlock]").click(),
    );
    await expect(panel.locator('[data-xray-lock="item"]')).toHaveCount(0);
    // On a locked layer: the layer is the reason.
    await select(page, [{ kind: "rectangle", id: XRAY.lockedLayer }]);
    await expect(panel.locator('[data-xray-lock="layer"]')).toContainText(
      XRAY.layerLock.name,
    );
    // The picture: missing, and another frame places the same file.
    const model = await modelSnapshot(page);
    await select(page, [{ kind: "rectangle", id: XRAY.pictures[0] }]);
    await expect(panel.locator("[data-xray-link-status]")).toHaveAttribute(
      "data-xray-link-status",
      "missing",
    );
    await expect(panel.locator("[data-xray-same-link]")).toHaveAttribute(
      "data-xray-same-link",
      "1",
    );
    // The thread's last frame: overset by the engine's count; Previous
    // frame goes to the first.
    await select(page, [{ kind: "textFrame", id: XRAY.thread.last }]);
    const engineOverset = await page.evaluate(async (id) => {
      const x = await (globalThis as unknown as Win).__canvas.client.explain({
        kind: "textFrame",
        id,
      });
      return (x.flow as { oversetCharacters: number }).oversetCharacters;
    }, XRAY.thread.last);
    expect(engineOverset).toBeGreaterThan(0);
    await expect(panel.locator("[data-xray-overset]")).toHaveAttribute(
      "data-xray-overset",
      String(engineOverset),
    );
    await expectHistoryUnchanged(page, () =>
      panel.locator("[data-xray-previous]").click(),
    );
    await expect
      .poll(async () => (await selectionSnapshot(page)).elements)
      .toEqual([{ kind: "textFrame", id: XRAY.thread.first }]);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("View ▸ X-Ray outlines every item by the style that shapes it @feat:editor-shell.panels.inspector @feat:styles.cascade @level:happy", async ({
    page,
  }) => {
    await openXrayFixture(page);
    const model = await modelSnapshot(page);
    covers("menu:View/X-Ray", "command:paged.view.toggleXray");
    await expectHistoryUnchanged(page, async () => {
      await clickMenuRow(page, "View/X-Ray");
      await expect(
        page.locator(`[data-xray-item="${XRAY.text.frame}"]`),
      ).toHaveAttribute("data-xray-key", "Body");
      await expect(
        page.locator(`[data-xray-item="${XRAY.locked}"]`),
      ).toHaveAttribute("data-xray-key", "BoxChild");
      await expect(
        page.locator(`[data-xray-item="${XRAY.locked}"]`),
      ).toHaveAttribute("data-xray-locked", "true");
      await expect(
        page.locator(`[data-xray-item="${XRAY.pictures[0]}"]`),
      ).toHaveAttribute("data-xray-key", "");
      await expect(
        page.locator('[data-xray-legend-key="BoxChild"]'),
      ).toHaveCount(1);
      await clickMenuRow(page, "View/X-Ray");
      await expect(page.locator("[data-xray-overlay]")).toHaveCount(0);
    });
    expect(await modelSnapshot(page)).toBe(model);
  });
});

test.describe("The Typography Debugger (editor ADR 1234)", () => {
  test("the panel and the canvas show the engine's lines; a preview never mutates; Apply is one undo step @feat:typography.knuth-plass @feat:typography.hyphenation @feat:typography.justification-spacing @level:happy", async ({
    page,
  }) => {
    covers(
      "panel:paged.typography",
      "menu:View/Typography debugger",
      "command:paged.view.toggleTypographyDebugger",
    );
    await openXrayFixture(page);
    await invoke(page, "paged.panel.show.paged.typography");
    const panel = page.locator("[data-typography-panel]");
    await caret(page, XRAY.justified.story, 2);
    const engine = await page.evaluate(
      (story) =>
        (globalThis as unknown as Win).__canvas.client.lineEvidence({ story }),
      XRAY.justified.story,
    );
    expect(engine.lines.length).toBeGreaterThan(3);
    await expect(panel.locator("[data-typography-lines]")).toHaveAttribute(
      "data-typography-lines",
      String(engine.lines.length),
    );
    // Each row is the engine's line: its tightness and its break.
    for (const l of engine.lines) {
      const row = panel.locator(
        `[data-typography-row="${l.paragraph}:${l.line}"]`,
      );
      await expect(row).toHaveAttribute("data-tightness", String(l.tightness));
      await expect(row).toHaveAttribute("data-break", String(l.breakKind));
    }
    // The first line: why it broke there.
    await panel.locator('[data-typography-row="0:0"]').click();
    await expect(panel.locator('[data-typography-why="0:0"]')).toBeVisible();
    // On the canvas.
    await clickMenuRow(page, "View/Typography debugger");
    await expect(page.locator("[data-typography-line]")).toHaveCount(
      engine.lines.length,
    );
    // A preview of tracking -40 composes a copy: the model and the undo
    // history stay as they were, and the lines on the canvas too.
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await panel.locator("[data-typography-value]").fill("-40");
    await expectHistoryUnchanged(page, async () => {
      await panel.locator("[data-typography-run]").click();
      await expect(
        panel.locator("[data-typography-preview-result]"),
      ).toBeVisible();
    });
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toEqual(depth);
    // Apply: one undo step, and the document's lines are the preview's.
    const previewed = await panel
      .locator("[data-typography-preview-result]")
      .getAttribute("data-typography-preview-result");
    await expectUndoSteps(page, 1, () =>
      panel.locator("[data-typography-apply]").click(),
    );
    await expect(panel.locator("[data-typography-lines]")).toHaveAttribute(
      "data-typography-lines",
      String(previewed),
    );
    expect(await modelSnapshot(page)).not.toBe(model);
  });
});
