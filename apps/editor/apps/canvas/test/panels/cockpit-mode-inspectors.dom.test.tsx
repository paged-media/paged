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

// The non-design modes' right inspectors (mode-inspectors.tsx):
//
//   paged.story-inspector   Content mode. An honest stub with one live
//                           number (the document's story count).
//   paged.output-readiness  Prepress mode. A PDF/X-4 checklist: live
//                           rows from the meta / fonts / links reads, one
//                           seam (bleed), and a verdict over the live rows.
//   paged.review-inspector  Review mode. An honest stub.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  OutputReadinessPanel,
  ReviewInspectorPanel,
  StoryInspectorPanel,
} from "../../src/panels/cockpit/mode-inspectors";
import { apply, richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  comingSoonTitles,
  enabledControls,
  linksDocument,
  pill,
} from "./support/cockpit";

afterEach(unmountAll);

/** key → [pass, detail] of every checklist row (`null` pass = seam). */
function checks(h: PanelHarness<unknown>) {
  const out: Record<string, { pass: string | null; detail: string }> = {};
  for (const row of h.root.querySelectorAll<HTMLElement>(
    "[data-readiness-row]",
  )) {
    out[row.getAttribute("data-readiness-row")!] = {
      pass: row.getAttribute("data-readiness-pass"),
      detail: row.lastElementChild?.textContent ?? "",
    };
  }
  return out;
}

describe("Story inspector", () => {
  test("an honest stub: the card, no control, nothing sent", async () => {
    covers("panel:paged.story-inspector");
    const h = await mountPanel(StoryInspectorPanel, {
      id: "paged.story-inspector",
      scene: richScene,
    });
    expect(comingSoonTitles(h.root)).toEqual(["Story status coming soon"]);
    const from = h.mark();
    await h.caret(h.scene.storyId, 2);
    expect(enabledControls(h.root)).toEqual([]);
    expect(h.mutations(from)).toEqual([]);
  });

  test("the story count is the document's, read at load", async () => {
    covers("panel:paged.story-inspector");
    // The load's stats (a document with no story).
    const h = await mountPanel(StoryInspectorPanel, {
      id: "paged.story-inspector",
      document: linksDocument(),
    });
    expect(h.root.textContent).toContain("0 stories");
  });

  test("no document: no count, the card", async () => {
    covers("panel:paged.story-inspector");
    const h = await mountPanel(StoryInspectorPanel, {
      id: "paged.story-inspector",
      document: "none",
    });
    expect(h.root.textContent).not.toMatch(/\d+ stories/);
    expect(comingSoonTitles(h.root)).toEqual(["Story status coming soon"]);
  });

  // The count comes from the stats the engine sends at load and in reply
  // to a content selection; an edit that adds a story sends none, so the
  // header keeps the load's number. Same root as PN-300 (Health).
  test.failing(
    "PN-304: the story count follows the document: two stories added read 2 stories",
    async () => {
      covers("panel:paged.story-inspector");
      const h = await mountPanel(StoryInspectorPanel, {
        id: "paged.story-inspector",
        scene: richScene,
      });
      expect(((await h.client.collection("stories")) as unknown[]).length).toBe(
        2,
      );
      expect(h.root.textContent).toContain("2 stories");
    },
  );
});

describe("Output readiness", () => {
  test("no document: every row is a seam and there is no verdict", async () => {
    covers("panel:paged.output-readiness");
    const h = await mountPanel(OutputReadinessPanel, {
      id: "paged.output-readiness",
      document: "none",
    });
    expect(pill(h.root, "readiness-x4")).toBeNull();
    expect(checks(h).cmyk).toEqual({ pass: null, detail: "soon" });
    expect(checks(h).bleed).toEqual({ pass: null, detail: "soon" });
  });

  test("a new document without a working CMYK profile: not ready, and says why", async () => {
    covers("panel:paged.output-readiness");
    const h = await mountPanel(OutputReadinessPanel, {
      id: "paged.output-readiness",
    });
    expect(checks(h)).toEqual({
      cmyk: { pass: "false", detail: "" },
      fonts: { pass: "true", detail: "ok" },
      links: { pass: "true", detail: "ok" },
      ppi: { pass: "true", detail: "ok" },
      bleed: { pass: null, detail: "soon" },
    });
    expect(pill(h.root, "readiness-x4")).toEqual({
      text: "Not ready",
      tone: "warn",
    });
  });

  test("missing and low-res links fail their rows with counts", async () => {
    covers("panel:paged.output-readiness");
    const h = await mountPanel(OutputReadinessPanel, {
      id: "paged.output-readiness",
      document: linksDocument(),
    });
    expect(checks(h).links).toEqual({ pass: "false", detail: "2 missing" });
    expect(checks(h).ppi).toEqual({ pass: "false", detail: "1 low-res" });
  });

  test("a placement with no recorded resolution is unknown, not ok", async () => {
    covers("panel:paged.output-readiness");
    const h = await mountPanel(OutputReadinessPanel, {
      id: "paged.output-readiness",
      scene: richScene,
    });
    // An image placed in the editor: the link resolves (ok), its PPI is
    // not recorded.
    await h.act(() =>
      apply(h.client, {
        op: "placeImage",
        args: { elementId: String(h.scene.rect.id), uri: "file:///p/x.jpg" },
      } as never),
    );
    expect(checks(h).ppi).toEqual({ pass: "unknown", detail: "1 unknown" });
  });

  test("a font the text names and the session lacks fails the fonts row, live", async () => {
    covers("panel:paged.output-readiness");
    const h = await mountPanel(OutputReadinessPanel, {
      id: "paged.output-readiness",
      scene: richScene,
    });
    expect(checks(h).fonts).toEqual({ pass: "true", detail: "ok" });
    await h.mutate({
      op: "set",
      args: {
        address: `storyRange:${h.scene.storyId}@0..5`,
        path: "characterFontFamily",
        value: { type: "text", value: "Courier" },
      },
    } as never);
    expect(checks(h).fonts).toEqual({ pass: "false", detail: "1 missing" });
  });

  test("the Color section folds, and the panel sends nothing", async () => {
    covers("panel:paged.output-readiness");
    const h = await mountPanel(OutputReadinessPanel, {
      id: "paged.output-readiness",
    });
    const from = h.mark();
    const color = enabledControls(h.root).find(
      (c) => c.textContent === "Color",
    )!;
    const words = "Profile, rendering intent and ink limits";
    expect(h.root.textContent).not.toContain(words);
    await h.click(color);
    expect(h.root.textContent).toContain(words);
    expect(h.mutations(from)).toEqual([]);
  });

  // UX audit F-39 (fixed, ADR 245): the Prepress checklist read "Bleed 3 mm"
  // while every length elsewhere was in points.
  test("PN-303 (UX F-39): the bleed row reads in the document's unit, not mm", async () => {
    covers("panel:paged.output-readiness");
    const h = await mountPanel(OutputReadinessPanel, {
      id: "paged.output-readiness",
    });
    const bleed = h.root.querySelector('[data-readiness-row="bleed"]')!;
    expect(bleed.textContent).not.toContain("mm");
  });
});

describe("Review inspector", () => {
  test("an honest stub on any document: the card, no control, nothing sent", async () => {
    covers("panel:paged.review-inspector");
    for (const document of ["none", "blank"] as const) {
      const h = await mountPanel(ReviewInspectorPanel, {
        id: "paged.review-inspector",
        document,
      });
      expect(comingSoonTitles(h.root)).toEqual(["Approvals coming soon"]);
      expect(h.root.textContent).toContain(
        "Approve, request changes and version compare land with the collaboration backend.",
      );
      expect(enabledControls(h.root)).toEqual([]);
      expect(h.mutations()).toEqual([]);
      h.unmount();
    }
  });
});
